# Mongbas standalone election verifier

This package verifies a canonical election bundle without connecting to the Mongbas backend, a Fabric peer, chaincode, or a state database. It uses only Node.js built-ins and has no runtime npm dependencies.

```bash
cd verifier
npm test
node bin/mongbas-verify.js path/to/canonical-election-bundle.json
```

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
- aggregate decryption Chaum–Pedersen proof, including Fiat–Shamir challenge recomputation;
- deterministic bulletin-board Merkle root;
- threshold of distinct Ed25519 organization signatures over the complete unsigned canonical bundle;
- downgrade, deletion, replacement, reordering, duplication and proof/signature mutation tests.

## Current protocol limitation

Version `mongbas-exp-elgamal-scalar-v1` matches the current chaincode's mixed-radix scalar tally. It cannot safely support the project's intended large election sizes. The verifier rejects counts outside the base-10,000 digit range. A future bundle version must use per-candidate ciphertext vectors and verifiable trustee partial decryptions; the current aggregate proof is generated only after reconstructing the complete private key and is not evidence of true threshold ElGamal.

The verifier intentionally does not call `GetSecurityProperties` and does not accept a server-provided `isValid` flag as evidence.
