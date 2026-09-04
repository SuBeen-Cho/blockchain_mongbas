#!/usr/bin/env python3
"""Independent Python/OpenSSL verifier for Mongbas DKG vector bundle v5."""
import json, re, sys
import python_bundle_v1_verify as core
import python_bundle_v4_verify as vector

EXPECTED=['ElectionCommissionMSP','PartyObserverMSP','CivilSocietyMSP']
ED25519_PREFIX=bytes.fromhex('302a300506032b6570032100')
X25519_PREFIX=bytes.fromhex('302a300506032b656e032100')

def public_key(value,prefix,label):
    decoded=core.b64(value,label)
    if len(decoded)!=44 or not decoded.startswith(prefix): core.fail(f'{label}: unexpected SPKI algorithm')
    return decoded

def verify_dkg(bundle):
    ceremony=bundle['keyCeremony']; core.exact(ceremony,['mode','transcript','transcriptHash','approvals'],'keyCeremony')
    if ceremony['mode']!='dkg-v1': core.fail('DKG mode')
    transcript=ceremony['transcript']; core.exact(transcript,['schema','ceremonyID','threshold','totalTrustees','group','participants','contributions','publicShares','electionPublicKeyY','transcriptHash'],'DKG transcript')
    if transcript['schema']!='mongbas-feldman-dkg-transcript/v1' or transcript['threshold']!=2 or transcript['totalTrustees']!=3 or not isinstance(transcript['ceremonyID'],str) or not transcript['ceremonyID']: core.fail('DKG parameters')
    core.exact(transcript['group'],['p','g','q'],'DKG group')
    if transcript['group']!={'p':core.P_HEX,'g':'2','q':format(core.Q,'x')}: core.fail('DKG group mismatch')
    hash_input=dict(transcript); del hash_input['transcriptHash']; computed=core.digest(core.canonical(hash_input))
    if not core.HASH.fullmatch(ceremony['transcriptHash']) or transcript['transcriptHash']!=computed or ceremony['transcriptHash']!=computed: core.fail('DKG transcript hash')
    participants=transcript['participants']
    if not isinstance(participants,list) or len(participants)!=3: core.fail('DKG participant count')
    roster={}
    for participant in participants:
        core.exact(participant,['id','index','transportPublicKeyDer','signingPublicKeyDer'],'DKG participant')
        identity,index=participant['id'],participant['index']
        if not isinstance(identity,str) or not identity or identity in roster or not isinstance(index,int) or isinstance(index,bool) or not 1<=index<=3: core.fail('DKG participant metadata')
        public_key(participant['transportPublicKeyDer'],X25519_PREFIX,'DKG transport key'); public_key(participant['signingPublicKeyDer'],ED25519_PREFIX,'DKG signing key'); roster[identity]=participant
    if any(roster.get(identity,{}).get('index')!=index for index,identity in enumerate(EXPECTED,1)): core.fail('DKG MSP/index binding')
    if not isinstance(ceremony['approvals'],list) or len(ceremony['approvals'])!=3 or sorted(ceremony['approvals'])!=sorted(EXPECTED): core.fail('DKG approvals')
    contributions=transcript['contributions']
    if not isinstance(contributions,list) or len(contributions)!=3: core.fail('DKG contribution count')
    commitments={}
    for contribution in contributions:
        core.exact(contribution,['dealerID','commitments','contributionHash'],'DKG contribution'); dealer=contribution['dealerID']; core.exact(contribution['commitments'],['constant','linear'],'DKG commitments')
        if dealer not in roster or dealer in commitments or not isinstance(contribution['contributionHash'],str) or not core.HASH.fullmatch(contribution['contributionHash']): core.fail('DKG contribution metadata')
        commitments[dealer]=(core.integer(contribution['commitments']['constant'],'DKG constant',subgroup=True),core.integer(contribution['commitments']['linear'],'DKG linear',subgroup=True))
    election_y=1
    for identity in EXPECTED: election_y=election_y*commitments[identity][0]%core.P
    if transcript['electionPublicKeyY']!=format(election_y,'x') or bundle['publicKey']['y']!=transcript['electionPublicKeyY']: core.fail('DKG election key equation')
    published=transcript['publicShares']
    if not isinstance(published,list) or len(published)!=3 or not isinstance(bundle['trusteePublicShares'],list): core.fail('DKG public shares')
    for index,identity in enumerate(EXPECTED,1):
        matches=[item for item in published if item.get('trusteeIndex')==index]
        if len(matches)!=1: core.fail('DKG published share uniqueness')
        share=matches[0]; core.exact(share,['schema','ceremonyID','trusteeID','trusteeIndex','publicKeyY'],'DKG public share')
        if share['schema']!='mongbas-dkg-public-share/v1' or share['ceremonyID']!=transcript['ceremonyID'] or share['trusteeID']!=identity: core.fail('DKG public share binding')
        expected=1
        for dealer in EXPECTED: expected=expected*commitments[dealer][0]%core.P*pow(commitments[dealer][1],index,core.P)%core.P
        if core.integer(share['publicKeyY'],'DKG public share',subgroup=True)!=expected: core.fail('DKG public share equation')
        bundled=[item for item in bundle['trusteePublicShares'] if item.get('index')==index]
        if len(bundled)!=1 or bundled[0].get('mspID')!=identity or bundled[0].get('publicKeyY')!=share['publicKeyY']: core.fail('DKG bundled share binding')

def verify(bundle):
    expected=['schema','algorithms','configuration','provenance','publicKey','trusteePublicShares','keyCeremony','ballots','bulletinBoard','aggregateCiphertextVector','tally','vectorPartialDecryptions','vectorBallotReceipts','vectorAuditDisclosures','signatures']
    core.exact(bundle,expected,'bundle')
    if bundle['schema']!='mongbas-election-bundle/v5': core.fail('only v5 supported')
    verify_dkg(bundle)
    legacy=dict(bundle); del legacy['keyCeremony']; legacy['schema']='mongbas-election-bundle/v4'
    body=vector.verify(legacy,skip_signatures=True)
    config=bundle['configuration']; organizations={item['id']:core.b64(item['ed25519PublicKeyDer'],'organization key') for item in config['organizations']}; signatures=bundle['signatures']
    if not isinstance(signatures,list) or not config['signatureThreshold']<=len(signatures)<=vector.MAX_SIGNATURES: core.fail('signature limits')
    unsigned=dict(bundle); del unsigned['signatures']; payload=core.canonical(unsigned).encode(); seen=set()
    for entry in signatures:
        core.exact(entry,['organizationID','signature'],'signature'); identity=entry['organizationID']
        if identity in seen or identity not in organizations: core.fail('signer identity')
        seen.add(identity)
        if not core.verify_ed25519(organizations[identity],core.b64(entry['signature'],'signature'),payload): core.fail('signature verification')
    body.update({'schema':bundle['schema'],'validSignatures':len(signatures),'dkgParticipants':3}); return body

def main():
    if len(sys.argv)!=2: print('usage: python_bundle_v5_verify.py BUNDLE',file=sys.stderr); return 2
    try:
        text=core.read_bounded_regular(sys.argv[1]).decode(); bundle=json.loads(text)
        if text.strip()!=core.canonical(bundle): core.fail('bundle serialization is not canonical')
        print(json.dumps(verify(bundle),sort_keys=True,separators=(',',':'))); return 0
    except Exception as error: print(f'invalid: {error}',file=sys.stderr); return 1
if __name__=='__main__': sys.exit(main())
