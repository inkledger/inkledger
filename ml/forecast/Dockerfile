# The forecast sidecar (docs/work/ideas/estimates.md R-3.21). The weights are never in
# the image: downloaded on first start into /models (the ml-models volume), pinned and checked.
FROM python:3.15-slim@sha256:65a65fc7b30b06cb6df4930fd4650697cb23f4c2698ab81fc87e4b031bc36928 AS build
COPY --from=ghcr.io/astral-sh/uv:0.11.7@sha256:240fb85ab0f263ef12f492d8476aa3a2e4e1e333f7d67fbdd923d00a506a516a /uv /bin/uv
# git: the inference code is pinned to a commit of its repository (needed to install it, not to run).
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_NO_CACHE=1 UV_PROJECT_ENVIRONMENT=/app/.venv UV_PYTHON_DOWNLOADS=never
COPY pyproject.toml uv.lock .python-version ./
RUN uv sync --frozen --no-dev

# The sidecar's tests (CI: `docker build --target test`): no real model, no network.
FROM build AS test
RUN uv sync --frozen
COPY models.lock.json ./
COPY src ./src
COPY tests ./tests
RUN uv run --no-sync pytest -q

FROM python:3.15-slim@sha256:65a65fc7b30b06cb6df4930fd4650697cb23f4c2698ab81fc87e4b031bc36928
WORKDIR /app
COPY --from=build /app/.venv /app/.venv
COPY models.lock.json ./
COPY src ./src
RUN useradd --uid 10001 --create-home forecast && mkdir /models && chown forecast /models
USER forecast
ENV MODELS_DIR=/models PYTHONPATH=/app/src PATH=/app/.venv/bin:$PATH
EXPOSE 8601
HEALTHCHECK --interval=10s --timeout=3s --retries=10 CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8601/health', timeout=2)"
CMD ["uvicorn", "--factory", "forecast.app:create_app", "--host", "0.0.0.0", "--port", "8601"]
