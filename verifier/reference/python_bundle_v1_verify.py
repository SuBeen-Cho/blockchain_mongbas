#!/usr/bin/env python3
"""Independent Python/OpenSSL verifier for canonical Mongbas scalar-v1 bundles."""
import base64, hashlib, json, os, re, subprocess, sys, tempfile

P_HEX = ''.join(('FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD1','29024E088A67CC74020BBEA63B139B22514A08798E3404DD','EF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245','E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED','EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3D','C2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F','83655D23DCA3AD961C62F356208552BB9ED529077096966D','670C354E4ABC9804F1746C08CA18217C32905E462E36CE3B','E39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9','DE2BCBF6955817183995497CEA956AE515D2261898FA0510','15728E5A8AACAA68FFFFFFFFFFFFFFFF')).lower()
P, G, BASE = int(P_HEX, 16), 2, 10000
Q = (P - 1) // 2
HEX, HASH = re.compile(r'^(0|[1-9a-f][0-9a-f]*)$'), re.compile(r'^[0-9a-f]{64}$')

def fail(message): raise ValueError(message)
def exact(value, keys, label):
    if not isinstance(value, dict) or set(value) != set(keys): fail(f'{label}: unexpected or missing fields')
def canonical(value):
    if value is None: return 'null'
    if value is True: return 'true'
    if value is False: return 'false'
    if isinstance(value, str): return json.dumps(value, ensure_ascii=False, separators=(',', ':'))
    if isinstance(value, int) and not isinstance(value, bool):
        if abs(value) > 9007199254740991: fail('integer exceeds JavaScript safe range')
        return str(value)
    if isinstance(value, list): return '[' + ','.join(map(canonical, value)) + ']'
    if isinstance(value, dict): return '{' + ','.join(canonical(k)+':'+canonical(value[k]) for k in sorted(value)) + '}'
    fail('unsupported canonical JSON type')
def digest(value): return hashlib.sha256(value.encode() if isinstance(value, str) else value).hexdigest()
def integer(value, label, scalar=False, subgroup=False):
    if not isinstance(value, str) or not HEX.fullmatch(value): fail(f'{label}: non-canonical lowercase hex')
    number = int(value, 16)
    if scalar:
        if not 0 <= number < Q: fail(f'{label}: scalar out of range')
    elif not 1 < number < P: fail(f'{label}: group element out of range')
    if subgroup and pow(number, Q, P) != 1: fail(f'{label}: element not in subgroup')
    return number
def inverse(value):
    try: return pow(value, -1, P)
    except ValueError: fail('modular inverse does not exist')
def b64(value, label):
    try: decoded = base64.b64decode(value, validate=True)
    except Exception: fail(f'{label}: invalid base64')
    if not value or base64.b64encode(decoded).decode() != value: fail(f'{label}: non-canonical base64')
    return decoded

def ballot_leaf(ballot):
    return digest(canonical({'candidateCommitment':ballot['candidateCommitment'],'ciphertext':ballot['ciphertext'],'nullifierHash':ballot['nullifierHash'],'validityProof':ballot['validityProof']}))
def merkle_root(ballots):
    level = list(map(ballot_leaf, ballots))
    if not level: return digest('')
    while len(level) > 1: level = [digest(level[i] + (level[i+1] if i+1 < len(level) else level[i])) for i in range(0,len(level),2)]
    return level[0]

def verify_ballot(y, ballot, count):
    exact(ballot, ['nullifierHash','candidateCommitment','ciphertext','validityProof'], 'ballot')
    exact(ballot['ciphertext'], ['c1','c2'], 'ciphertext')
    exact(ballot['validityProof'], ['a1s','a2s','es','zs'], 'validityProof')
    c1, c2, proof = integer(ballot['ciphertext']['c1'],'c1',subgroup=True), integer(ballot['ciphertext']['c2'],'c2',subgroup=True), ballot['validityProof']
    if any(not isinstance(proof[n],list) or len(proof[n]) != count for n in ('a1s','a2s','es','zs')): fail('proof dimensions')
    challenge, commitments = 0, []
    for i in range(count):
        a1,a2 = integer(proof['a1s'][i],'a1',subgroup=True), integer(proof['a2s'][i],'a2',subgroup=True)
        e,z = integer(proof['es'][i],'e',scalar=True), integer(proof['zs'][i],'z',scalar=True)
        adjusted = c2 * inverse(pow(G, BASE ** i, P)) % P
        if pow(G,z,P) != a1*pow(c1,e,P)%P or pow(y,z,P) != a2*pow(adjusted,e,P)%P: fail('ballot proof equation')
        challenge, commitments = (challenge+e)%Q, commitments+[format(a1,'x'),format(a2,'x')]
    transcript = '|'.join([ballot['ciphertext']['c1'],ballot['ciphertext']['c2'],*commitments])
    if challenge != int(digest(transcript),16)%Q: fail('ballot Fiat-Shamir challenge')
    return c1,c2

def encoded_tally(results, candidates):
    total, place = 0, 1
    for candidate in candidates:
        value = results.get(candidate)
        if not isinstance(value,int) or isinstance(value,bool) or not 0 <= value < BASE: fail('invalid tally count')
        total, place = total + value*place, place*BASE
    return total
def verify_decryption(y, aggregate, results, candidates, proof):
    exact(proof,['nullifierHash','c1','c2','decryptedHash','a1','a2','e','z'],'decryptionProof')
    if proof['nullifierHash']!='HOMOMORPHIC_TALLY' or proof['c1']!=aggregate['c1'] or proof['c2']!=aggregate['c2']: fail('decryption binding')
    tally=encoded_tally(results,candidates)
    if proof['decryptedHash'] != digest(f'homomorphic_sum:{tally}'): fail('decrypted hash')
    c1,c2=integer(proof['c1'],'dec.c1',subgroup=True),integer(proof['c2'],'dec.c2',subgroup=True)
    a1,a2=integer(proof['a1'],'dec.a1',subgroup=True),integer(proof['a2'],'dec.a2',subgroup=True)
    e,z=integer(proof['e'],'dec.e',scalar=True),integer(proof['z'],'dec.z',scalar=True)
    shared=c2*inverse(pow(G,tally,P))%P
    transcript='|'.join(format(x,'x') for x in (G,y,c1,shared,a1,a2))
    if e != int(digest(transcript),16)%Q: fail('decryption Fiat-Shamir challenge')
    if pow(G,z,P)!=a1*pow(y,e,P)%P or pow(c1,z,P)!=a2*pow(shared,e,P)%P: fail('decryption proof equation')

def verify_ed25519(public_key, signature, payload):
    with tempfile.TemporaryDirectory(prefix='mongbas-v1-ref-') as directory:
        paths=[os.path.join(directory,n) for n in ('key.der','signature.bin','payload.bin')]
        for path,data in zip(paths,(public_key,signature,payload)):
            with open(path,'wb') as output: output.write(data)
        result=subprocess.run(['openssl','pkeyutl','-verify','-pubin','-inkey',paths[0],'-keyform','DER','-rawin','-in',paths[2],'-sigfile',paths[1]],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=False)
        return result.returncode == 0

def verify(bundle):
    exact(bundle,['schema','algorithms','configuration','provenance','publicKey','ballots','bulletinBoard','aggregateCiphertext','tally','decryptionProof','signatures'],'bundle')
    if bundle['schema']!='mongbas-election-bundle/v1': fail('only v1 supported')
    exact(bundle['algorithms'],['canonicalization','hash','signature','tally'],'algorithms')
    if bundle['algorithms'] != {'canonicalization':'mongbas-canonical-json-v1','hash':'sha-256','signature':'ed25519','tally':'mongbas-exp-elgamal-scalar-v1'}: fail('algorithm mismatch')
    config=bundle['configuration']; exact(config,['electionID','candidates','signatureThreshold','organizations'],'configuration')
    election,candidates=config['electionID'],config['candidates']
    if not isinstance(election,str) or not re.fullmatch(r'[A-Za-z0-9_.-]{1,256}',election): fail('election ID')
    if not isinstance(candidates,list) or len(candidates)<2 or any(not isinstance(x,str) or not x for x in candidates) or len(set(candidates))!=len(candidates): fail('candidates')
    threshold,orgs=config['signatureThreshold'],config['organizations']
    if not isinstance(threshold,int) or isinstance(threshold,bool) or not isinstance(orgs,list) or not 1<=threshold<=len(orgs): fail('signature configuration')
    keys={}
    for org in orgs:
        exact(org,['id','ed25519PublicKeyDer'],'organization')
        if not isinstance(org['id'],str) or not org['id'] or org['id'] in keys: fail('organization')
        keys[org['id']]=b64(org['ed25519PublicKeyDer'],'public key')
    exact(bundle['provenance'],['gitCommit','imageDigest','softwareVersion'],'provenance')
    if not re.fullmatch(r'[0-9a-f]{40}',bundle['provenance']['gitCommit']) or not re.fullmatch(r'sha256:[0-9a-f]{64}',bundle['provenance']['imageDigest']) or not isinstance(bundle['provenance']['softwareVersion'],str) or not bundle['provenance']['softwareVersion']: fail('provenance')
    exact(bundle['publicKey'],['p','g','y'],'publicKey')
    if bundle['publicKey']['p']!=P_HEX or bundle['publicKey']['g']!='2': fail('group')
    y=integer(bundle['publicKey']['y'],'publicKey.y',subgroup=True)
    ballots=bundle['ballots']
    if not isinstance(ballots,list) or not ballots: fail('empty ballots')
    seen=set(); aggregate1=aggregate2=1
    for ballot in ballots:
        nullifier=ballot.get('nullifierHash')
        if not isinstance(nullifier,str) or not HASH.fullmatch(nullifier) or nullifier in seen: fail('nullifier')
        seen.add(nullifier); ciphertext=ballot.get('ciphertext',{})
        if ballot.get('candidateCommitment')!=digest(f"{election}|{nullifier}|{ciphertext.get('c1')}:{ciphertext.get('c2')}"): fail('candidate commitment')
        c1,c2=verify_ballot(y,ballot,len(candidates)); aggregate1,aggregate2=aggregate1*c1%P,aggregate2*c2%P
    exact(bundle['aggregateCiphertext'],['c1','c2'],'aggregate')
    if bundle['aggregateCiphertext']!={'c1':format(aggregate1,'x'),'c2':format(aggregate2,'x')}: fail('aggregate mismatch')
    exact(bundle['tally'],['results','totalVotes'],'tally'); exact(bundle['tally']['results'],candidates,'results')
    if bundle['tally']['totalVotes']!=len(ballots) or sum(bundle['tally']['results'].values())!=len(ballots): fail('tally count')
    verify_decryption(y,bundle['aggregateCiphertext'],bundle['tally']['results'],candidates,bundle['decryptionProof'])
    exact(bundle['bulletinBoard'],['root','publishedAt'],'bulletinBoard')
    if not isinstance(bundle['bulletinBoard']['publishedAt'],int) or isinstance(bundle['bulletinBoard']['publishedAt'],bool) or bundle['bulletinBoard']['publishedAt']<0 or bundle['bulletinBoard']['root']!=merkle_root(ballots): fail('bulletin board')
    unsigned=dict(bundle); del unsigned['signatures']; payload=canonical(unsigned).encode()
    signatures=bundle['signatures']
    if not isinstance(signatures,list) or len(signatures)<threshold: fail('insufficient signatures')
    signed=set()
    for entry in signatures:
        exact(entry,['organizationID','signature'],'signature'); identity=entry['organizationID']
        if identity in signed or identity not in keys: fail('signer identity')
        signed.add(identity)
        if not verify_ed25519(keys[identity],b64(entry['signature'],'signature'),payload): fail('signature verification')
    return {'valid':True,'schema':bundle['schema'],'ballots':len(ballots),'validSignatures':len(signatures)}

def main():
    if len(sys.argv)!=2:
        print('usage: python_bundle_v1_verify.py BUNDLE',file=sys.stderr); return 2
    try:
        with open(sys.argv[1],'rb') as source: text=source.read().decode('utf-8')
        bundle=json.loads(text)
        if text.strip()!=canonical(bundle): fail('bundle serialization is not canonical')
        print(json.dumps(verify(bundle),sort_keys=True,separators=(',',':'))); return 0
    except Exception as error:
        print(f'invalid: {error}',file=sys.stderr); return 1
if __name__=='__main__': sys.exit(main())
