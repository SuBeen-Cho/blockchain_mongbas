#!/usr/bin/env python3
"""Independent verifier for Mongbas checkpoint-v2/v3 canonical signed bytes.

The script uses Python's JSON/base64 validation and the OpenSSL CLI's Ed25519
implementation. It intentionally does not import or execute Mongbas Node code.
It validates one checkpoint, not a full checkpoint log or election bundle.
"""

import base64
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path


V2_CHECKPOINT_KEYS = {
    "schema", "witnessID", "witnessPublicKeyDer", "sequence",
    "previousCheckpointHash", "observedAt", "electionID", "bundleHash",
    "bulletinBoardRoot", "ballotCount", "publishedAt", "history", "signature",
}
V2_HISTORY_KEYS = {
    "schema", "treeAlgorithm", "leafAlgorithm", "contextHash", "treeSize",
    "rootHash", "previousTreeSize", "previousRootHash", "consistencyPath",
}
V3_COMMON_KEYS = {
    "schema", "kind", "witnessID", "witnessPublicKeyDer", "sequence",
    "previousCheckpointHash", "observedAt", "electionID", "electionContextHash",
    "epochSeconds", "history", "signature",
}
V3_OBSERVATION_KEYS = V3_COMMON_KEYS | {
    "historyArtifactHash", "bundleHash", "bulletinBoardRoot", "ballotCount", "publishedAt",
}
V3_HISTORY_KEYS = {
    "schema", "treeAlgorithm", "leafAlgorithm", "treeSize", "rootHash",
    "previousTreeSize", "previousRootHash", "consistencyPath",
}
HASH = re.compile(r"^[0-9a-f]{64}$")
IDENTIFIER = re.compile(r"^[A-Za-z0-9_.-]+$")


def canonical(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def fail(message):
    print(f"INVALID: {message}", file=sys.stderr)
    raise SystemExit(1)


def decode_base64(value, label):
    if not isinstance(value, str):
        fail(f"{label}: expected base64 string")
    try:
        decoded = base64.b64decode(value, validate=True)
    except (ValueError, base64.binascii.Error):
        fail(f"{label}: invalid base64")
    if base64.b64encode(decoded).decode("ascii") != value:
        fail(f"{label}: non-canonical base64")
    return decoded


def validate_v2(checkpoint, expected_context):
    if set(checkpoint) != V2_CHECKPOINT_KEYS:
        fail("checkpoint fields mismatch")
    history = checkpoint.get("history")
    if not isinstance(history, dict) or set(history) != V2_HISTORY_KEYS:
        fail("history fields mismatch")
    if checkpoint["schema"] != "mongbas-bulletin-board-checkpoint/v2":
        fail("checkpoint schema mismatch")
    if history["schema"] != "mongbas-ballot-history/v1":
        fail("history schema mismatch")
    if history["treeAlgorithm"] != "mongbas-ballot-history-tree-sha256/v1" or \
            history["leafAlgorithm"] != "mongbas-canonical-ballot-commitment-sha256/v1":
        fail("history algorithm mismatch")
    if history["contextHash"] != expected_context:
        fail("context mismatch")
    for field in ("bundleHash", "bulletinBoardRoot"):
        if not isinstance(checkpoint[field], str) or not HASH.fullmatch(checkpoint[field]):
            fail(f"{field}: invalid hash")
    for field in ("contextHash", "rootHash", "previousRootHash"):
        if not isinstance(history[field], str) or not HASH.fullmatch(history[field]):
            fail(f"history.{field}: invalid hash")
    if not isinstance(checkpoint["sequence"], int) or isinstance(checkpoint["sequence"], bool) or checkpoint["sequence"] < 1:
        fail("invalid sequence")
    for field in ("ballotCount", "publishedAt"):
        if not isinstance(checkpoint[field], int) or isinstance(checkpoint[field], bool) or checkpoint[field] < 0:
            fail(f"invalid {field}")
    for field in ("treeSize", "previousTreeSize"):
        if not isinstance(history[field], int) or isinstance(history[field], bool) or history[field] < 0:
            fail(f"invalid history.{field}")
    if checkpoint["ballotCount"] < 1 or history["treeSize"] < 1 or history["treeSize"] != checkpoint["ballotCount"]:
        fail("history size mismatch")
    if history["previousTreeSize"] > history["treeSize"]:
        fail("history predecessor size mismatch")
    if not isinstance(history["consistencyPath"], list) or any(
            not isinstance(node, str) or not HASH.fullmatch(node) for node in history["consistencyPath"]):
        fail("invalid consistency path")


def validate_v3(checkpoint, expected_context):
    kind = checkpoint.get("kind")
    expected_keys = V3_COMMON_KEYS if kind == "opening" else V3_OBSERVATION_KEYS
    if kind not in ("opening", "observation") or set(checkpoint) != expected_keys:
        fail("checkpoint v3 fields or kind mismatch")
    history = checkpoint.get("history")
    if not isinstance(history, dict) or set(history) != V3_HISTORY_KEYS:
        fail("history v3 fields mismatch")
    if checkpoint["electionContextHash"] != expected_context or not HASH.fullmatch(expected_context):
        fail("context mismatch")
    if history["schema"] != "mongbas-cast-event-history/v1" or \
            history["treeAlgorithm"] != "mongbas-cast-event-history-tree-sha256/v1" or \
            history["leafAlgorithm"] != "mongbas-cast-event-id-sha256/v1":
        fail("history v3 schema or algorithm mismatch")
    if not isinstance(checkpoint["epochSeconds"], int) or isinstance(checkpoint["epochSeconds"], bool) or \
            not (1 <= checkpoint["epochSeconds"] <= 86400):
        fail("invalid epoch policy")
    for field in ("rootHash", "previousRootHash"):
        if not isinstance(history[field], str) or not HASH.fullmatch(history[field]):
            fail(f"history.{field}: invalid hash")
    for field in ("treeSize", "previousTreeSize"):
        if not isinstance(history[field], int) or isinstance(history[field], bool) or history[field] < 0:
            fail(f"invalid history.{field}")
    if history["previousTreeSize"] > history["treeSize"] or not isinstance(history["consistencyPath"], list) or any(
            not isinstance(node, str) or not HASH.fullmatch(node) for node in history["consistencyPath"]):
        fail("invalid v3 history predecessor or path")
    if kind == "opening":
        empty_root = __import__("hashlib").sha256(b"").hexdigest()
        if checkpoint["sequence"] != 1 or checkpoint["previousCheckpointHash"] is not None or \
                history["treeSize"] != 0 or history["previousTreeSize"] != 0 or \
                history["rootHash"] != empty_root or history["previousRootHash"] != empty_root or history["consistencyPath"]:
            fail("invalid opening checkpoint")
    else:
        for field in ("historyArtifactHash", "bundleHash", "bulletinBoardRoot"):
            if not isinstance(checkpoint[field], str) or not HASH.fullmatch(checkpoint[field]):
                fail(f"{field}: invalid hash")
        if not isinstance(checkpoint["ballotCount"], int) or isinstance(checkpoint["ballotCount"], bool) or \
                checkpoint["ballotCount"] < 1 or history["treeSize"] < checkpoint["ballotCount"]:
            fail("invalid observation ballot/history count")
        if not isinstance(checkpoint["publishedAt"], int) or isinstance(checkpoint["publishedAt"], bool) or checkpoint["publishedAt"] < 0:
            fail("invalid publication timestamp")


def validate(checkpoint, expected_key, expected_election, expected_context):
    if not isinstance(checkpoint, dict):
        fail("checkpoint must be an object")
    if checkpoint.get("electionID") != expected_election:
        fail("election mismatch")
    if not isinstance(checkpoint.get("witnessID"), str) or not (1 <= len(checkpoint["witnessID"]) <= 128) or \
            not IDENTIFIER.fullmatch(checkpoint["witnessID"]):
        fail("witness identity mismatch")
    if checkpoint.get("witnessPublicKeyDer") != expected_key:
        fail("witness public key mismatch")
    if not isinstance(checkpoint.get("sequence"), int) or isinstance(checkpoint["sequence"], bool) or checkpoint["sequence"] < 1:
        fail("invalid sequence")
    schema = checkpoint.get("schema")
    if schema == "mongbas-bulletin-board-checkpoint/v2":
        validate_v2(checkpoint, expected_context)
    elif schema == "mongbas-bulletin-board-checkpoint/v3":
        validate_v3(checkpoint, expected_context)
    else:
        fail("checkpoint schema mismatch")


def verify_signature(checkpoint, public_der, signature):
    unsigned = dict(checkpoint)
    del unsigned["signature"]
    payload = canonical(unsigned).encode("utf-8")
    with tempfile.TemporaryDirectory(prefix="mongbas-checkpoint-reference-") as directory:
        root = Path(directory)
        key_path = root / "public.der"
        data_path = root / "signed-bytes"
        signature_path = root / "signature"
        key_path.write_bytes(public_der)
        data_path.write_bytes(payload)
        signature_path.write_bytes(signature)
        result = subprocess.run([
            "openssl", "pkeyutl", "-verify", "-pubin", "-keyform", "DER",
            "-inkey", str(key_path), "-rawin", "-in", str(data_path),
            "-sigfile", str(signature_path),
        ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    if result.returncode != 0:
        fail("invalid signature")


def main():
    if len(sys.argv) != 5:
        print("usage: python_checkpoint_verify.py CHECKPOINT PUBLIC_DER_BASE64 ELECTION_ID CONTEXT_HASH", file=sys.stderr)
        raise SystemExit(2)
    checkpoint_path, expected_key, expected_election, expected_context = sys.argv[1:]
    try:
        raw = Path(checkpoint_path).read_text(encoding="utf-8")
        checkpoint = json.loads(raw)
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        fail(f"checkpoint read failed: {error}")
    if raw != canonical(checkpoint):
        fail("checkpoint is not canonical JSON")
    public_der = decode_base64(expected_key, "expected public key")
    signature = decode_base64(checkpoint.get("signature"), "signature")
    validate(checkpoint, expected_key, expected_election, expected_context)
    verify_signature(checkpoint, public_der, signature)
    print("VALID independent checkpoint signature")


if __name__ == "__main__":
    main()
