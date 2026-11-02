# Local services

Optional services the app can use, all off unless their variable is set (`.env.example`).
They run on this machine or the local network; nothing here goes to staging or production.

## Ollama (idea suggestions)

The app only reads `OLLAMA_URL` (and `OLLAMA_MODEL`, default `gemma3:4b`), so either way works:

| | Start | `OLLAMA_URL` | Notes |
|---|---|---|---|
| Native | `ollama serve`, then `ollama pull gemma3:4b` | `http://127.0.0.1:11434` | Uses the GPU (Metal on a Mac): the fast choice |
| Container | `pnpm dev:services` (profile `ai` of `deploy/dev.yml`) | `http://127.0.0.1:11434` | Clean machine, nothing installed; **CPU only on a Mac** (Docker has no Metal). Limited to 8 GB and 4 CPUs. Pull the model inside it: `docker exec inkledger-ollama ollama pull gemma3:4b` |
| Another machine | its own Ollama | `http://<its LAN address>:11434` | Loopback and private addresses only, unless `OLLAMA_ALLOW_PUBLIC=1` |

The Desk's chat uses `OLLAMA_CHAT_MODEL` when set (else `OLLAMA_MODEL`). A model whose
`/api/show` lists the `tools` capability (e.g. `qwen3:8b`, `llama3.1:8b`) reads the user's code by itself
with read-only tools; any other model gets automatic extracts instead (docs/work/desk.md, batch 4d).
`gemma3:4b` has no tool support.

Tried on 2 Nov 2026 with a fixed issue of this repository ("is it really solved?"):
`qwen3:4b` answered right and in the person's language, citing the fixing commit and its files;
`qwen2.5-coder:14b` and `:7b` write their tool calls as text (handled) and stop early or claim
checks they didn't run, so the chat gathers evidence first. Prefer `qwen3` (4b or larger).

Both use port 11434: run one at a time. `pnpm dev:down` stops the containers (models stay in the
`ollama-models` volume).

Measured on 2026-10-30 (native, this kind of Mac, 5 ideas with the JSON schema): `gemma3:4b` answers
in 8–12 s, every answer valid and coherent; `qwen3:4b` in 6–14 s, one answer in five degenerate
at the app's temperature (0.2). Hence the default.

## Forecast sidecar (when will I finish)

`ml/forecast/`: Mistral's Timestral behind a small HTTP API, in Python (uv). `pnpm dev:services`
builds and starts it (profile `ml`, 127.0.0.1:8601, 1 GB / 1 CPU); then `FORECAST_URL=http://127.0.0.1:8601`.

- The weights are pinned in `ml/forecast/models.lock.json` (commit and sha256 of every file) and
  downloaded on first start into the `ml-models` volume, never into the image. `/health` answers at
  once, `/ready` once the model is checked and loaded (about 15 s the first time).
- **Licence:** the weights are Modified MIT: not licensed when your company's or your employer's
  consolidated monthly revenue exceeds $20M. The inference code is Apache 2.0.
- Tests: `cd ml/forecast && uv run pytest` (no model, no network), or `docker build --target test ml/forecast`.
- `FORECAST_FAKE=1` answers without a model (CI); on the Node side `FORECAST_SIMULATOR=1` needs no sidecar at all.

Measured on 2026-10-30 (this Mac, the container): 306 MB at rest, 76 ms for 365 days → 28.

## Postgres for the e2e tests

`pnpm test:db` (127.0.0.1:54331, in memory) and `E2E_DATABASE_URL` in `.env`: see CONTRIBUTING.md.
