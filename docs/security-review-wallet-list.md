# Security review: wallet list (p7, Widow, read-only)

Verdict: no blockers, no majors. Two minor findings, both fixed in `scripts/realized-report.ts` (`readWalletFile`: address check, 5000-wallet cap; test in `test/realized-report.test.ts`).

| Item | Result | Evidence |
|---|---|---|
| p7.1 auth | pass | export, run and wallet routes call `guard()` then `ownRun` (directly, or inside `walletDetail`, `lib/queries.ts:240`); `git status --short app/api` empty; new columns only in `exportRows`/`runDetail` |
| p7.2 schema | pass | `git status --short lib/migrate.ts supabase` empty; data only in `wallets.stats` and `runs.progress.walletList` |
| p7.3 admin CLI | pass | `grep -rn "realized-report\|live-check" app lib` empty; `wallet_history` has no owner column (`supabase/migrations/20260930000000_init.sql:78-88`), so the script must stay out of `app/` and `lib/` |
| p7.4 key | pass | `requireHeliusUrl()` first, `redact()` on reports and errors; `.next/static` matches are variable names only; no new env var |
| p7.5 package | pass | one added script line; lockfile untouched |
| p7.6 input/CSV | pass | option allow-list, integer checks, mint regex; `toCsv` escapes `= + - @`; operator ids derive from addresses |

Not verified: no real key was present, so the bundle check proves only no key-shaped string; `guard()` itself was not reviewed (unchanged).
