// Groups wallets that are probably one operator, from who funded them.
// Rules follow tracced (MIT): an exchange or app (a "service" funder) funds thousands of unrelated wallets, so its
// wallets only group when they were created in a burst; a normal funder groups everything it funded.

export interface WalletFacts {
  wallet: string;
  funder: string | null;
  funderService: boolean;
  firstTxTime: number | null; // unix seconds, wallet's first transaction ever
  mints: string[]; // pasted mints this wallet was early in
  isDeployer: boolean;
}

export type ClusterKind = "dev-linked" | "bundle" | "shared-funder";

export interface Cluster {
  id: number;
  kind: ClusterKind;
  members: string[];
  funders: string[];
  deployers: string[];
  mints: string[];
  reason: string;
}

class UnionFind {
  private parent = new Map<string, string>();
  find(x: string): string {
    if (!this.parent.has(x)) {
      this.parent.set(x, x);
      return x;
    }
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    let cur = x;
    while (cur !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  union(a: string, b: string) {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

export function buildClusters(
  facts: WalletFacts[],
  opts: { clusterMinService: number; serviceBurstMinutes: number },
): { clusters: Cluster[]; clusterOf: Map<string, number> } {
  const uf = new UnionFind();
  const inRun = new Map(facts.map((f) => [f.wallet, f]));
  for (const f of facts) uf.find(f.wallet);

  const byServiceFunder = new Map<string, WalletFacts[]>();
  for (const f of facts) {
    if (!f.funder) continue;
    if (f.funderService) {
      const list = byServiceFunder.get(f.funder) ?? [];
      list.push(f);
      byServiceFunder.set(f.funder, list);
    } else {
      uf.union(f.wallet, `funder:${f.funder}`);
      // A funder that is itself a wallet in this run joins the same group.
      if (inRun.has(f.funder)) uf.union(f.wallet, f.funder);
    }
  }
  // Service funders: only wallets created within the burst window of each other.
  const burstSec = opts.serviceBurstMinutes * 60;
  for (const [funder, list] of byServiceFunder) {
    const timed = list.filter((f) => f.firstTxTime != null).sort((a, b) => a.firstTxTime! - b.firstTxTime!);
    let group: WalletFacts[] = [];
    let burst = 0;
    const flush = () => {
      if (group.length >= opts.clusterMinService) for (const g of group) uf.union(g.wallet, `burst:${funder}:${burst}`);
      burst++;
      group = [];
    };
    for (const f of timed) {
      if (group.length && f.firstTxTime! - group[group.length - 1].firstTxTime! > burstSec) flush();
      group.push(f);
    }
    flush();
  }

  // Deployers that share a funder with each other link through the same funder node already.
  const components = new Map<string, WalletFacts[]>();
  for (const f of facts) {
    const r = uf.find(f.wallet);
    const list = components.get(r) ?? [];
    list.push(f);
    components.set(r, list);
  }

  const clusters: Cluster[] = [];
  const clusterOf = new Map<string, number>();
  let id = 1;
  const sorted = [...components.values()].filter((c) => c.length >= 2).sort((a, b) => b.length - a.length);
  for (const members of sorted) {
    const deployers = members.filter((m) => m.isDeployer).map((m) => m.wallet);
    const funders = [...new Set(members.map((m) => m.funder).filter((x): x is string => !!x))];
    const mintCount = new Map<string, number>();
    for (const m of members) for (const mint of m.mints) mintCount.set(mint, (mintCount.get(mint) ?? 0) + 1);
    const maxSameMint = Math.max(0, ...mintCount.values());
    let kind: ClusterKind;
    let reason: string;
    const viaService = members.some((m) => m.funderService);
    if (deployers.length > 0) {
      kind = "dev-linked";
      reason = `${members.length} wallets share funding with the deployer${deployers.length > 1 ? "s" : ""} of a pasted token`;
    } else if (maxSameMint >= 3) {
      kind = "bundle";
      reason = `${maxSameMint} wallets funded by one source bought the same token early`;
    } else {
      kind = "shared-funder";
      reason = `${members.length} wallets got their first SOL from the same source`;
    }
    if (viaService) reason += " (exchange or app funder, created within the same burst)";
    const c: Cluster = {
      id: id++,
      kind,
      members: members.map((m) => m.wallet),
      funders,
      deployers,
      mints: [...mintCount.keys()],
      reason,
    };
    clusters.push(c);
    for (const m of c.members) clusterOf.set(m, c.id);
  }
  return { clusters, clusterOf };
}
