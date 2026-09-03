#!/usr/bin/env python3
"""Independent Python/OpenSSL verifier for Mongbas vector/audit bundle v4."""
import json, re, sys
import python_bundle_v1_verify as core
import python_bundle_v2_verify as threshold

def require_time(value,label):
    if not isinstance(value,int) or isinstance(value,bool) or value < 0: core.fail(f'{label}: invalid timestamp')
def artifact_hash(election,candidates,vector,proof):
    return core.digest(core.canonical({'schema':'mongbas-vector-audit-artifact/v1','electionID':election,'candidates':candidates,'encryptedCandidateVector':vector,'vectorBallotValidityProof':proof}))
def length_hash(fields):
    state=__import__('hashlib').sha256()
    for field in fields:
        data=field.encode(); state.update(format(len(data),'08x').encode()); state.update(data)
    return state.hexdigest()
def ciphertext(value,label):
    core.exact(value,['c1','c2'],label)
    return core.integer(value['c1'],label+'.c1',subgroup=True),core.integer(value['c2'],label+'.c2',subgroup=True)
def vector_merkle_root(ballots):
    level=[core.digest(core.canonical({'candidateCommitment':b['candidateCommitment'],'ciphertextVector':b['ciphertextVector'],'nullifierHash':b['nullifierHash'],'validityProof':b['validityProof']})) for b in ballots]
    while len(level)>1: level=[core.digest(level[i]+(level[i+1] if i+1<len(level) else level[i])) for i in range(0,len(level),2)]
    return level[0] if level else core.digest('')

def verify_vector_proof(y,vector,proof,count):
    if not isinstance(vector,list) or len(vector)!=count: core.fail('vector dimensions')
    core.exact(proof,['bitProofs','sumProof'],'vector proof')
    if not isinstance(proof['bitProofs'],list) or len(proof['bitProofs'])!=count: core.fail('bit proof dimensions')
    product1=product2=1
    for index,item in enumerate(vector):
        c1,c2=ciphertext(item,f'vector[{index}]'); branch_proof=proof['bitProofs'][index]
        core.exact(branch_proof,['a1s','a2s','es','zs'],'bit proof')
        if any(not isinstance(branch_proof[name],list) or len(branch_proof[name])!=2 for name in ('a1s','a2s','es','zs')): core.fail('bit proof dimensions')
        challenge=0; transcript=f'mongbas/vector-v3/bit/{index}|{core.G:x}|{y:x}|{c1:x}|{c2:x}'
        for branch,message in enumerate((1,core.G)):
            a1=core.integer(branch_proof['a1s'][branch],'bit.a1',subgroup=True); a2=core.integer(branch_proof['a2s'][branch],'bit.a2',subgroup=True)
            e=core.integer(branch_proof['es'][branch],'bit.e',scalar=True); z=core.integer(branch_proof['zs'][branch],'bit.z',scalar=True)
            adjusted=c2*core.inverse(message)%core.P
            if pow(core.G,z,core.P)!=a1*pow(c1,e,core.P)%core.P or pow(y,z,core.P)!=a2*pow(adjusted,e,core.P)%core.P: core.fail('bit proof equation')
            challenge=(challenge+e)%core.Q; transcript+=f'|{message:x}|{a1:x}|{a2:x}'
        if challenge!=int(core.digest(transcript),16)%core.Q: core.fail('bit Fiat-Shamir challenge')
        product1,product2=product1*c1%core.P,product2*c2%core.P
    sum_proof=proof['sumProof']; core.exact(sum_proof,['a1','a2','e','z'],'sum proof')
    a1=core.integer(sum_proof['a1'],'sum.a1',subgroup=True); a2=core.integer(sum_proof['a2'],'sum.a2',subgroup=True)
    e=core.integer(sum_proof['e'],'sum.e',scalar=True); z=core.integer(sum_proof['z'],'sum.z',scalar=True)
    adjusted=product2*core.inverse(core.G)%core.P
    transcript=f'mongbas/vector-v3/sum|{core.G:x}|{y:x}|{product1:x}|{adjusted:x}|{a1:x}|{a2:x}'
    if e!=int(core.digest(transcript),16)%core.Q or pow(core.G,z,core.P)!=a1*pow(product1,e,core.P)%core.P or pow(y,z,core.P)!=a2*pow(adjusted,e,core.P)%core.P: core.fail('one-hot sum proof')

def verify_partials(y,aggregates,results,candidates,shares,partials):
    if not isinstance(shares,list) or len(shares)!=3: core.fail('public share count')
    configured={}
    for share in shares:
        core.exact(share,['index','mspID','publicKeyY'],'public share'); index=share['index']
        if not isinstance(index,int) or isinstance(index,bool) or not 1<=index<=3 or index in configured or not isinstance(share['mspID'],str) or not share['mspID']: core.fail('public share metadata')
        core.integer(share['publicKeyY'],'public share group element',subgroup=True); configured[index]=share
    if not isinstance(partials,list) or not 2<=len(partials)<=3: core.fail('vector partial count')
    public_values={}; values=[{} for _ in candidates]
    for partial in partials:
        core.exact(partial,['index','mspID','publicKeyY','values','proofs'],'vector partial'); index=partial['index']; expected=configured.get(index)
        if index in public_values or expected is None or expected['mspID']!=partial['mspID'] or expected['publicKeyY']!=partial['publicKeyY']: core.fail('vector trustee binding')
        if not isinstance(partial['values'],list) or len(partial['values'])!=len(candidates) or not isinstance(partial['proofs'],list) or len(partial['proofs'])!=len(candidates): core.fail('vector partial dimensions')
        trustee_y=core.integer(partial['publicKeyY'],'partial.y',subgroup=True); public_values[index]=trustee_y
        for position in range(len(candidates)):
            value=core.integer(partial['values'][position],'partial value',subgroup=True); c1,_=ciphertext(aggregates[position],f'aggregate[{position}]'); proof=partial['proofs'][position]
            if not isinstance(proof,dict) or not {'c1','c2','a1','a2','e','z'}.issubset(proof): core.fail('partial proof fields')
            if proof['c1']!=aggregates[position]['c1'] or proof['c2']!=partial['values'][position]: core.fail('partial ciphertext binding')
            a1=core.integer(proof['a1'],'partial.a1',subgroup=True); a2=core.integer(proof['a2'],'partial.a2',subgroup=True)
            e=core.integer(proof['e'],'partial.e',scalar=True); z=core.integer(proof['z'],'partial.z',scalar=True)
            transcript='|'.join(format(x,'x') for x in (core.G,trustee_y,c1,value,a1,a2))
            if e!=int(core.digest(transcript),16)%core.Q or pow(core.G,z,core.P)!=a1*pow(trustee_y,e,core.P)%core.P or pow(c1,z,core.P)!=a2*pow(value,e,core.P)%core.P: core.fail('vector partial proof')
            values[position][index]=value
    if threshold.combine(public_values)!=y: core.fail('combined public key')
    for position,candidate in enumerate(candidates):
        _,c2=ciphertext(aggregates[position],f'aggregate[{position}]'); clear=c2*core.inverse(threshold.combine(values[position]))%core.P
        if clear!=pow(core.G,results[candidate],core.P): core.fail('vector threshold tally')

def verify_audit(bundle,y):
    election,candidates=bundle['configuration']['electionID'],bundle['configuration']['candidates']; receipts=bundle['vectorBallotReceipts']; disclosures=bundle['vectorAuditDisclosures']
    if not isinstance(receipts,list) or not isinstance(disclosures,list): core.fail('audit arrays')
    by_id={}
    for receipt in receipts:
        core.exact(receipt,['schema','ballotID','electionID','artifactHash','status','createdAt','createdTxID','terminalAt','terminalTxID'],'receipt')
        if receipt['schema']!='mongbas-vector-ballot-receipt/v1' or not core.HASH.fullmatch(receipt['ballotID']) or not core.HASH.fullmatch(receipt['artifactHash']) or receipt['electionID']!=election or receipt['status'] not in ('cast','audited') or receipt['ballotID'] in by_id: core.fail('receipt binding')
        require_time(receipt['createdAt'],'createdAt'); require_time(receipt['terminalAt'],'terminalAt')
        if not isinstance(receipt['createdTxID'],str) or not receipt['createdTxID'] or not isinstance(receipt['terminalTxID'],str) or not receipt['terminalTxID']: core.fail('receipt transaction')
        by_id[receipt['ballotID']]=receipt
    cast=set()
    for ballot in bundle['ballots']:
        prepared=ballot['preparedBallotID']
        if not core.HASH.fullmatch(prepared) or prepared in cast: core.fail('prepared ballot ID')
        cast.add(prepared); receipt=by_id.get(prepared); expected=artifact_hash(election,candidates,ballot['ciphertextVector'],ballot['validityProof'])
        if receipt is None or receipt['status']!='cast' or receipt['artifactHash']!=expected: core.fail('cast receipt')
    if sum(x['status']=='cast' for x in receipts)!=len(bundle['ballots']): core.fail('orphan cast receipt')
    disclosed=set()
    for disclosure in disclosures:
        core.exact(disclosure,['schema','ballotID','electionID','artifactHash','selectedIndex','clientNonce','randomness','encryptedCandidateVector','vectorBallotValidityProof','status','auditedAt','auditedTxID'],'disclosure')
        selected=disclosure['selectedIndex']
        if disclosure['schema']!='mongbas-vector-audit-disclosure/v1' or disclosure['status']!='audited' or disclosure['electionID']!=election or not core.HASH.fullmatch(disclosure['clientNonce']) or not isinstance(selected,int) or isinstance(selected,bool) or not 0<=selected<len(candidates) or disclosure['ballotID'] in disclosed: core.fail('disclosure binding')
        require_time(disclosure['auditedAt'],'auditedAt')
        if not isinstance(disclosure['auditedTxID'],str) or not disclosure['auditedTxID']: core.fail('disclosure transaction')
        vector,proof=disclosure['encryptedCandidateVector'],disclosure['vectorBallotValidityProof']; expected=artifact_hash(election,candidates,vector,proof); receipt=by_id.get(disclosure['ballotID'])
        if receipt is None or receipt['status']!='audited' or receipt['artifactHash']!=expected or disclosure['artifactHash']!=expected: core.fail('audited artifact')
        if disclosure['ballotID']!=length_hash(['mongbas/vector-aoc/v1',election,core.digest(disclosure['clientNonce']),expected]): core.fail('audit ballot ID')
        verify_vector_proof(y,vector,proof,len(candidates)); randomness=disclosure['randomness']
        if not isinstance(randomness,list) or len(randomness)!=len(candidates): core.fail('randomness dimensions')
        for index,item in enumerate(randomness):
            r=core.integer(item,'audit randomness',scalar=True)
            if r==0: core.fail('audit randomness zero')
            c1,c2=ciphertext(vector[index],f'audit vector[{index}]'); message=core.G if index==selected else 1
            if c1!=pow(core.G,r,core.P) or c2!=pow(y,r,core.P)*message%core.P: core.fail('audit re-encryption')
        disclosed.add(disclosure['ballotID'])
    if sum(x['status']=='audited' for x in receipts)!=len(disclosures): core.fail('audit count')

def verify(bundle, skip_signatures=False):
    core.exact(bundle,['schema','algorithms','configuration','provenance','publicKey','trusteePublicShares','ballots','bulletinBoard','aggregateCiphertextVector','tally','vectorPartialDecryptions','vectorBallotReceipts','vectorAuditDisclosures','signatures'],'bundle')
    if bundle['schema']!='mongbas-election-bundle/v4': core.fail('only v4 supported')
    core.exact(bundle['algorithms'],['canonicalization','hash','signature','tally'],'algorithms')
    if bundle['algorithms']!={'canonicalization':'mongbas-canonical-json-v1','hash':'sha-256','signature':'ed25519','tally':'mongbas-exp-elgamal-vector-threshold-v3'}: core.fail('algorithm mismatch')
    config=bundle['configuration']; core.exact(config,['electionID','candidates','signatureThreshold','organizations'],'configuration'); election,candidates=config['electionID'],config['candidates']
    if not isinstance(election,str) or not re.fullmatch(r'[A-Za-z0-9_.-]{1,256}',election) or not isinstance(candidates,list) or len(candidates)<2 or any(not isinstance(x,str) or not x for x in candidates) or len(set(candidates))!=len(candidates): core.fail('configuration')
    keys={}; threshold_count=config['signatureThreshold']; orgs=config['organizations']
    if not isinstance(threshold_count,int) or isinstance(threshold_count,bool) or not isinstance(orgs,list) or not 1<=threshold_count<=len(orgs): core.fail('signature configuration')
    for org in orgs:
        core.exact(org,['id','ed25519PublicKeyDer'],'organization')
        if not isinstance(org['id'],str) or not org['id'] or org['id'] in keys: core.fail('organization')
        keys[org['id']]=core.b64(org['ed25519PublicKeyDer'],'public key')
    core.exact(bundle['provenance'],['gitCommit','imageDigest','softwareVersion'],'provenance'); provenance=bundle['provenance']
    if not re.fullmatch(r'[0-9a-f]{40}',provenance['gitCommit']) or not re.fullmatch(r'sha256:[0-9a-f]{64}',provenance['imageDigest']) or not isinstance(provenance['softwareVersion'],str) or not provenance['softwareVersion']: core.fail('provenance')
    core.exact(bundle['publicKey'],['p','g','y'],'publicKey')
    if bundle['publicKey']['p']!=core.P_HEX or bundle['publicKey']['g']!='2': core.fail('group')
    y=core.integer(bundle['publicKey']['y'],'publicKey.y',subgroup=True); ballots=bundle['ballots']
    if not isinstance(ballots,list) or not ballots: core.fail('empty ballots')
    seen=set(); aggregates=[{'c1':1,'c2':1} for _ in candidates]
    for ballot in ballots:
        core.exact(ballot,['nullifierHash','preparedBallotID','candidateCommitment','ciphertextVector','validityProof'],'ballot'); nullifier=ballot['nullifierHash']
        if not core.HASH.fullmatch(nullifier) or nullifier in seen: core.fail('nullifier')
        seen.add(nullifier)
        if ballot['candidateCommitment']!=core.digest(f"{election}|{nullifier}|{json.dumps(ballot['ciphertextVector'],separators=(',',':'))}"): core.fail('candidate commitment')
        verify_vector_proof(y,ballot['ciphertextVector'],ballot['validityProof'],len(candidates))
        for index,item in enumerate(ballot['ciphertextVector']):
            c1,c2=ciphertext(item,f'ballot vector[{index}]'); aggregates[index]['c1']=aggregates[index]['c1']*c1%core.P; aggregates[index]['c2']=aggregates[index]['c2']*c2%core.P
    expected=[{'c1':format(x['c1'],'x'),'c2':format(x['c2'],'x')} for x in aggregates]
    if bundle['aggregateCiphertextVector']!=expected: core.fail('vector aggregate')
    core.exact(bundle['tally'],['results','totalVotes'],'tally'); core.exact(bundle['tally']['results'],candidates,'results')
    if bundle['tally']['totalVotes']!=len(ballots) or sum(bundle['tally']['results'].values())!=len(ballots): core.fail('tally count')
    verify_partials(y,bundle['aggregateCiphertextVector'],bundle['tally']['results'],candidates,bundle['trusteePublicShares'],bundle['vectorPartialDecryptions'])
    verify_audit(bundle,y); core.exact(bundle['bulletinBoard'],['root','publishedAt'],'bulletinBoard'); require_time(bundle['bulletinBoard']['publishedAt'],'publishedAt')
    if bundle['bulletinBoard']['root']!=vector_merkle_root(ballots): core.fail('bulletin root')
    signatures=bundle['signatures']
    if not skip_signatures:
        unsigned=dict(bundle); del unsigned['signatures']; payload=core.canonical(unsigned).encode()
        if not isinstance(signatures,list) or len(signatures)<threshold_count: core.fail('insufficient signatures')
        signed=set()
        for entry in signatures:
            core.exact(entry,['organizationID','signature'],'signature'); identity=entry['organizationID']
            if identity in signed or identity not in keys: core.fail('signer identity')
            signed.add(identity)
            if not core.verify_ed25519(keys[identity],core.b64(entry['signature'],'signature'),payload): core.fail('signature verification')
    return {'valid':True,'schema':bundle['schema'],'ballots':len(ballots),'validPartials':len(bundle['vectorPartialDecryptions']),'validSignatures':0 if skip_signatures else len(signatures),'auditDisclosures':len(bundle['vectorAuditDisclosures'])}

def main():
    if len(sys.argv)!=2: print('usage: python_bundle_v4_verify.py BUNDLE',file=sys.stderr); return 2
    try:
        with open(sys.argv[1],'rb') as source: text=source.read().decode(); bundle=json.loads(text)
        if text.strip()!=core.canonical(bundle): core.fail('bundle serialization is not canonical')
        print(json.dumps(verify(bundle),sort_keys=True,separators=(',',':'))); return 0
    except Exception as error: print(f'invalid: {error}',file=sys.stderr); return 1
if __name__=='__main__': sys.exit(main())
