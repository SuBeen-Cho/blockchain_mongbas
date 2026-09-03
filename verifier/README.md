# Mongbas standalone election verifier

## Experimental stable cast-event producer

`src/cast-event-history.js` implements the approved feature-branch producer
primitive for a separately versioned append-only cast history. It accepts records
in strictly increasing Fabric `(blockNumber, transactionIndex)` order, replaces
exact commit time with a configured epoch number, chains canonical event IDs and
builds the domain-separated consistency tree. Re-exporting the same records is
byte-stable; deletion, reorder, replacement, context transplant and prefix
mutation are rejected.

Public events deliberately contain neither nullifiers, exact timestamps,
transaction positions, revote counts nor supersession edges. They commit to a
ballot with a private random nonce, so a final active bundle cannot be matched to
the event merely by hashing its ballot. A separate private selection manifest
opens every commitment and selects the highest event index for each private
selection class. That manifest is authority/auditor evidence and must never be
published with the public history.

This module is not yet a live Fabric exporter or checkpoint-v3 implementation.
It does not change existing bundle roots, schemas, ElGamal/ZKP/threshold tally or
prove coercion resistance. Fabric peers can still observe the current ledger's
nullifier writes and transaction-level correlations.

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
node bin/mongbas-witness.js compare-witnesses witness-trust.json mac-witness.jsonl linux-witness.jsonl
```

When two distinct trusted witnesses sign different roots for the same election,
context and tree size, a public monitor can create a signed, portable fork
complaint. Verification rechecks both complete source logs against pinned
witness trust and requires a separately pinned monitor key; the complaint alone
is not accepted as proof.

```bash
node bin/mongbas-witness.js init-monitor-trust public-monitor /secure/monitor-ed25519.pem monitor-trust.json
node bin/mongbas-witness.js complain-fork witness-trust.json public-monitor /secure/monitor-ed25519.pem complaint.json witness-a.jsonl witness-b.jsonl
node bin/mongbas-witness.js verify-fork witness-trust.json monitor-trust.json complaint.json witness-a.jsonl witness-b.jsonl
```

Complaint, trust and log inputs are bounded and must be regular non-symlink
files. Complaint output is canonical, fsynced, mode `0600`, and never
overwritten. This proves the exact signed split view supplied during
verification. It neither proves institutional independence of the witnesses
nor gives a voter an omission receipt or transferable participation handle.

For a new election using the privacy-separated cast-event history, create the
signed empty checkpoint before accepting the first cast, then bind each
canonical history artifact and the compatible signed election bundle:

```bash
node bin/mongbas-witness.js open-cast-history election-2026 <context-sha256> 300 cast-checkpoints.jsonl mac-observer /secure/witness-ed25519.pem
node bin/mongbas-witness.js observe-cast-history cast-history.json election-bundle.signed.json cast-checkpoints.jsonl mac-observer /secure/witness-ed25519.pem
node bin/mongbas-witness.js verify-cast-history cast-history.json cast-checkpoints.jsonl witness-trust.json 2
```

For a deployed history-enabled chaincode, export an explicitly bounded Fabric
block range and then build the public history plus its separately protected
private selection manifest:

```bash
cd application
npm run history:export -- --election-id election-2026 --start-block 100 --end-block 250 --output /private/fabric-history-input.json
cd ../verifier
node bin/mongbas-cast-history.js /private/fabric-history-input.json <context-sha256> 300 cast-history.json /private/cast-selection-manifest.json
```

The exporter reads valid transactions from filtered block events, preserves the
actual transaction index in each block, and opens each notice using the PDC
record keyed by transaction ID. It refuses to overwrite output and defaults to
at most 10,000 records and 16 MiB per private response (`--max-records` can be
raised only to the hard 100,000 ceiling). This command
requires a separately approved chaincode deployment before it can be exercised
against a live Fabric ledger.

These commands use checkpoint v3 with discriminated `opening` and
`observation` entries. The opening has tree size zero and no bundle fields; an
observation signs the cast-history summary, the complete artifact hash and the
existing bundle metadata. V3 logs cannot implicitly absorb v1/v2 entries, and
an opening cannot be added retroactively after voting. Existing v1/v2 logs and
their explicit v1→v2 migration remain supported unchanged.

`init-trust` derives only the public Ed25519 key, creates the trust document
with mode `0600`, and refuses to overwrite an existing trust document.
`compare` verifies every supplied log and rejects two individually valid,
same-witness histories if they contain different signed checkpoints at the same
sequence. A shorter log that is an exact prefix of a longer log is accepted.
`compare-witnesses` instead requires distinct trusted witness identities, one
homogeneous v2 or v3 history-checkpoint version, one election/context, and at
least one shared tree size.
It rejects different roots at a shared size as a split view. Logs with no shared
snapshot are reported as insufficient evidence rather than accepted as
consistent. This compares signed observations; the witnesses are operationally
independent only when their hosts, administrators, keys and publication paths
are independently controlled.
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

Legacy bundle-derived history logs use checkpoint v2. In addition to the signed checkpoint hash chain,
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
development test suite therefore requires `python3`. A second reference,
`reference/python_checkpoint_verify.py`, independently reconstructs canonical
checkpoint-v2 signed bytes, validates exact checkpoint/history fields and
election/context/key binding, and asks the system OpenSSL Ed25519 implementation
to verify the signature. The tests include valid, wrong-election, wrong-context
and mutated-signed-byte cases. It verifies one checkpoint rather than a complete
log, bundle, consistency proof or election cryptosystem, so it is not a complete
second Mongbas verifier. Development cross-checks require Python 3 and OpenSSL;
normal verifier runtime commands continue to require only Node.js built-ins.

The standalone Node verifier, bundle builder/signer, tamper-corpus CLI, and all
Python references accept only regular, non-symlink bundle files and cap input
at 256 MiB before parsing or modular
arithmetic. The limit accommodates the evaluated 10,000-ballot sizing model;
larger artifacts require a separately designed streaming verifier rather than
raising the bound without a resource preflight. The bundle signer separately
caps Ed25519 private-key files at 64 KiB.

`reference/python_bundle_v1_verify.py` independently verifies the complete
legacy scalar-v1 path with Python and the system OpenSSL Ed25519 implementation:
canonical bytes and exact fields, group membership, disjunctive ballot proofs,
Fiat–Shamir challenges, homomorphic aggregation, tally decryption proof, the
project Merkle root, and threshold organization signatures. Cross-language
tests require acceptance of a Node-produced bundle and rejection of proof,
aggregate, tally, root, signature, and serialization mutations. Its scope is
exactly v1; it does not cover v2 threshold shares, v4/v5 vector ballots, DKG,
audit-or-cast evidence, history checkpoints, or live-ledger provenance.

`reference/python_bundle_v2_verify.py` extends the separate Python/OpenSSL path
to threshold-v2. It independently verifies the three configured public shares,
each submitted partial-decryption proof, trustee identity/index binding,
Lagrange combination at zero, the combined election key, and the decrypted
tally in addition to the shared v1 ballot, aggregate, Merkle, and signature
checks. It still does not cover current vector-v4/v5 or DKG/audit-or-cast.

`reference/python_bundle_v4_verify.py` covers the complete vector-v4 envelope:
per-candidate bit proofs, one-hot sum proofs, vector aggregation and threshold
decryption, cast/audited receipt binding, disclosed-randomness re-encryption,
Merkle root, and organization signatures. DKG-bearing v5 remains a separate
unimplemented cross-verification layer.

`reference/python_bundle_v5_verify.py` adds that DKG-v5 layer: canonical
transcript hashing, Ed25519/X25519 SPKI algorithm binding, the fixed 2-of-3 MSP
roster and approvals, dealer Feldman commitments, election-key multiplication,
all published-share equations, bundled-share equality, and the original v5
organization signatures. Together the Python references cover every currently
supported bundle schema except the intentionally unsupported historical v3.

To build and sign an exported source without sending private keys to the server:

```bash
node bin/mongbas-bundle.js build election-bundle-source.json election-bundle.json
node bin/mongbas-bundle.js sign election-bundle.json ec /secure/ec-ed25519.pem election-bundle.ec.json
node bin/mongbas-bundle.js sign election-bundle.ec.json civil /secure/civil-ed25519.pem election-bundle.signed.json
node bin/mongbas-verify.js election-bundle.signed.json
```

The builder writes files with mode `0600`. Signing verifies that the private key matches the organization's public key declared in the bundle. Private keys are read locally and never included in output.

The process exits `0` only when every implemented check passes, `1` for an invalid bundle, and `2` for incorrect CLI usage.

## Experimental C2SP checkpoint adapter

`src/c2sp-adapter.js` provides a bounded additive adapter for the C2SP signed-note/checkpoint and witness-request wire formats. It:

- creates and verifies an exact three-line checkpoint body with an Ed25519 signed-note signature;
- computes the C2SP type-`0x01` key ID from the key name and raw Ed25519 public key;
- rejects non-canonical size/base64, invalid empty roots, forbidden controls, oversized notes and more than 16 signatures;
- formats at most 63 RFC-style consistency nodes for `add-checkpoint`;
- accepts only a fully verified checkpoint-v3 source log;
- requires the C2SP log-operator key to differ from the Mongbas witness key; and
- requires a growing tree's previous operator checkpoint to equal the verified history prefix;
- can submit a bounded request only to an exact HTTPS `/add-checkpoint` URL with redirects disabled and a bounded timeout/response; and
- accepts a response only after the pinned log signature and configured timestamped witness quorum both verify.

This is an adapter library and local state-transition primitive, not a deployed C2SP HTTP witness. The HTTP transport is covered with both an injected response harness and a real loopback TLS round trip. It also interoperated with the official `transparency-dev/witness` implementation at pinned commit `f8056f8`: opening, `0→1`, non-empty-proof `1→2`, stale-size, same-size fork and malformed-proof paths behaved as expected. This establishes the tested wire/proof interoperability only; it does not establish full C2SP conformance or an independently governed production witness. Existing Mongbas checkpoint-v3 JSON and signature semantics are unchanged.

The local publication CLI persists the operator-signed checkpoint with fsync plus atomic rename before releasing a non-overwriting request artifact. Its state directory is mode `0700`, its checkpoint/request files are mode `0600`, and a lock serializes publishers. Re-running the same verified source produces the same request without replacing state. Publication itself does not transmit anything.

```bash
node bin/mongbas-c2sp.js publish \
  cast-history-checkpoints.jsonl witness-trust.json \
  mongbas.example/cast-history/election-id \
  /secure/log-operator-ed25519.pem /secure/c2sp-state request.txt
```

An operator can separately and explicitly submit that artifact to a configured HTTPS witness. The command validates the request, pinned log signature and witness policy before network access and writes a mode-`0600`, fsynced, non-overwriting cosigned checkpoint only after the returned quorum verifies. It never discovers or trusts keys from the response.

```bash
node bin/mongbas-c2sp.js submit \
  request.txt c2sp-state/checkpoint.note \
  https://witness.example/add-checkpoint \
  log-trust.json witness-policy.json cosigned-checkpoint.note
```

`submit` is an explicit outbound network operation. A passing command is evidence only for the exact configured endpoint and keys; it does not establish that their operators are institutionally independent.

A received cosigned checkpoint can be checked against a separately pinned log key and a strict `mongbas-c2sp-witness-policy/v1` k-of-n policy. The verifier accepts at most 32 distinct witness identities/names/Ed25519 keys, ignores unknown signatures, rejects a malformed signature whose known name and key ID match, rejects duplicate cosignatures and zero/future timestamps, and never counts the log key as a witness key.

```bash
node bin/mongbas-c2sp.js verify-cosignatures \
  cosigned-checkpoint.note log-trust.json witness-policy.json
```

This fixed k-of-n policy is intentionally narrower than the full C2SP policy language. It does not establish that the listed operators are institutionally independent.

Witness database rollback can invalidate append-only guarantees even when every signature key remains uncompromised. Keep a checkpoint anchor outside the witness database. Initialization is deliberately separate from advancement so a missing anchor cannot silently become trust-on-first-use during normal operation. Both commands verify the pinned log signature, witness quorum, exact request binding and Merkle consistency before atomically writing a mode-`0600` anchor; advancement fails if the anchor is absent, smaller, forked or inconsistent.

```bash
node bin/mongbas-c2sp.js initialize-anchor \
  request.txt cosigned-checkpoint.note log-trust.json witness-policy.json \
  /separate-state/c2sp-anchor.json

node bin/mongbas-c2sp.js advance-anchor \
  next-request.txt next-cosigned-checkpoint.note log-trust.json witness-policy.json \
  /separate-state/c2sp-anchor.json
```

The anchor must be stored on a separately protected or immutable system and compared before a witness resumes signing. Keeping it beside the same rollback-prone database does not mitigate host compromise or storage rollback.

For the pinned `transparency-dev/witness` SQLite schema, run the Linux startup
preflight while the witness is stopped and before starting its HTTP listener. It
performs SQLite integrity checking, extracts exactly one checkpoint for the
configured origin through a read-only connection, verifies the log signature
and witness quorum, and requires the origin, size, root and complete cosigned
checkpoint hash to match the external anchor exactly:

```bash
./deploy/linux/witness-anchor-preflight.sh \
  /witness-state/witness.db mongbas.example/cast-history/election-id \
  log-trust.json witness-policy.json /separate-state/c2sp-anchor.json
```

Do not place the preflight and witness start in two independently invoked
operator commands. Use the anchored launcher so the witness process is reached
only through the successful gate (the witness executable path must be absolute):

```bash
./deploy/linux/witness-anchored-start.sh \
  /witness-state/witness.db mongbas.example/cast-history/election-id \
  /witness-config/log-trust.json /witness-config/witness-policy.json \
  /separate-state/c2sp-anchor.json \
  /opt/mongbas/bin/omniwitness --config /witness-config/omniwitness.yaml
```

Use this launcher as the systemd `ExecStart` command rather than exposing a
separate unchecked `omniwitness` start path. A failed, missing, stale or forked
anchor exits before `exec` and therefore before the HTTP listener starts.

Create a consistent SQLite snapshot with the online-backup API rather than
copying the database, WAL and SHM files independently. The destination must not
exist and is published atomically with mode `0600`:

```bash
./deploy/linux/witness-db-snapshot.py \
  /witness-state/witness.db /separate-backup/witness-2026-09-04.db
```

The tool integrity-checks both source and snapshot. Before switching a restored
copy into service, keep the witness stopped and run the same external-anchor
preflight against that copy. Snapshot creation does not advance the anchor and
does not authorize signing from an older database.

A database behind the anchor is rejected as rollback. A database ahead of the
anchor is also rejected: verify and advance the protected anchor through the
normal consistency-proof path before restarting. This wrapper understands the
pinned upstream `logs`/`chkpts` SQLite schema; re-audit it before upgrading the
upstream witness. It is a startup gate, not a substitute for separate storage,
an immutable anchor, independent administration or consistent DB/WAL/SHM
snapshots.

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
append-only election history. The feature branch now has a separately exported,
stably indexed cast-event producer whose public events omit supersession and
stable nullifier linkage while a protected manifest retains active selection.
It has not been deployed to the preserved Fabric network, and the protected
selection has no public zero-knowledge correctness proof. Legacy checkpoint-v2
therefore remains limited to supplied bundle prefixes; checkpoint-v3 is the
only schema for the new cast-event history.

A same-host witness test also does not establish operational independence. A
valid final bundle/checkpoint cannot prove that an operator withheld no ballot
before the witness first observed it. Deployment therefore needs a separately
controlled Mac/host that polls or receives periodic snapshots, publishes its
latest checkpoint out of band, gossips views, and retains the pinned witness
key/log.

The verifier intentionally does not call `GetSecurityProperties` and does not accept a server-provided `isValid` flag as evidence.
