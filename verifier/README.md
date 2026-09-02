# Mongbas standalone election verifier

This package verifies a canonical election bundle without connecting to the Mongbas backend, a Fabric peer, chaincode, or a state database. It uses only Node.js built-ins and has no runtime npm dependencies.

```bash
cd verifier
npm test
node bin/mongbas-verify.js path/to/canonical-election-bundle.json
```

An independently controlled observer can verify a signed bundle and append a
signed, hash-chained checkpoint without contacting Fabric or the backend:

```bash
node bin/mongbas-witness.js init-trust mac-observer /secure/witness-ed25519.pem witness-trust.json
node bin/mongbas-witness.js observe election-bundle.signed.json checkpoints.jsonl mac-observer /secure/witness-ed25519.pem
node bin/mongbas-witness.js verify checkpoints.jsonl witness-trust.json
node bin/mongbas-witness.js compare witness-trust.json observer-a.jsonl observer-b.jsonl
```

`init-trust` derives only the public Ed25519 key, creates the trust document
with mode `0600`, and refuses to overwrite an existing trust document.
`compare` verifies every supplied log and rejects two individually valid,
same-witness histories if they contain different signed checkpoints at the same
sequence. A shorter log that is an exact prefix of a longer log is accepted.

The trust document pins witness identities to Ed25519 public keys:

```json
{"schema":"mongbas-witness-trust/v1","witnesses":[{"id":"mac-observer","ed25519PublicKeyDer":"<base64-spki>"}]}
```

Checkpoint JSONL is canonical, signed and hash-chained. A changed, inserted or
reordered observed checkpoint is rejected. The witness private key stays on the
observer machine.

To build and sign an exported source without sending private keys to the server:

```bash
node bin/mongbas-bundle.js build election-bundle-source.json election-bundle.json
node bin/mongbas-bundle.js sign election-bundle.json ec /secure/ec-ed25519.pem election-bundle.ec.json
node bin/mongbas-bundle.js sign election-bundle.ec.json civil /secure/civil-ed25519.pem election-bundle.signed.json
node bin/mongbas-verify.js election-bundle.signed.json
```

The builder writes files with mode `0600`. Signing verifies that the private key matches the organization's public key declared in the bundle. Private keys are read locally and never included in output.

The process exits `0` only when every implemented check passes, `1` for an invalid bundle, and `2` for incorrect CLI usage.

## Implemented checks

- exact schema and algorithm identifiers;
- Mongbas canonical JSON v1 byte encoding;
- fixed RFC 3526 group-14 parameters and subgroup membership;
- unique ballot nullifiers and candidate commitments;
- every disjunctive Chaum–Pedersen ballot-validity proof, including Fiat–Shamir challenge recomputation;
- aggregate ciphertext recomputation from all ballots;
- tally count/range and total consistency;
- v1 aggregate decryption Chaum–Pedersen proof, or v2 trustee partial
  decryptions with trustee/MSP binding, Fiat–Shamir challenge recomputation,
  Lagrange combination, combined-public-key validation, and tally recovery;
- deterministic bulletin-board Merkle root;
- vector-v3 prepared-ballot receipts, exact cast artifact binding, and one-to-one cast receipt coverage;
- spoiled audit nonce commitment, one-hot proof, disclosed randomness and full ciphertext re-encryption;
- rejection of missing, duplicate or mutated cast receipts and audit disclosures;
- threshold of distinct Ed25519 organization signatures over the complete unsigned canonical bundle;
- downgrade, deletion, replacement, reordering, duplication and proof/signature mutation tests.

## Current protocol limitations

Bundle v4 verifies one-hot vector ballots and 2-of-3, per-candidate threshold
decryptions without reconstructing the complete election private key. This does
not yet make the deployment institutionally independent: key generation remains
dealer-assisted, and trustee secret shares currently reside in a shared Fabric
private-data collection. Production deployment still requires auditable DKG,
per-organization secret storage and administration, and independently controlled
bundle-signing keys.

Bundle v4 also carries terminal audit-or-cast receipts. A cast receipt is bound
to the exact ciphertext/proof artifact and `preparedBallotID`; an audited receipt
must have a matching public spoiled disclosure whose nonce, randomness, proof
and selected index independently reconstruct every ciphertext. Public receipt
identifiers do not contain the credential-bound nullifier, so a spoiled audit
cannot be linked to a later cast by recomputing its identifier. These checks do
not prove that the user actually chose to audit or that an uncompromised display
showed the intended candidate; usability and compromised-device risks remain.

The signed Merkle root detects changes to the exported ballot sequence, but the
repository now contains an independent checkpoint witness, but a same-host test
does not establish operational independence. A valid final bundle/checkpoint
also cannot prove that an operator withheld no ballot before the witness first
observed it. Deployment therefore needs a separately controlled Mac/host that
polls or receives periodic roots during the election, publishes its latest
checkpoint out of band, and retains the pinned witness key/log.

The verifier intentionally does not call `GetSecurityProperties` and does not accept a server-provided `isValid` flag as evidence.
