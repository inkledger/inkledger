// zod without its JIT in the page: it would probe `new Function` (an eval the CSP blocks and
// reports). Imported first by each entry, so it holds before any module with zod is evaluated.
(globalThis as { __zod_globalConfig?: { jitless?: boolean } }).__zod_globalConfig = { jitless: true };

export {};
