"""Read-only access to the NAR archive: CSV files and ZIPs are copied/extracted into a throwaway
directory, so the production data home is never written to."""
from __future__ import annotations

import shutil
import sys
import tempfile
import zipfile
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from analyze_history import load_nar_csv_dir  # noqa: E402

from .data import clean_runs  # noqa: E402


@contextmanager
def staged_copy(src: Path) -> Iterator[tuple[Path, dict]]:
    """Yield a temp dir holding every CSV (and every CSV inside any ZIP) under ``src``. Source is only read."""
    info = {"csv_files": 0, "zip_files": 0, "csv_in_zip": 0, "unreadable_zips": []}
    with tempfile.TemporaryDirectory(prefix="forecast-lab-") as tmp:
        out = Path(tmp)
        n = 0
        for f in sorted(p for p in src.rglob("*") if p.is_file()):
            suffix = f.suffix.lower()
            if suffix == ".csv":
                n += 1; info["csv_files"] += 1
                shutil.copyfile(f, out / f"{n:06d}.csv")
            elif suffix == ".zip":
                info["zip_files"] += 1
                try:
                    with zipfile.ZipFile(f) as z:
                        for m in z.infolist():
                            if m.is_dir() or not m.filename.lower().endswith(".csv"):
                                continue
                            n += 1; info["csv_in_zip"] += 1
                            (out / f"{n:06d}.csv").write_bytes(z.read(m))  # name never used as a path (no zip-slip)
                except (zipfile.BadZipFile, OSError) as e:
                    info["unreadable_zips"].append({"file": f.name, "error": str(e)[:120]})
        yield out, info


def load_runs(src: Path) -> tuple[list[dict], dict]:
    """Loader + dedupe. Returns (runs, provenance). Never modifies ``src``."""
    with staged_copy(src) as (tmp, info):
        loaded = load_nar_csv_dir(tmp)
    runs, dedupe = clean_runs(loaded["runs"])
    return runs, {"source": str(src), **info, "loader_files": loaded["files"], "date_range": loaded["date_range"],
                  "tracks": loaded["tracks"], "dedupe": dedupe}
