**What changes and why**

**How it was tested**
- [ ] `pnpm lint && pnpm check && pnpm test && pnpm build && pnpm test:smoke`
- [ ] `PROVIDERS_READ_ONLY=1 pnpm test:e2e` (interaction changes: a test in `e2e/`)
- [ ] `src-tauri`: `cargo fmt --check`, `clippy`, `test` (if touched)

**Notes** (migrations, contract or parity changes, anything a reviewer should know)
