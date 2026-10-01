import { describe, expect, it } from "vitest";
import { buildClusters, type WalletFacts } from "@/lib/core/clusters";
import { computeTags } from "@/lib/core/tags";

const f = (wallet: string, funder: string | null, extra: Partial<WalletFacts> = {}): WalletFacts => ({
  wallet, funder, funderService: false, firstTxTime: 0, mints: [], isDeployer: false, ...extra,
});
const opts = { clusterMinService: 3, serviceBurstMinutes: 30 };

describe("clusters", () => {
  it("groups wallets that share a normal funder", () => {
    const { clusters, clusterOf } = buildClusters([f("A", "F"), f("B", "F"), f("C", "G")], opts);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].kind).toBe("shared-funder");
    expect(clusterOf.get("A")).toBe(clusterOf.get("B"));
    expect(clusterOf.has("C")).toBe(false);
  });

  it("links the deployer's wallets as dev-linked, including a wallet funded by the deployer", () => {
    const { clusters } = buildClusters([f("Dev", "F", { isDeployer: true }), f("A", "F"), f("B", "Dev")], opts);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].kind).toBe("dev-linked");
    expect(clusters[0].members.sort()).toEqual(["A", "B", "Dev"]);
  });

  it("calls 3+ same-funder wallets on one token a bundle", () => {
    const { clusters } = buildClusters(["A", "B", "C"].map((w) => f(w, "F", { mints: ["M1"] })), opts);
    expect(clusters[0].kind).toBe("bundle");
  });

  it("only groups exchange-funded wallets created in a burst", () => {
    const h = 3600;
    const { clusters } = buildClusters(
      [
        f("A", "CEX", { funderService: true, firstTxTime: 0 }),
        f("B", "CEX", { funderService: true, firstTxTime: 600 }),
        f("C", "CEX", { funderService: true, firstTxTime: 1200 }),
        f("D", "CEX", { funderService: true, firstTxTime: 10 * h }),
        f("E", "CEX", { funderService: true, firstTxTime: 20 * h }),
      ],
      opts,
    );
    expect(clusters).toHaveLength(1);
    expect(clusters[0].members.sort()).toEqual(["A", "B", "C"]);
  });

  it("does not group two unrelated exchange customers", () => {
    const { clusters } = buildClusters(
      [f("A", "CEX", { funderService: true, firstTxTime: 0 }), f("B", "CEX", { funderService: true, firstTxTime: 99 * 86400 })],
      opts,
    );
    expect(clusters).toHaveLength(0);
  });
});

describe("tags", () => {
  const base = {
    isDeployer: false, clusterKind: null, sameSlot: false, minSecsAfterCreate: null, firstBuyTime: null,
    firstTxTime: null, firstTxExact: false, funderService: false, txsPerDay: null, botLike: null, scored: null,
  } as const;
  const s = { sniperSeconds: 10, freshHours: 24 };
  it("applies each rule", () => {
    expect(computeTags({ ...base, sameSlot: true }, s)).toEqual(["block-0"]);
    expect(computeTags({ ...base, minSecsAfterCreate: 5 }, s)).toEqual(["sniper"]);
    expect(computeTags({ ...base, firstTxExact: true, firstTxTime: 0, firstBuyTime: 3600 }, s)).toEqual(["fresh"]);
    expect(computeTags({ ...base, firstTxExact: false, firstTxTime: 0, firstBuyTime: 3600 }, s)).toEqual([]);
    expect(computeTags({ ...base, isDeployer: true, sameSlot: true, clusterKind: "dev-linked" }, s)).toEqual(["dev"]);
    expect(computeTags({ ...base, clusterKind: "dev-linked" }, s)).toEqual(["dev-linked"]);
    expect(computeTags({ ...base, scored: false, botLike: true }, s)).toEqual(["bot-like", "thin-history"]);
  });
});
