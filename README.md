# Elmon Analytics

Paste Solana tokens that ran. Elmon finds the wallets that got in early on several of them, sets insiders aside, and
ranks the rest the way the team judges wallets: **how many other runners they caught first, profit second**. Star the
good ones and export them.

Analysis only: no keys to sign with, no trading.

## How it fits together

```
Browser (magic-link sign-in, email allowlist)
   │
Vercel: Next.js pages + API ── reads/writes ──► Supabase Postgres
                                                     ▲
Railway: worker (npm run worker) ── claims runs ─────┘
   │ Helius (credits)     │ Jupiter + GeckoTerminal (free)
```

- The **API never calls Helius**. It queues runs and reads results. The **worker** is the only process with the Helius key
  and the only thing that spends credits.
- **Results are temporary.** A run and everything it found is deleted 24 h after its first export, or after 7 days.
- **The chain cache is permanent and shared**: parsed launches, wallet funders, exchange checks, wallet trade histories,
  token prices. Every row there is credits nobody pays twice. A rerun or an overlapping batch mostly costs "anything
  newer?" checks.
- The **watchlist** (starred wallets) is shared by the team and kept.

## Deploy

1. **Supabase**: create a project. Apply the schema with `supabase db push`, or let the worker do it on first start
   (it runs `supabase/migrations/*.sql` once each). Auth > URL configuration: add `https://<your-app>/auth/callback`
   to the redirect URLs.
2. **Worker on Fly.io** (about $3-4/month): `fly apps create elmon-worker`, then set secrets
   (`fly secrets set DATABASE_URL='<session pooler, port 5432>' DB_POOL_MAX='5' HELIUS_API_KEY='…'
   HELIUS_MONTHLY_CREDITS='…' BIRDEYE_API_KEY='…'`) and `fly deploy --ha=false` (one machine). `fly.toml` and
   `Dockerfile.worker` describe it; the build runs on Fly's servers. `fly logs` should show `worker started`.
   Railway works too (`railway.json`, same variables). On a deploy the run in hand goes back to the queue and
   continues from its last finished stage.
3. **Vercel (app)**: set `DATABASE_URL` (transaction pooler, port 6543), `NEXT_PUBLIC_SUPABASE_URL`,
   `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_SITE_URL`, `ELMON_ADMIN_EMAILS`. Do **not** set the Helius key.

### Access and admin

- **Admins** are the emails in `ELMON_ADMIN_EMAILS`. Only the environment can make someone an admin.
- **Everyone else joins with an invite code.** An admin opens **Admin → Invites**, picks uses (default 5), expiry
  (default 7 days), an optional label, and optionally one email the code is limited to, then shares the code
  (`ELMN-XXXX-XXXX`, shown once). The newcomer enters email and code on the sign-in page; a use is consumed only
  when they click the email link, so a leaked code cannot be burned with fake emails. Sign-in attempts are limited.
- **Admin tab:** invite codes (create, revoke, see who joined), members (remove: locked out at once), all runs
  (open, stop, clear anyone's), an emergency "pause new runs" switch, settings without a deploy (live runs and max
  run budget per member/admin, retention, default depth, monthly credit limit), credit usage by stage, member and
  run, and an activity log.
- **Admin extras:** higher limits (5 live runs, 200k budget by default), runs go ahead of members in the queue, and
  starting runs still works while new runs are paused.

## Local

```
npm install
cp .env.example .env.local        # HELIUS_API_KEY at least
ELMON_DEV_NO_AUTH=1 npm run dev   # http://127.0.0.1:3000
```

Without `DATABASE_URL` everything runs in one process against an in-memory database that is gone when you stop it.
With `DATABASE_URL`, run `npm run worker` in a second terminal.

Try it without a key or credits:

```
npm run demo                                                    # fake Helius on :8899, prints demo token addresses
HELIUS_RPC_URL=http://127.0.0.1:8899 ELMON_DEV_NO_AUTH=1 ELMON_DEMO_MARKET=1 npm run dev
```

CLI (same pipeline): `npm run cli -- tokens <mint> <mint> ... --set earlyBuyers=150 --label "batch 1"`

## Using it

1. **Paste tokens** (mints, or pump.fun / DexScreener / Solscan links). 5 or more is best. Pick a depth, press *Find wallets*.
   Or switch to **Paste wallets** to profile wallets you already have.
2. The run works in stages; each can resume:

   | Stage | What it does | Credits (Helius) |
   |---|---|---|
   | Launches | Each token's first trades: deployer, first N buyers, block-0 buys | ~10-50 per new token, 0 if seen before |
   | Overlap | Wallets early in 2+ of your tokens | 0 |
   | Funders | Each candidate's first transaction and first SOL; shared funders checked for exchanges | ~2-22 per new wallet |
   | Groups | Dev-linked, bundle and shared-funder groups | 0 |
   | Trades | Each candidate's recent trades, profit on **other** tokens | ~10-100 per new wallet, ~10 if seen before |
   | Runners | Which of those other tokens ran (free price data) | 0 |

3. **Traders**: the *Runners against profit* chart puts the team's two questions on one plane. Up = catches runners,
   right = makes money. Top-left is the "mad intuition, paperhands" corner. Click any wallet (or dot) for its card: a
   one-line verdict, runners caught (entry against peak), profit over time, what it did on your tokens.
4. **Insiders**: deployers and the groups around them. Insider scans are on demand: press *Scan insiders* on a token to
   trace every early buyer of that launch.
5. **Export**: starred wallets, all traders (CSV or JSON), insiders, or every early buy. Exporting starts the 24 h clock.

## How wallets are judged

- **Candidates** come from your tokens. **The ranking does not.** You pasted winners, so everyone early on them looks
  good. Both scores use only the wallet's trades on other tokens. What it did on yours is shown, not scored.
- **Runner** = a token the wallet bought at or under $300k market cap that later reached 5x its entry and $1M+
  (settings). Selling early still counts: catching it is the signal. Bigger peaks weigh more ($1M = 1, $10M = 2, ...).
- **Runner score (0-100)** = 55% weighted runners (saturating), 20% hit rate, 15% held past the conviction multiple, 10%
  how early it gets in. **Capture** = what it made against what the run offered; low capture tags *paperhands*.
- **Profit score (0-100)** = 50% net SOL (tanh around ±20 SOL) + 30% win rate + 20% median exit multiple, shrunk toward
  50 with few closed trades. PnL uses average cost; a position is closed at 99% sold; unsold bags count as zero;
  positions with unknown cost are left out.
- **Peaks** come from daily price history. GeckoTerminal is free but slow (in practice about 6-10 lookups a
  minute, about 6 months of history). With `BIRDEYE_API_KEY` set on the worker (free plan is enough), Birdeye
  (by token, about 60 a minute, up to 300 days) works alongside it and the runners stage is several times faster;
  anything Birdeye cannot answer falls back to GeckoTerminal, and a refused key or used-up quota switches Birdeye
  off for that run with a note in the log. Each run
  looks up at most *Price lookups per run* tokens, most-traded first; the rest get a lower bound (current market cap or
  the wallet's own exit) and a lower bound that fails the test counts as unknown, never as a miss.
- **Tags** are rules with their definition on hover (`lib/core/tags.ts`).

## Credits

- A run is refused before it spends anything if the batch cannot overlap, or the month does not have enough left.
  A double-clicked start returns the run already going.
- Each run has a hard budget (setting). All runs together stop at 98% of the month: workers reserve credits in blocks
  with an atomic update, so two workers can never both spend the last of it.
- Wallet histories are adaptive: 100 transactions first, deeper only when something in them made money.
- `credit_ledger` records spend per run, stage and method, for when you want to see where it went.

## Known limits

- The buyer must sign the buy. Buys made for a wallet by another signer are missed.
- Same-slot order is the order the node returns; ranks inside one slot are approximate.
- SOL spent includes fees and tips, so exits look slightly worse than on a terminal.
- Token supply for entry market cap is today's supply.
- The free price API only goes back about 6 months; older runners are judged on estimates.
- Not yet checked against the live API end to end. Before trusting results, run 3 tokens you know and compare the
  deployer, the first buyers and one wallet's PnL with Solscan.

## Development

```
npm test            # unit, property and pipeline tests (fake chain, in-process Postgres)
npm run typecheck
```

Layout: `lib/solana/tx.ts` (transaction parsing), `lib/helius.ts` (client), `lib/credits.ts` (budget),
`lib/pipeline/` (stages and the chain cache), `lib/core/` (PnL, runners, clusters, tags), `lib/worker.ts`,
`lib/auth.ts`, `supabase/migrations/` (schema), `app/` (UI and API).
# Elmon
