#!/usr/bin/env python3
"""Atomically restrict an existing secret environment file for Tailscale Serve."""

import os
import re
import secrets
import stat
import sys
import uuid
from urllib.parse import urlsplit


TARGETS = {
    "LISTEN_HOST": "127.0.0.1",
    "ENABLE_HSTS": "true",
    "TRUST_PROXY_HOPS": "1",
}
REQUIRED = {"ADMIN_API_TOKEN", "CREDENTIAL_SECRET", "CORS_ORIGIN"}
ASSIGNMENT = re.compile(r"^[ \t]*([A-Za-z_][A-Za-z0-9_]*)=")


def fail(message):
    raise RuntimeError(message)


def fsync_directory(directory):
    descriptor = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def main():
    if len(sys.argv) != 5:
        print("usage: configure-tailnet-qr-profile.py <absolute-env> <exact-https-origin> <absolute-backup> <absolute-admission-state>", file=sys.stderr)
        return 2
    env_path, expected_origin, backup_path, admission_path = sys.argv[1:]
    if any(value != os.path.abspath(value) for value in (env_path, backup_path, admission_path)):
        fail("environment, backup and admission state paths must be absolute")
    if len({env_path, backup_path, admission_path}) != 3:
        fail("environment, backup and admission state paths must be distinct")
    parsed = urlsplit(expected_origin)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.port or
            parsed.path or parsed.query or parsed.fragment or expected_origin != f"https://{parsed.hostname}"):
        fail("expected origin must be an exact HTTPS origin without port, path, userinfo, query or fragment")

    source_stat = os.lstat(env_path)
    if stat.S_ISLNK(source_stat.st_mode) or not stat.S_ISREG(source_stat.st_mode):
        fail("environment must be a regular non-symlink file")
    if stat.S_IMODE(source_stat.st_mode) != 0o600:
        fail("environment permissions must be 0600")
    parent = os.path.dirname(env_path)
    backup_parent = os.path.dirname(backup_path)
    admission_parent = os.path.dirname(admission_path)
    for directory in {parent, backup_parent, admission_parent}:
        directory_stat = os.lstat(directory)
        if stat.S_ISLNK(directory_stat.st_mode) or not stat.S_ISDIR(directory_stat.st_mode):
            fail("environment, backup and admission parents must be non-symlink directories")
    if stat.S_IMODE(os.lstat(admission_parent).st_mode) != 0o700:
        fail("admission state parent permissions must be 0700")
    if os.path.lexists(backup_path):
        fail("backup already exists")
    if os.path.lexists(admission_path):
        admission_stat = os.lstat(admission_path)
        if stat.S_ISLNK(admission_stat.st_mode) or not stat.S_ISREG(admission_stat.st_mode) or stat.S_IMODE(admission_stat.st_mode) != 0o600:
            fail("existing admission state must be a regular non-symlink mode-0600 file")

    descriptor = os.open(env_path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        source = os.read(descriptor, 1024 * 1024 + 1)
    finally:
        os.close(descriptor)
    if len(source) > 1024 * 1024:
        fail("environment exceeds 1 MiB")
    try:
        text = source.decode("utf-8")
    except UnicodeDecodeError as error:
        fail(f"environment is not UTF-8: {error}")

    lines = text.splitlines()
    positions = {}
    values = {}
    for index, line in enumerate(lines):
        match = ASSIGNMENT.match(line)
        if not match:
            continue
        key = match.group(1)
        if key in positions:
            fail(f"duplicate environment setting: {key}")
        positions[key] = index
        values[key] = line.split("=", 1)[1]
    missing = sorted(key for key in REQUIRED if not values.get(key))
    if missing:
        fail("required environment settings are missing or empty: " + ",".join(missing))
    audit_key = values.get("AUDIT_HMAC_KEY", "")
    if audit_key and len(audit_key.encode("utf-8")) < 32:
        fail("existing AUDIT_HMAC_KEY must be at least 32 bytes")
    if audit_key and audit_key == values["CREDENTIAL_SECRET"]:
        fail("AUDIT_HMAC_KEY must be distinct from CREDENTIAL_SECRET")
    if not audit_key:
        # The approved profile requires a separately generated audit domain key.
        # It is written only to the protected environment and never printed.
        audit_key = secrets.token_urlsafe(48)

    origins = [value.strip() for value in values["CORS_ORIGIN"].split(",") if value.strip()]
    if expected_origin not in origins:
        origins.append(expected_origin)

    targets = {
        **TARGETS,
        "AUDIT_HMAC_KEY": audit_key,
        "CORS_ORIGIN": ",".join(origins),
        "DEMO_ADMISSION_FILE": admission_path,
    }
    for key, value in targets.items():
        replacement = f"{key}={value}"
        if key in positions:
            lines[positions[key]] = replacement
        else:
            positions[key] = len(lines)
            lines.append(replacement)
    updated = ("\n".join(lines) + "\n").encode("utf-8")

    backup_fd = os.open(backup_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        os.write(backup_fd, source)
        os.fsync(backup_fd)
    finally:
        os.close(backup_fd)
    fsync_directory(backup_parent)

    temporary = os.path.join(parent, f".{os.path.basename(env_path)}.{os.getpid()}.{uuid.uuid4()}.tmp")
    try:
        temporary_fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            os.write(temporary_fd, updated)
            os.fsync(temporary_fd)
        finally:
            os.close(temporary_fd)
        os.replace(temporary, env_path)
        fsync_directory(parent)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
    print(f"TAILNET QR PROFILE CONFIGURED: env={env_path} origin={expected_origin} backup={backup_path}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print("tailnet QR profile configuration failed: " + str(error), file=sys.stderr)
        sys.exit(1)
