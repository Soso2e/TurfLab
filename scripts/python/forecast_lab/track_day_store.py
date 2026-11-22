"""Append-only JSONL snapshots. SQLite serializes writers and journals pending appends."""
from contextlib import closing
from datetime import date
import json
import os
import re
import sqlite3

from .track_day import TRACK_DAY_VERSION, canonical, digest


class Conflict(ValueError):
    pass


def append(root, snapshot, *, correction_of=None, correction_evidence=None):
    track, surface, day = (snapshot[k] for k in ("track_code", "surface", "date"))
    if not re.fullmatch(r"[\w-]+", track) or surface not in ("turf", "dirt") or date.fromisoformat(day).isoformat() != day:
        raise ValueError("invalid track day path")
    base = root / "track-days" / TRACK_DAY_VERSION
    path = base / day / f"{track}-{surface}.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    key = path.relative_to(base).as_posix()
    with closing(sqlite3.connect(base / ".append.sqlite3", timeout=60, isolation_level=None)) as db:
        db.execute("CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, content BLOB, pending BLOB)")
        db.execute("BEGIN IMMEDIATE")
        try:
            physical = path.read_bytes() if path.exists() else b""
            stored = db.execute("SELECT content, pending FROM files WHERE path = ?", (key,)).fetchone()
            content, pending = stored or (b"", None)
            if pending is not None:
                # A crash can leave an append wholly or partially on disk.
                full = content + pending
                if not physical.startswith(content) or not full.startswith(physical):
                    raise Conflict("LOCAL_FILE_CONFLICT")
                write_tail(path, full[len(physical):])
                db.execute("UPDATE files SET content = ?, pending = NULL WHERE path = ?", (full, key))
                physical = content = full
            if physical != content:
                raise Conflict("LOCAL_FILE_CONFLICT")
            event = [day, track, surface, snapshot["data_mode"], snapshot["as_of_race_no"]]
            snapshot_id = digest(event)
            existing = [json.loads(line) for line in content.splitlines()]
            revisions = [r for r in existing if r["snapshot_id"] == snapshot_id]
            same = next((r for r in revisions if r["input_hash"] == snapshot["input_hash"]), None)
            if same:
                if snapshot.get("revision", same["revision"]) != same["revision"] or any(
                    same.get(k) != v for k, v in snapshot.items() if k not in ("computed_at", "revision")
                ):
                    raise Conflict("REVISION_CONFLICT")
                db.commit()
                return same, False
            revision = len(revisions) + 1
            if snapshot.get("revision", revision) != revision:
                raise Conflict("REVISION_CONFLICT")
            if revisions and (correction_of != revisions[-1]["input_hash"] or not correction_evidence):
                raise Conflict("OFFICIAL_CORRECTION_EVIDENCE_REQUIRED")
            saved = {**snapshot, "snapshot_id": snapshot_id, "revision": revision}
            if revisions:
                saved["correction_of"] = correction_of
                saved["correction_evidence"] = correction_evidence
            tail = (canonical(saved) + "\n").encode()
            # Reserve the exact bytes durably before touching the JSONL. The next
            # lock owner can finish the append if this process exits here.
            db.execute("INSERT OR REPLACE INTO files VALUES (?, ?, ?)", (key, content, tail))
            db.commit()
        except BaseException:
            db.rollback()
            raise
        db.execute("BEGIN IMMEDIATE")
        try:
            content, pending = db.execute("SELECT content, pending FROM files WHERE path = ?", (key,)).fetchone()
            physical = path.read_bytes() if path.exists() else b""
            if pending is not None:
                full = content + pending
                if not physical.startswith(content) or not full.startswith(physical):
                    raise Conflict("LOCAL_FILE_CONFLICT")
                write_tail(path, full[len(physical):])
                db.execute("UPDATE files SET content = ?, pending = NULL WHERE path = ?", (full, key))
            elif physical != content:
                raise Conflict("LOCAL_FILE_CONFLICT")
            db.commit()
        except BaseException:
            db.rollback()
            raise
    return saved, True


def write_tail(path, tail):
    if tail:
        with path.open("ab") as file:
            file.write(tail)
            file.flush()
            os.fsync(file.fileno())
