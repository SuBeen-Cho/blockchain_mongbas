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
node bin/mongbas-witness.js verify-bundle election-bundle.signed.json checkpoints.jsonl witness-trust.json 1
node bin/mongbas-witness.js compare witness-trust.json observer-a.jsonl observer-b.jsonl
```

`init-trust` derives only the public Ed25519 key, creates the trust document
with mode `0600`, and refuses to overwrite an existing trust document.
`compare` verifies every supplied log and rejects two individually valid,
same-witness histories if they contain different signed checkpoints at the same
sequence. A shorter log that is an exact prefix of a longer log is accepted.
Witness private-key inputs must be regular, non-symlink files with no group or
other permission bits. Checkpoint logs are opened without following symlinks,
forced to mode `0600`, fsynced after append, and bounded to 16 MiB; trust files
are bounded to 1 MiB and bundle inputs to 256 MiB. These are local CLI resource
and file-substitution guards, not a replacement for host-level key custody.

The trust document pins witness identities to Ed25519 public keys:

```json
{"schema":"mongbas-witness-trust/v1","witnesses":[{"id":"mac-observer","ed25519PublicKeyDer":"<base64-spki>"}]}
```

Checkpoint JSONL is canonical, signed and hash-chained. A changed, inserted or
reordered observed checkpoint is rejected. The witness private key stays on the
observer machine.

New logs use checkpoint v2. In addition to the signed checkpoint hash chain,
v2 commits the complete canonical ballot objects in a separate, election-bound
history tree and verifies an old-to-new prefix consistency proof. The tree uses
the Merkle Tree Hash and consistency-proof construction from RFC 9162: raw
32-byte commitments, `0x00` leaf separation, `0x01` node separation, and the
largest-power-of-two split. It is a Mongbas JSON protocol, not an RFC 9162/CT
implementation or wire-compatible transparency log. `verify-bundle` is needed
to recompute that a particular archived bundle matches the signed v2 history;
log-only verification authenticates the witness assertion and its consistency
chain but cannot recreate omitted source data.

Existing checkpoint-v1 logs remain verifiable. They must be upgraded with an
explicit, one-way migration before another observation:

```bash
node bin/mongbas-witness.js migrate-history election-bundle.signed.json checkpoints.jsonl mac-observer /secure/witness-ed25519.pem
```

The first v2 entry starts consistency coverage at its own sequence; it does not
retroactively prove the v1-to-v2 boundary. A subsequent v2-to-v1 downgrade,
tree shrink, changed witness/election/context, inconsistent root advance, or
timestamp rollback is rejected.

`reference/python_history_vectors.py` is a separately structured Python
standard-library implementation used by the test suite to cross-check fixed
context hashes, full-ballot commitments, tree roots, and every consistency path
for sizes zero through eight. It does not import or invoke the Node history
implementation and is not a second full election verifier. Running the complete
development test suite therefore requires `python3`; verifier runtime commands
continue to require only Node.js built-ins.

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
- v5 DKG transcript canonical hash, fixed roster/MSP approvals, Feldman election-key equation, every trustee public-share equation, and exact bundle-share binding;
- threshold of distinct Ed25519 organization signatures over the complete unsigned canonical bundle;
- downgrade, deletion, replacement, reordering, duplication and proof/signature mutation tests.

## Current protocol limitations

Bundle v5 adds the public transcript and the three MSP approvals for DKG-backed
elections. The verifier recomputes the transcript hash, election public key and
all trustee public shares directly from Feldman commitments. This removes the
dealer-assisted key-generation requirement for a v5 election. It does not by
itself establish institutional independence: trustees must still run under
separately controlled accounts/hosts and retain their private shares and signing
keys independently. Bundle v4 remains supported for legacy dealer-assisted
vector elections.

Bundle v4 also carries terminal audit-or-cast receipts. A cast receipt is bound
to the exact ciphertext/proof artifact and `preparedBallotID`; an audited receipt
must have a matching public spoiled disclosure whose nonce, randomness, proof
and selected index independently reconstruct every ciphertext. Public receipt
identifiers do not contain the credential-bound nullifier, so a spoiled audit
cannot be linked to a later cast by recomputing its identifier. These checks do
not prove that the user actually chose to audit or that an uncompromised display
showed the intended candidate; usability and compromised-device risks remain.

The legacy signed bundle root detects changes to one exported ballot sequence;
it is deliberately not reinterpreted as the v2 history root. The current bundle
producer exports a shuffled final active-ballot set, and revoting replaces the
active record. Therefore repeated final bundles alone cannot establish a stable
append-only election history. Production use of v2 requires a separately
exported, stably indexed cast-event log with explicit supersession events;
tallying may continue to select the latest eligible event per nullifier. Until
that producer exists, the implemented v2 verifier proves prefix consistency
only for supplied bundles that really preserve the earlier ballot prefix.

A same-host witness test also does not establish operational independence. A
valid final bundle/checkpoint cannot prove that an operator withheld no ballot
before the witness first observed it. Deployment therefore needs a separately
controlled Mac/host that polls or receives periodic snapshots, publishes its
latest checkpoint out of band, gossips views, and retains the pinned witness
key/log.

The verifier intentionally does not call `GetSecurityProperties` and does not accept a server-provided `isValid` flag as evidence.
