"""HTTP API (docs/work/ideas/estimates.md R-3.21): /health (the process is up), /ready (the model
is verified and loaded, else 503 with the reason), /forecast (503 until ready, 422 on bad input)."""

from __future__ import annotations

import math
import os
import threading
from collections.abc import Callable
from pathlib import Path
from typing import Annotated, Literal

import numpy as np
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, model_validator

from .forecaster import FakeForecaster, Forecaster, TimestralForecaster
from .models import ModelError, ensure_model, pinned

MAX_SERIES = 32_768
MAX_HORIZON = 90
MAX_COVARIATES = 8

Value = float | None  # None: a missing day (NaN to the model)
Name = Annotated[str, Field(min_length=1, max_length=40, pattern=r"^[a-z][a-z0-9_]*$")]


class ForecastRequest(BaseModel):
    series: list[Value] = Field(min_length=1, max_length=MAX_SERIES)
    freq: Literal["D", "W"]
    horizon: int = Field(ge=1, le=MAX_HORIZON)
    quantiles: list[float] = Field(min_length=1, max_length=21)
    future_covariates: dict[Name, list[float]] | None = Field(default=None, max_length=MAX_COVARIATES)
    past_covariates: dict[Name, list[Value]] | None = Field(default=None, max_length=MAX_COVARIATES)

    @model_validator(mode="after")
    def aligned(self) -> ForecastRequest:
        if any(not 0 < q < 1 for q in self.quantiles):
            raise ValueError("quantiles must be between 0 and 1")
        if any(v is not None and not math.isfinite(v) for v in self.series):
            raise ValueError("series values must be finite or null")
        for name, values in (self.past_covariates or {}).items():
            if len(values) != len(self.series):
                raise ValueError(f"past_covariates.{name} has {len(values)} values, the series {len(self.series)}")
        for name, values in (self.future_covariates or {}).items():
            if len(values) != self.horizon:
                raise ValueError(f"future_covariates.{name} has {len(values)} values, the horizon is {self.horizon}")
            # Known ahead means known over the history too: the model reads one row across both.
            if name not in (self.past_covariates or {}):
                raise ValueError(f"future_covariates.{name} needs past_covariates.{name} over the series")
        return self


Loader = Callable[[], Forecaster]


def default_loader() -> Forecaster:
    if os.environ.get("FORECAST_FAKE") == "1":
        return FakeForecaster()
    here = Path(__file__).resolve().parents[2]
    model = pinned(Path(os.environ.get("MODELS_LOCK", here / "models.lock.json")), os.environ.get("FORECAST_MODEL", "Timestral-28M"))
    return TimestralForecaster(ensure_model(Path(os.environ.get("MODELS_DIR", "/models")), model))


def create_app(loader: Loader = default_loader, model_name: str | None = None) -> FastAPI:
    app = FastAPI(title="inkledger forecast")
    state: dict[str, object] = {"forecaster": None, "reason": "loading"}
    name = model_name or ("fake" if os.environ.get("FORECAST_FAKE") == "1" else os.environ.get("FORECAST_MODEL", "Timestral-28M"))

    def load() -> None:
        try:
            state["forecaster"] = loader()
            state["reason"] = None
        except (ModelError, OSError) as e:
            state["reason"] = str(e)
        except Exception as e:  # noqa: BLE001 (a model that can't load: not ready, said why)
            state["reason"] = f"model failed to load: {type(e).__name__}"

    # Ready later: /health answers while the model downloads.
    threading.Thread(target=load, daemon=True).start()

    @app.get("/health")
    def health() -> dict[str, bool]:
        return {"up": True}

    @app.get("/ready")
    def ready():
        if state["forecaster"] is None:
            return JSONResponse({"reason": state["reason"]}, status_code=503)
        return {"model": name}

    @app.post("/forecast")
    def forecast(req: ForecastRequest):
        f = state["forecaster"]
        if f is None:
            return JSONResponse({"reason": state["reason"]}, status_code=503)
        nan = lambda xs: np.array([np.nan if v is None else v for v in xs], dtype=float)  # noqa: E731
        series = nan(req.series)
        future = req.future_covariates or {}
        past = {k: nan(v) for k, v in (req.past_covariates or {}).items() if k not in future}
        known = {k: np.concatenate([nan(req.past_covariates[k]), np.asarray(v, dtype=float)]) for k, v in future.items()}  # type: ignore[index]
        out = f.forecast(series, req.horizon, req.quantiles, past, known)  # type: ignore[union-attr]
        return {"quantiles": {str(q): [float(x) for x in out[q]] for q in req.quantiles}}

    return app

