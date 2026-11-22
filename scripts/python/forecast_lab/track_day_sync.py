"""Opt-in append synchronization against the private data repository."""
import base64
import json
import subprocess
from urllib.parse import quote

from .track_day import TRACK_DAY_VERSION
from .track_day_store import Conflict

REPO = "Soso2e/TurfLab-data"


def github(*args, **kwargs):
    return subprocess.run(["gh", "api", *args], capture_output=True, **kwargs)


def push_append(root, path):
    base = root / "track-days" / TRACK_DAY_VERSION
    relative = path.relative_to(base)
    if len(relative.parts) != 2 or not relative.name.endswith(("-turf.jsonl", "-dirt.jsonl")):
        raise ValueError("invalid snapshot path")
    from sqlite3 import connect
    from contextlib import closing
    endpoint = "repos/" + REPO + "/contents/" + quote("exchange/track-days/" + TRACK_DAY_VERSION +
                                                       "/" + relative.as_posix())
    with closing(connect(base / ".append.sqlite3", timeout=60, isolation_level=None)) as db:
        db.execute("BEGIN IMMEDIATE")
        content, pending = db.execute("SELECT content,pending FROM files WHERE path = ?",
                                      (relative.as_posix(),)).fetchone() or (None, None)
        if not content or pending or path.read_bytes() != content:
            raise Conflict("LOCAL_FILE_CONFLICT")
        remote = github(endpoint + "?ref=main")
        if remote.returncode and b"HTTP 404" not in remote.stderr:
            raise RuntimeError(remote.stderr.decode(errors="replace"))
        prior = json.loads(remote.stdout) if not remote.returncode else {}
        if prior and prior.get("encoding") != "base64":
            raise ValueError("unsupported GitHub content encoding")
        previous = base64.b64decode(prior.get("content", ""))
        if not content.startswith(previous) or (previous and not previous.endswith(b"\n")):
            raise Conflict("REMOTE_FILE_CONFLICT")
        if content == previous:
            return False
        request = {"branch": "main", "message": f"Append Track Day snapshots for {relative.as_posix()}",
                   "content": base64.b64encode(content).decode("ascii")}
        if prior:
            request["sha"] = prior["sha"]
        result = github(endpoint, "-X", "PUT", "--input", "-", input=json.dumps(request).encode())
        if result.returncode:
            raise RuntimeError(result.stderr.decode(errors="replace"))
        return True
