#!/usr/bin/env python3
"""Independent Python/OpenSSL verifier for Mongbas threshold bundle v2."""
import json, re, sys
import python_bundle_v1_verify as core

def lagrange(index, indexes):
    numerator, denominator = 1, 1
    for other in indexes:
        if other != index:
            numerator = numerator * other % core.Q
            denominator = denominator * (other - index) % core.Q
    try: return numerator * pow(denominator, -1, core.Q) % core.Q
    except ValueError: core.fail('invalid trustee index set')

def combine(values):
    indexes = sorted(values)
    if len(indexes) < 2 or len(indexes) != len(set(indexes)): core.fail('insufficient unique trustees')
    result = 1
    for index in indexes: result = result * pow(values[index], lagrange(index, indexes), core.P) % core.P
    return result

def verify(bundle):
    core.exact(bundle,['schema','algorithms','configuration','provenance','publicKey','trusteePublicShares','ballots','bulletinBoard','aggregateCiphertext','tally','partialDecryptions','signatures'],'bundle')
    if bundle['schema'] != 'mongbas-election-bundle/v2': core.fail('only v2 supported')
    core.exact(bundle['algorithms'],['canonicalization','hash','signature','tally'],'algorithms')
    if bundle['algorithms'] != {'canonicalization':'mongbas-canonical-json-v1','hash':'sha-256','signature':'ed25519','tally':'mongbas-exp-elgamal-threshold-v2'}: core.fail('algorithm mismatch')
    config=bundle['configuration']; core.exact(config,['electionID','candidates','signatureThreshold','organizations'],'configuration')
    election,candidates=config['electionID'],config['candidates']
    if not isinstance(election,str) or not re.fullmatch(r'[A-Za-z0-9_.-]{1,256}',election): core.fail('election ID')
    if not isinstance(candidates,list) or len(candidates)<2 or any(not isinstance(x,str) or not x for x in candidates) or len(set(candidates))!=len(candidates): core.fail('candidates')
    threshold,orgs=config['signatureThreshold'],config['organizations']
    if not isinstance(threshold,int) or isinstance(threshold,bool) or not isinstance(orgs,list) or not 1<=threshold<=len(orgs): core.fail('signature configuration')
    keys={}
    for org in orgs:
        core.exact(org,['id','ed25519PublicKeyDer'],'organization')
        if not isinstance(org['id'],str) or not org['id'] or org['id'] in keys: core.fail('organization')
        keys[org['id']]=core.b64(org['ed25519PublicKeyDer'],'public key')
    core.exact(bundle['provenance'],['gitCommit','imageDigest','softwareVersion'],'provenance')
    provenance=bundle['provenance']
    if not re.fullmatch(r'[0-9a-f]{40}',provenance['gitCommit']) or not re.fullmatch(r'sha256:[0-9a-f]{64}',provenance['imageDigest']) or not isinstance(provenance['softwareVersion'],str) or not provenance['softwareVersion']: core.fail('provenance')
    core.exact(bundle['publicKey'],['p','g','y'],'publicKey')
    if bundle['publicKey']['p']!=core.P_HEX or bundle['publicKey']['g']!='2': core.fail('group')
    y=core.integer(bundle['publicKey']['y'],'publicKey.y',subgroup=True)
    ballots=bundle['ballots']
    if not isinstance(ballots,list) or not ballots: core.fail('empty ballots')
    seen=set(); aggregate1=aggregate2=1
    for ballot in ballots:
        nullifier=ballot.get('nullifierHash')
        if not isinstance(nullifier,str) or not core.HASH.fullmatch(nullifier) or nullifier in seen: core.fail('nullifier')
        seen.add(nullifier); ciphertext=ballot.get('ciphertext',{})
        if ballot.get('candidateCommitment')!=core.digest(f"{election}|{nullifier}|{ciphertext.get('c1')}:{ciphertext.get('c2')}"): core.fail('candidate commitment')
        c1,c2=core.verify_ballot(y,ballot,len(candidates)); aggregate1,aggregate2=aggregate1*c1%core.P,aggregate2*c2%core.P
    core.exact(bundle['aggregateCiphertext'],['c1','c2'],'aggregate')
    aggregate=bundle['aggregateCiphertext']
    if aggregate != {'c1':format(aggregate1,'x'),'c2':format(aggregate2,'x')}: core.fail('aggregate mismatch')
    core.exact(bundle['tally'],['results','totalVotes'],'tally'); core.exact(bundle['tally']['results'],candidates,'results')
    if bundle['tally']['totalVotes']!=len(ballots) or sum(bundle['tally']['results'].values())!=len(ballots): core.fail('tally count')
    shares=bundle['trusteePublicShares']
    if not isinstance(shares,list) or len(shares)!=3: core.fail('expected three public shares')
    configured={}
    for share in shares:
        core.exact(share,['index','mspID','publicKeyY'],'public share'); index=share['index']
        if not isinstance(index,int) or isinstance(index,bool) or not 1<=index<=3 or index in configured or not isinstance(share['mspID'],str) or not share['mspID']: core.fail('public share metadata')
        core.integer(share['publicKeyY'],'public share group element',subgroup=True)
        configured[index]=share
    partials=bundle['partialDecryptions']
    if not isinstance(partials,list) or not 2<=len(partials)<=3: core.fail('partial count')
    public_values,values={},{}
    c1=core.integer(aggregate['c1'],'aggregate.c1',subgroup=True)
    for partial in partials:
        core.exact(partial,['index','mspID','publicKeyY','value','proof'],'partial'); index=partial['index']
        expected=configured.get(index)
        if index in values or expected is None or expected['mspID']!=partial['mspID'] or expected['publicKeyY']!=partial['publicKeyY']: core.fail('trustee binding')
        trustee_y=core.integer(partial['publicKeyY'],'partial.y',subgroup=True); value=core.integer(partial['value'],'partial.value',subgroup=True)
        proof=partial['proof']
        if not isinstance(proof,dict) or not {'c1','c2','a1','a2','e','z'}.issubset(proof): core.fail('partial proof fields')
        if proof['c1']!=aggregate['c1'] or proof['c2']!=partial['value']: core.fail('partial ciphertext binding')
        a1,a2=core.integer(proof['a1'],'partial.a1',subgroup=True),core.integer(proof['a2'],'partial.a2',subgroup=True)
        e,z=core.integer(proof['e'],'partial.e',scalar=True),core.integer(proof['z'],'partial.z',scalar=True)
        transcript='|'.join(format(x,'x') for x in (core.G,trustee_y,c1,value,a1,a2))
        if e!=int(core.digest(transcript),16)%core.Q: core.fail('partial Fiat-Shamir challenge')
        if pow(core.G,z,core.P)!=a1*pow(trustee_y,e,core.P)%core.P or pow(c1,z,core.P)!=a2*pow(value,e,core.P)%core.P: core.fail('partial proof equation')
        public_values[index],values[index]=trustee_y,value
    if combine(public_values)!=y: core.fail('combined public key')
    combined=combine(values); actual=core.integer(aggregate['c2'],'aggregate.c2',subgroup=True)*core.inverse(combined)%core.P
    if actual != pow(core.G,core.encoded_tally(bundle['tally']['results'],candidates),core.P): core.fail('threshold tally')
    core.exact(bundle['bulletinBoard'],['root','publishedAt'],'bulletinBoard')
    if not isinstance(bundle['bulletinBoard']['publishedAt'],int) or isinstance(bundle['bulletinBoard']['publishedAt'],bool) or bundle['bulletinBoard']['publishedAt']<0 or bundle['bulletinBoard']['root']!=core.merkle_root(ballots): core.fail('bulletin board')
    unsigned=dict(bundle); del unsigned['signatures']; payload=core.canonical(unsigned).encode(); signatures=bundle['signatures']
    if not isinstance(signatures,list) or len(signatures)<threshold: core.fail('insufficient signatures')
    signed=set()
    for entry in signatures:
        core.exact(entry,['organizationID','signature'],'signature'); identity=entry['organizationID']
        if identity in signed or identity not in keys: core.fail('signer identity')
        signed.add(identity)
        if not core.verify_ed25519(keys[identity],core.b64(entry['signature'],'signature'),payload): core.fail('signature verification')
    return {'valid':True,'schema':bundle['schema'],'ballots':len(ballots),'validSignatures':len(signatures),'validPartials':len(partials)}

def main():
    if len(sys.argv)!=2: print('usage: python_bundle_v2_verify.py BUNDLE',file=sys.stderr); return 2
    try:
        text=core.read_bounded_regular(sys.argv[1]).decode()
        bundle=json.loads(text)
        if text.strip()!=core.canonical(bundle): core.fail('bundle serialization is not canonical')
        print(json.dumps(verify(bundle),sort_keys=True,separators=(',',':'))); return 0
    except Exception as error: print(f'invalid: {error}',file=sys.stderr); return 1
if __name__=='__main__': sys.exit(main())
