"""Quantile forecasts: Timestral, or a deterministic stand-in (FORECAST_FAKE=1) for tests."""

from __future__ import annotations

from pathlib import Path
from typing import Protocol

import numpy as np


class Forecaster(Protocol):
    def forecast(
        self, series: np.ndarray, horizon: int, quantiles: list[float], past: dict[str, np.ndarray], known: dict[str, np.ndarray]
    ) -> dict[float, np.ndarray]: ...


class FakeForecaster:
    """The mean of the last week (or the last value), ±30% around the median: the same answer every time."""

    def forecast(self, series, horizon, quantiles, past, known):
        recent = series[-7:]
        recent = recent[~np.isnan(recent)]
        base = float(recent.mean()) if recent.size else 0.0
        return {q: np.full(horizon, base * (0.7 + 0.6 * q)) for q in quantiles}


class TimestralForecaster:
    """The pinned model, loaded from its verified folder (never from the Hub cache)."""

    def __init__(self, folder: Path) -> None:
        import timestral  # torch is heavy: imported only for the real model

        self._model = timestral.TimestralForecaster.from_pretrained(str(folder), device="cpu")

    def forecast(self, series, horizon, quantiles, past, known):
        kwargs = {}
        if past:
            kwargs["past_covariates"] = np.stack(list(past.values()))[None]
        if known:
            kwargs["known_covariates"] = np.stack(list(known.values()))[None]
        out = self._model.forecast(series[None, None, :], prediction_length=horizon, **kwargs)
        levels = np.asarray(out.quantile_levels, dtype=float)
        grid = np.asarray(out.quantiles)[0, 0]  # (horizon, levels)
        # Asked levels between the model's 21: interpolated per day.
        return {q: np.array([np.interp(q, levels, day) for day in grid]) for q in quantiles}
