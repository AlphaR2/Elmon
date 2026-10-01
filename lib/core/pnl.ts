import type { OwnerEvent } from "../solana/tx";

// Position accounting, following tracced's published method (MIT): average cost, a position is closed once 99%
// is sold, and a position whose cost is unknown (tokens arrived by transfer, or sold before any buy we saw) is
// excluded rather than counted as profit.

export type PositionStatus = "closed" | "open" | "excluded";

export interface Position {
  mint: string;
  status: PositionStatus;
  excludedReason?: "transfer-in" | "sold-before-buy" | "transferred-out";
  firstBuy: number | null; // unix seconds
  lastSell: number | null;
  buys: number;
  sells: number;
  spentSol: number;
  proceedsSol: number;
  boughtTokens: number; // ui units
  pnlSol: number; // proceeds - spent (unsold tokens valued at zero)
  realizedSol: number; // average-cost profit on the tokens actually sold
  multiple: number | null; // proceeds / spent, closed positions only
  holdMinutes: number | null;
  soldPct: number;
  buyTimes: number[];
  sellTimes: number[];
}

const CLOSED_AT = 0.99;

export function buildPositions(events: OwnerEvent[]): Position[] {
  const byMint = new Map<string, OwnerEvent[]>();
  for (const e of events) {
    const list = byMint.get(e.mint);
    if (list) list.push(e);
    else byMint.set(e.mint, [e]);
  }
  const out: Position[] = [];
  for (const [mint, evs] of byMint) {
    evs.sort((a, b) => (a.slot - b.slot) || ((a.blockTime ?? 0) - (b.blockTime ?? 0)));
    let qty = 0, cost = 0, bought = 0, sold = 0, transferredOut = 0;
    let spent = 0, proceeds = 0, realized = 0;
    let buys = 0, sells = 0;
    let transferIn = false, soldBeforeBuy = false;
    let firstBuy: number | null = null, lastSell: number | null = null;
    const buyTimes: number[] = [], sellTimes: number[] = [];
    for (const e of evs) {
      const t = Number(e.tokens) / 10 ** e.decimals;
      const sol = Number(e.lamports) / 1e9;
      const ts = e.blockTime ?? 0;
      switch (e.kind) {
        case "buy":
          qty += t; cost += sol; bought += t; spent += sol; buys++;
          if (firstBuy == null) firstBuy = ts;
          buyTimes.push(ts);
          break;
        case "transfer_in":
          transferIn = true;
          qty += t;
          break;
        case "sell": {
          sells++;
          sellTimes.push(ts);
          lastSell = ts;
          if (qty <= 0) { soldBeforeBuy = true; break; }
          const s = Math.min(t, qty);
          const p = sol * (s / t);
          const c = cost * (s / qty);
          if (t > s * 1.001) soldBeforeBuy = true; // sold more than we saw bought
          realized += p - c; proceeds += p; sold += s; qty -= s; cost -= c;
          break;
        }
        case "transfer_out": {
          if (qty <= 0) break;
          const s = Math.min(t, qty);
          cost -= cost * (s / qty); qty -= s; transferredOut += s;
          break;
        }
      }
    }
    if (buys === 0 && sells === 0) continue; // transfers only: not a trade
    let status: PositionStatus;
    let excludedReason: Position["excludedReason"];
    if (transferIn) { status = "excluded"; excludedReason = "transfer-in"; }
    else if (soldBeforeBuy || bought === 0) { status = "excluded"; excludedReason = "sold-before-buy"; }
    else if (transferredOut > 0.5 * bought) { status = "excluded"; excludedReason = "transferred-out"; }
    else if (sold + transferredOut >= CLOSED_AT * bought) status = "closed";
    else status = "open";
    out.push({
      mint, status, excludedReason, firstBuy, lastSell, buys, sells,
      spentSol: spent, proceedsSol: proceeds, boughtTokens: bought, pnlSol: proceeds - spent, realizedSol: realized,
      multiple: status === "closed" && spent > 0 ? proceeds / spent : null,
      holdMinutes: status === "closed" && firstBuy != null && lastSell != null ? (lastSell - firstBuy) / 60 : null,
      soldPct: bought > 0 ? Math.min(1, sold / bought) : 0,
      buyTimes, sellTimes,
    });
  }
  return out;
}

export interface TraderStats {
  txsRead: number;
  windowStart: number | null;
  windowEnd: number | null;
  windowDays: number;
  positions: number; // judged positions (not excluded, not too new)
  closed: number;
  open: number;
  excluded: number;
  wins: number;
  winRate: number | null;
  netSol: number; // proceeds - spent over judged positions, unsold valued at zero (conservative)
  closedPnlSol: number;
  realizedSol: number;
  spentSol: number;
  medianMultiple: number | null;
  bigWinShare: number | null; // closed positions exited at 2x or better
  medianHoldMin: number | null;
  avgBuySol: number | null;
  tradesPerDay: number | null;
  botLike: boolean;
  lastTradeTime: number | null;
  profitableWeeksShare: number | null; // weeks with net-positive closed trades, out of weeks with any
  maxDrawdownSol: number; // worst peak-to-trough fall of cumulative closed PnL
  pnlCurve: [number, number][]; // [time, cumulative closed PnL], for charts
  best: { mint: string; pnlSol: number; multiple: number | null } | null;
  worst: { mint: string; pnlSol: number; multiple: number | null } | null;
  top: Pick<Position, "mint" | "status" | "pnlSol" | "multiple" | "spentSol" | "proceedsSol" | "holdMinutes" | "firstBuy">[];
}

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Bot rule from tracced (MIT): 30+ trades with a median hold under 2 min, or 5+ buy->sell pairs within 5 s.
export function isBotLike(positions: Position[]): boolean {
  let trades = 0, quickPairs = 0;
  const holds: number[] = [];
  for (const p of positions) {
    trades += p.buys + p.sells;
    const buys = [...p.buyTimes].sort((a, b) => a - b);
    for (const s of p.sellTimes) {
      let prev: number | null = null;
      for (const b of buys) if (b <= s) prev = b;
      if (prev != null) {
        holds.push((s - prev) / 60);
        if (s - prev <= 5) quickPairs++;
      }
    }
  }
  const mh = median(holds);
  return (trades >= 30 && mh != null && mh < 2) || quickPairs >= 5;
}

export function traderStats(
  events: OwnerEvent[],
  opts: { excludeMints?: Set<string>; now: number; openGraceHours: number; txsRead: number },
): TraderStats {
  const all = buildPositions(events).filter((p) => !opts.excludeMints?.has(p.mint));
  const times = events.map((e) => e.blockTime).filter((t): t is number => t != null);
  const windowStart = times.length ? Math.min(...times) : null;
  const windowEnd = times.length ? Math.max(...times) : null;
  const windowDays = windowStart != null && windowEnd != null ? Math.max((windowEnd - windowStart) / 86400, 1 / 24) : 0;
  const graceCut = opts.now - opts.openGraceHours * 3600;
  const excluded = all.filter((p) => p.status === "excluded");
  // Positions opened too recently to judge are left out unless already closed.
  const judged = all.filter((p) => p.status !== "excluded" && (p.status === "closed" || (p.firstBuy ?? 0) <= graceCut));
  const closed = judged.filter((p) => p.status === "closed");
  const open = judged.filter((p) => p.status === "open");
  const wins = closed.filter((p) => p.pnlSol > 0).length;
  const multiples = closed.map((p) => p.multiple).filter((m): m is number => m != null);
  const holds = closed.map((p) => p.holdMinutes).filter((h): h is number => h != null);
  const spent = judged.reduce((a, p) => a + p.spentSol, 0);
  const buys = judged.reduce((a, p) => a + p.buys, 0);
  const trades = all.reduce((a, p) => a + p.buys + p.sells, 0);
  const sortedByPnl = [...judged].sort((a, b) => b.pnlSol - a.pnlSol);
  const pick = (p?: Position) => (p ? { mint: p.mint, pnlSol: p.pnlSol, multiple: p.multiple } : null);
  return {
    txsRead: opts.txsRead,
    windowStart, windowEnd, windowDays,
    positions: judged.length,
    closed: closed.length,
    open: open.length,
    excluded: excluded.length,
    wins,
    winRate: closed.length ? wins / closed.length : null,
    netSol: judged.reduce((a, p) => a + p.pnlSol, 0),
    closedPnlSol: closed.reduce((a, p) => a + p.pnlSol, 0),
    realizedSol: judged.reduce((a, p) => a + p.realizedSol, 0),
    spentSol: spent,
    medianMultiple: median(multiples),
    bigWinShare: multiples.length ? multiples.filter((m) => m >= 2).length / multiples.length : null,
    medianHoldMin: median(holds),
    avgBuySol: buys ? spent / buys : null,
    tradesPerDay: windowDays ? trades / windowDays : null,
    botLike: isBotLike(all),
    lastTradeTime: windowEnd,
    ...consistency(closed),
    best: pick(sortedByPnl[0]),
    worst: pick(sortedByPnl[sortedByPnl.length - 1]),
    top: [...judged]
      .sort((a, b) => Math.abs(b.pnlSol) - Math.abs(a.pnlSol))
      .slice(0, 40)
      .map(({ mint, status, pnlSol, multiple, spentSol, proceedsSol, holdMinutes, firstBuy }) => ({ mint, status, pnlSol, multiple, spentSol, proceedsSol, holdMinutes, firstBuy })),
  };
}

// Absolute 0-100 score so runs are comparable. Components (shown in the UI):
//   profit  = (tanh(netSol / 20) + 1) / 2         net SOL made, saturating around +-40 SOL
//   winRate = closed winners / closed
//   exits   = clamp(log2(median multiple) / 6 + 0.5)   1x -> 0.5, 8x -> 1.0
// raw = 50% profit + 30% winRate + 20% exits, then shrunk toward 50 for small samples: n / (n + 5).
export function traderScore(s: TraderStats, minClosed: number): number | null {
  if (s.closed < minClosed || s.winRate == null) return null;
  const profit = (Math.tanh(s.netSol / 20) + 1) / 2;
  const exits = s.medianMultiple && s.medianMultiple > 0 ? Math.min(1, Math.max(0, Math.log2(s.medianMultiple) / 6 + 0.5)) : 0;
  const raw = 100 * (0.5 * profit + 0.3 * s.winRate + 0.2 * exits);
  const n = s.closed;
  return Math.round((50 + (raw - 50) * (n / (n + 5))) * 10) / 10;
}

// Week-by-week consistency and the worst losing stretch, from closed positions in order of their last sell.
function consistency(closed: Position[]): Pick<TraderStats, "profitableWeeksShare" | "maxDrawdownSol" | "pnlCurve"> {
  const byTime = closed.filter((p) => p.lastSell != null).sort((a, b) => a.lastSell! - b.lastSell!);
  const weeks = new Map<number, number>();
  for (const p of byTime) {
    const w = Math.floor(p.lastSell! / (7 * 86400));
    weeks.set(w, (weeks.get(w) ?? 0) + p.pnlSol);
  }
  let cum = 0, peak = 0, dd = 0;
  const curve: [number, number][] = [];
  for (const p of byTime) {
    cum += p.pnlSol;
    peak = Math.max(peak, cum);
    dd = Math.max(dd, peak - cum);
    curve.push([p.lastSell!, cum]);
  }
  // Keep the chart light: at most 150 points, always including the last.
  const step = Math.ceil(curve.length / 150);
  const thin = step > 1 ? curve.filter((_, i) => i % step === 0 || i === curve.length - 1) : curve;
  return {
    profitableWeeksShare: weeks.size ? [...weeks.values()].filter((v) => v > 0).length / weeks.size : null,
    maxDrawdownSol: dd,
    pnlCurve: thin,
  };
}
