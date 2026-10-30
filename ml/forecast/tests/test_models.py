"""AC-3.39: the model download is checked, atomic and locked (docs/work/ideas/estimates.md R-3.21)."""

import hashlib
import threading
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from forecast.app import create_app
from forecast.models import ModelError, PinnedModel, ensure_model

FILES = {"config.json": b'{"patch_size": 32}', "model.safetensors": b"weights" * 1000}
MODEL = PinnedModel("Tiny", "acme/tiny", "abc123", tuple((p, hashlib.sha256(b).hexdigest()) for p, b in FILES.items()))


def serving(files: dict[str, bytes], calls: list[str], delay: float = 0.0):
    def fetch(url: str):
        calls.append(url)
        time.sleep(delay)
        yield files[url.rsplit("/", 1)[1]]

    return fetch


def test_download_is_checked_atomic_and_locked(tmp_path: Path):
    # A file that isn't what the lock says: not ready, nothing left behind.
    calls: list[str] = []
    with pytest.raises(ModelError, match="checksum mismatch: model.safetensors"):
        ensure_model(tmp_path, MODEL, serving({**FILES, "model.safetensors": b"tampered"}, calls))
    assert sorted(p.name for p in tmp_path.iterdir()) == [".lock"]

    # Two starts at once: one download, both get the same verified folder.
    calls.clear()
    got: list[Path] = []
    starts = [threading.Thread(target=lambda: got.append(ensure_model(tmp_path, MODEL, serving(FILES, calls, delay=0.05)))) for _ in range(2)]
    for s in starts:
        s.start()
    for s in starts:
        s.join()
    assert len(calls) == len(FILES)
    assert got[0] == got[1] == tmp_path / "acme--tiny@abc123"
    assert {p.name: p.read_bytes() for p in got[0].iterdir()} == FILES
    assert not [p for p in tmp_path.iterdir() if p.name.startswith(".tmp-")]

    # Up while the model is still on its way: /health yes, /ready not yet.
    release = threading.Event()

    def slow_loader():
        release.wait(5)
        raise ModelError("still downloading")

    client = TestClient(create_app(slow_loader, "Tiny"))
    assert client.get("/health").json() == {"up": True}
    ready = client.get("/ready")
    assert ready.status_code == 503 and ready.json() == {"reason": "loading"}
    release.set()
    for _ in range(50):
        if client.get("/ready").json().get("reason") != "loading":
            break
        time.sleep(0.02)
    assert client.get("/ready").json() == {"reason": "still downloading"}
