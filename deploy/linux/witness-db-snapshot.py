#!/usr/bin/env python3
"""Create a fail-closed, non-overwriting SQLite online backup."""

import os
import sqlite3
import stat
import sys
import uuid
from urllib.parse import quote


def fail(message):
    raise RuntimeError(message)


def main():
    if len(sys.argv) != 3:
        print("usage: witness-db-snapshot.py <absolute-source.db> <absolute-snapshot.db>", file=sys.stderr)
        return 2
    source, destination = map(os.path.abspath, sys.argv[1:])
    if source != sys.argv[1] or destination != sys.argv[2]:
        fail("source and snapshot paths must be absolute")
    source_stat = os.lstat(source)
    if stat.S_ISLNK(source_stat.st_mode) or not stat.S_ISREG(source_stat.st_mode):
        fail("source database must be a regular non-symlink file")
    if os.path.lexists(destination):
        fail("snapshot already exists")
    parent = os.path.dirname(destination)
    parent_stat = os.lstat(parent)
    if stat.S_ISLNK(parent_stat.st_mode) or not stat.S_ISDIR(parent_stat.st_mode):
        fail("snapshot parent must be a directory and not a symlink")

    temporary = os.path.join(parent, "." + os.path.basename(destination) + "." +
                             str(os.getpid()) + "." + str(uuid.uuid4()) + ".tmp")
    source_db = None
    snapshot_db = None
    try:
        source_uri = "file:" + quote(source, safe="/") + "?mode=ro"
        source_db = sqlite3.connect(source_uri, uri=True)
        if source_db.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
            fail("source database integrity check failed")

        snapshot_db = sqlite3.connect(temporary)
        source_db.backup(snapshot_db)
        snapshot_db.commit()
        if snapshot_db.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
            fail("snapshot database integrity check failed")
        snapshot_db.close()
        snapshot_db = None
        source_db.close()
        source_db = None

        os.chmod(temporary, 0o600)
        descriptor = os.open(temporary, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        try:
            os.link(temporary, destination)
        except FileExistsError:
            fail("snapshot already exists")
        directory = os.open(parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
        print("WITNESS SQLITE SNAPSHOT CREATED: " + destination)
        return 0
    finally:
        if snapshot_db is not None:
            snapshot_db.close()
        if source_db is not None:
            source_db.close()
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print("witness snapshot failed: " + str(error), file=sys.stderr)
        sys.exit(1)
