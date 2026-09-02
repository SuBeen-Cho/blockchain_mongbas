# Mongbas DKG trustee tool

This dependency-free Node.js tool performs the offline authenticated 2-of-3
Feldman ceremony and creates external vector partial decryptions. Trustee
private records and aggregate scalar shares must be stored with mode `0600`.

## Ceremony

```bash
node bin/mongbas-trustee.js init --id ElectionCommissionMSP --index 1 \
  --private /secure/ec-key.json --public ec-public.json
node bin/mongbas-trustee.js contribute --ceremony election-2026 \
  --id ElectionCommissionMSP --private /secure/ec-key.json \
  --participants participants.json --out ec-contribution.json
```

Every participant exchanges the public descriptor and signed/encrypted
contribution out of band. Each recipient runs `finalize-share`; only the
recipient can decrypt its three polynomial evaluations. `finalize-transcript`
accepts exactly one valid contribution and public share per configured trustee.

## Authenticated complaints

If local verification fails, the trustee can create an attributable public
complaint without copying its scalar share into the artifact:

```bash
node bin/mongbas-trustee.js complain --ceremony election-2026 \
  --id ElectionCommissionMSP --dealer PartyObserverMSP \
  --reason feldman-equation-failed \
  --contribution-hash 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
  --evidence-hash abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789 \
  --private /secure/ec-key.json --participants participants.json \
  --out ec-complaint.json
```

Allowed reason codes are `missing-contribution`, `invalid-signature`,
`incomplete-recipient-set`, `envelope-authentication-failed`,
`share-out-of-range`, and `feldman-equation-failed`.

Pass a directory of complaint JSON files to transcript finalization with
`--complaints-dir`. Every complaint is verified against the participant's
Ed25519 key. A duplicate or any valid complaint aborts finalization with a
non-zero exit. The current 3-party/threshold-2 protocol never silently excludes
a dealer or changes its threshold. Robust recovery requires a separately
specified DKG construction and participant/adversary profile.

## Partial decryption

```bash
node bin/mongbas-trustee.js partial --election ELECTION_ID \
  --private-share /secure/ec-share.json --aggregate aggregate.json \
  --out ec-partial.json
```

The output contains public `c1^x_i` values and Chaum–Pedersen proofs, never the
trustee scalar. Chaincode binds the submitting MSP to the trustee index and
public share before accepting it.
