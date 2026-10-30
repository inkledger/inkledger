"""Model files: pinned in models.lock.json, downloaded once, checked, moved in atomically.

Two starts never download at once (an exclusive flock on models/.lock): the second waits,
then finds the files already there. A checksum mismatch leaves nothing behind.
"""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
import shutil
import tempfile
import urllib.request
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

CHUNK = 1 << 20

Fetch = Callable[[str], Iterator[bytes]]


class ModelError(Exception):
    """The model can't be made ready (missing from the lock, a download failed, a checksum differs)."""


@dataclass(frozen=True)
class PinnedModel:
    name: str
    repo: str
    revision: str
    files: tuple[tuple[str, str], ...]

    @property
    def folder(self) -> str:
        return f"{self.repo.replace('/', '--')}@{self.revision}"


def pinned(lock_path: Path, name: str) -> PinnedModel:
    lock = json.loads(lock_path.read_text())
    entry = lock["models"].get(name)
    if entry is None:
        raise ModelError(f"{name} is not in {lock_path.name}")
    return PinnedModel(name, entry["repo"], entry["revision"], tuple((f["path"], f["sha256"]) for f in entry["files"]))


def hub_fetch(url: str) -> Iterator[bytes]:
    """Hugging Face over HTTPS, streamed."""
    with urllib.request.urlopen(url, timeout=60) as res:  # noqa: S310 (fixed https host)
        while chunk := res.read(CHUNK):
            yield chunk


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while chunk := f.read(CHUNK):
            h.update(chunk)
    return h.hexdigest()


def _complete(folder: Path, model: PinnedModel) -> bool:
    return folder.is_dir() and all((folder / p).is_file() and _sha256(folder / p) == sha for p, sha in model.files)


@contextmanager
def _exclusive(models_dir: Path) -> Iterator[None]:
    models_dir.mkdir(parents=True, exist_ok=True)
    with (models_dir / ".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def ensure_model(models_dir: Path, model: PinnedModel, fetch: Fetch = hub_fetch) -> Path:
    """The model's folder, verified; downloaded first when missing or damaged."""
    target = models_dir / model.folder
    with _exclusive(models_dir):
        if _complete(target, model):
            return target
        tmp = Path(tempfile.mkdtemp(prefix=".tmp-", dir=models_dir))
        try:
            for path, sha in model.files:
                dest = tmp / path
                dest.parent.mkdir(parents=True, exist_ok=True)
                h = hashlib.sha256()
                with dest.open("wb") as out:
                    for chunk in fetch(f"https://huggingface.co/{model.repo}/resolve/{model.revision}/{path}"):
                        h.update(chunk)
                        out.write(chunk)
                if h.hexdigest() != sha:
                    raise ModelError(f"checksum mismatch: {path}")
            if target.exists():
                shutil.rmtree(target)
            os.rename(tmp, target)
            return target
        finally:
            if tmp.exists():
                shutil.rmtree(tmp)
