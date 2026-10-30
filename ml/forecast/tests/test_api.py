"""AC-3.40, AC-3.54: /forecast's shape, validation and readiness (docs/work/ideas/estimates.md R-3.21)."""

import threading
import time

from fastapi.testclient import TestClient

from forecast.app import create_app
from forecast.forecaster import FakeForecaster


def ready_client() -> TestClient:
    client = TestClient(create_app(FakeForecaster, "fake"))
    for _ in range(100):
        if client.get("/ready").status_code == 200:
            return client
        time.sleep(0.01)
    raise AssertionError("never ready")


def body(**over):
    days = 21
    return {
        "series": [float(i % 7) for i in range(days)],
        "freq": "D",
        "horizon": 7,
        "quantiles": [0.1, 0.5, 0.9],
        "past_covariates": {"workday": [1.0] * days, "off": [0.0] * days},
        "future_covariates": {"workday": [1.0] * 7, "off": [0.0] * 7},
    } | over


def test_forecast_shape_validation_and_readiness():
    # Before the model is ready: 503, with the reason.
    gate = threading.Event()
    waiting = TestClient(create_app(lambda: (gate.wait(5), FakeForecaster())[1], "fake"))
    early = waiting.post("/forecast", json=body())
    assert early.status_code == 503 and early.json() == {"reason": "loading"}
    gate.set()

    client = ready_client()
    assert client.get("/ready").json() == {"model": "fake"}
    res = client.post("/forecast", json=body())
    assert res.status_code == 200
    q = res.json()["quantiles"]
    assert sorted(q) == ["0.1", "0.5", "0.9"]
    assert all(len(v) == 7 for v in q.values())
    # The same answer every time (FORECAST_FAKE).
    assert client.post("/forecast", json=body()).json() == res.json()
    # Missing days are null; the rest refused with 422.
    assert client.post("/forecast", json=body(series=[None] + [1.0] * 20)).status_code == 200
    for bad in (
        body(horizon=0),
        body(horizon=91),
        body(quantiles=[0.0]),
        body(quantiles=[1.5]),
        body(freq="M"),
        body(series=[]),
        body(quantiles=[0.1] * 22),
    ):
        assert client.post("/forecast", json=bad).status_code == 422, bad


def test_misaligned_covariates_are_refused():
    client = ready_client()
    days = 21
    short_past = body(past_covariates={"workday": [1.0] * days, "off": [0.0] * (days - 1)})
    long_future = body(future_covariates={"workday": [1.0] * 8, "off": [0.0] * 7})
    future_only = body(past_covariates={"workday": [1.0] * days}, future_covariates={"workday": [1.0] * 7, "off": [0.0] * 7})
    for bad in (short_past, long_future, future_only):
        res = client.post("/forecast", json=bad)
        assert res.status_code == 422, bad
