import type { OperatorInput, OperatorResult } from "./walletList.types";

export const MIN_SHARED_TOKENS = 3;
export const MIN_OVERLAP = 0.7;
export const MAX_MEDIAN_GAP_S = 10;

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Earliest buy time per mint.
function firstBuys(buys: OperatorInput["buys"]): Map<string, number> {
  const m = new Map<string, number>();
  for (const b of buys) {
    const t = m.get(b.mint);
    if (t == null || b.time < t) m.set(b.mint, b.time);
  }
  return m;
}

// Same trade signature: at least 3 shared tokens, shared >= 70% of the smaller token set, median gap between the
// two wallets' first buys of the shared tokens under 10 s.
export function sameSignature(a: Map<string, number>, b: Map<string, number>): boolean {
  const gaps: number[] = [];
  for (const [mint, t] of a) {
    const u = b.get(mint);
    if (u != null) gaps.push(Math.abs(t - u));
  }
  if (gaps.length < MIN_SHARED_TOKENS) return false;
  if (gaps.length / Math.min(a.size, b.size) < MIN_OVERLAP) return false;
  return median(gaps) < MAX_MEDIAN_GAP_S;
}

// Union-find over wallets: same cluster id OR same trade signature, merged transitively. botLike wallets are left out.
// The operator id is the smallest wallet address in the set, so it does not depend on input order.
export function buildOperators(wallets: OperatorInput[]): OperatorResult[] {
  const ws = wallets.filter((w) => !w.botLike);
  const parent = ws.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a: number, b: number) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  const sigs = ws.map((w) => firstBuys(w.buys));
  const byCluster = new Map<number, number>();
  ws.forEach((w, i) => {
    if (w.clusterId == null) return;
    const j = byCluster.get(w.clusterId);
    if (j == null) byCluster.set(w.clusterId, i);
    else union(i, j);
  });
  for (let i = 0; i < ws.length; i++) for (let j = i + 1; j < ws.length; j++) if (find(i) !== find(j) && sameSignature(sigs[i], sigs[j])) union(i, j);
  const groups = new Map<number, string[]>();
  ws.forEach((w, i) => {
    const r = find(i);
    const g = groups.get(r);
    if (g) g.push(w.wallet);
    else groups.set(r, [w.wallet]);
  });
  return [...groups.values()].map((g) => {
    const sorted = [...g].sort();
    return { operatorId: `op:${sorted[0]}`, wallets: sorted };
  });
}
