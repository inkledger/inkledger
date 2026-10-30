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

Both use port 11434: run one at a time. `pnpm dev:down` stops the containers (models stay in the
`ollama-models` volume).

Measured on 2026-10-30 (native, this kind of Mac, 5 ideas with the JSON schema): `gemma3:4b` answers
in 8–12 s, every answer valid and coherent; `qwen3:4b` in 6–14 s, one answer in five degenerate
at the app's temperature (0.2). Hence the default.

## Postgres for the e2e tests

`pnpm test:db` (127.0.0.1:54331, in memory) and `E2E_DATABASE_URL` in `.env`: see CONTRIBUTING.md.
