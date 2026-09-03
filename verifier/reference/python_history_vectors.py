#!/usr/bin/env python3
"""Independent stdlib reference vectors for the Mongbas history-tree primitives.

This intentionally does not import, invoke, or translate the Node implementation.
It emits fixed cross-language fixtures; it is not a second election-bundle verifier.
"""

import hashlib
import json


def canonical(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def digest(*parts):
    hasher = hashlib.sha256()
    for part in parts:
        hasher.update(part)
    return hasher.digest()


def split_point(length):
    split = 1
    while split * 2 < length:
        split *= 2
    return split


def mth(leaves):
    if not leaves:
        return digest(b"")
    if len(leaves) == 1:
        return digest(b"\x00", leaves[0])
    split = split_point(len(leaves))
    return digest(b"\x01", mth(leaves[:split]), mth(leaves[split:]))


def subproof(leaves, old_size, include_old_root):
    if old_size == len(leaves):
        return [] if include_old_root else [mth(leaves)]
    split = split_point(len(leaves))
    if old_size <= split:
        return subproof(leaves[:split], old_size, include_old_root) + [mth(leaves[split:])]
    return subproof(leaves[split:], old_size - split, False) + [mth(leaves[:split])]


def consistency(leaves, old_size):
    if old_size == 0 or old_size == len(leaves):
        return []
    return subproof(leaves, old_size, True)


def make_bundle(ballot_count=8):
    return {
        "schema": "mongbas-election-bundle/v-test",
        "algorithms": {"encryption": "test-elgamal", "proof": "test-proof"},
        "configuration": {
            "electionID": "python-reference-history",
            "candidates": ["ALICE", "BOB"],
            "organizations": [{"id": "Org1"}, {"id": "Org2"}],
            "signatureThreshold": 2,
        },
        "publicKey": {"p": "17", "q": "b", "g": "2", "y": "4"},
        "trusteePublicShares": [{"index": 1, "value": "4"}, {"index": 2, "value": "8"}],
        "keyCeremony": {"transcriptHash": "11" * 32},
        "ballots": [
            {
                "preparedBallotID": f"prepared-{index}",
                "nullifierHash": digest(f"nullifier-{index}".encode()).hex(),
                "ciphertextVector": [{"c1": str(index + 2), "c2": str(index + 3)}],
                "validityProof": {"e": str(index + 4), "z": str(index + 5)},
            }
            for index in range(ballot_count)
        ],
    }


def main():
    bundle = make_bundle()
    context = {
        "schema": "mongbas-ballot-history-context/v1",
        "bundleSchema": bundle["schema"],
        "algorithms": bundle["algorithms"],
        "configuration": bundle["configuration"],
        "publicKey": bundle["publicKey"],
        "trusteePublicShares": bundle["trusteePublicShares"],
        "keyCeremony": bundle["keyCeremony"],
    }
    context_hash = digest(canonical(context).encode()).hex()
    commitments = [
        digest(canonical({
            "schema": "mongbas-canonical-ballot-commitment/v1",
            "contextHash": context_hash,
            "ballot": ballot,
        }).encode())
        for ballot in bundle["ballots"]
    ]
    vectors = {
        "schema": "mongbas-history-reference-vectors/v1",
        "generator": "python-stdlib-independent/v1",
        "bundle": bundle,
        "contextHash": context_hash,
        "commitments": [value.hex() for value in commitments],
        "roots": [mth(commitments[:size]).hex() for size in range(len(commitments) + 1)],
        "consistency": [
            {
                "oldSize": old_size,
                "newSize": new_size,
                "path": [value.hex() for value in consistency(commitments[:new_size], old_size)],
            }
            for new_size in range(len(commitments) + 1)
            for old_size in range(new_size + 1)
        ],
    }
    print(canonical(vectors))


if __name__ == "__main__":
    main()
