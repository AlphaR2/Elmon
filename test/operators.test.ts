import { describe, expect, it } from "vitest";
import { buildOperators } from "@/lib/core/operators";
import type { OperatorInput } from "@/lib/core/walletList.types";

const buys = (mints: string[], t0: number, step = 100) => mints.map((mint, i) => ({ mint, time: t0 + i * step }));
const w = (wallet: string, b: OperatorInput["buys"], o: Partial<OperatorInput> = {}): OperatorInput => ({ wallet, clusterId: null, botLike: false, buys: b, ...o });
const opOf = (r: ReturnType<typeof buildOperators>, wallet: string) => r.find((o) => o.wallets.includes(wallet))?.operatorId;

describe("buildOperators", () => {
  it("collapses sock puppets: shared tokens bought within seconds", () => {
    const m = ["A", "B", "C", "D"];
    const r = buildOperators([w("P1", buys(m, 1000)), w("P2", buys(m, 1003)), w("P3", buys(m, 1006)), w("Z", buys(["X", "Y", "Q", "R"], 1000))]);
    expect(opOf(r, "P1")).toBe(opOf(r, "P2"));
    expect(opOf(r, "P2")).toBe(opOf(r, "P3")); // transitive
    expect(opOf(r, "Z")).not.toBe(opOf(r, "P1"));
    expect(r).toHaveLength(2);
  });

  it("keeps independent wallets apart: same tokens but minutes apart", () => {
    const m = ["A", "B", "C", "D"];
    expect(buildOperators([w("P1", buys(m, 1000)), w("P2", buys(m, 1600))])).toHaveLength(2);
  });

  it("does not merge on fewer than 3 shared tokens", () => {
    expect(buildOperators([w("P1", buys(["A", "B"], 1000)), w("P2", buys(["A", "B"], 1001))])).toHaveLength(2);
  });

  it("merges at full overlap but not under 70% of the smaller set", () => {
    const at = (mints: string[]) => mints.map((mint) => ({ mint, time: 1000 })); // all buys in the same second
    expect(buildOperators([w("S", at(["A", "B", "C"])), w("T", at(["A", "B", "C", "D", "E", "F", "G"]))])).toHaveLength(1); // 3/3
    const small = at(["A", "B", "C", "H", "I", "J", "K", "L", "M", "N"]);
    const other = at(["A", "B", "C", "D", "E", "F", "G", "O", "P", "Q"]);
    expect(buildOperators([w("S", small), w("T", other)])).toHaveLength(2); // 3/10 = 30%
  });

  it("merges wallets in one cluster regardless of trades", () => {
    const r = buildOperators([w("C1", [], { clusterId: 7 }), w("C2", buys(["A"], 5), { clusterId: 7 }), w("C3", [], { clusterId: 8 })]);
    expect(opOf(r, "C1")).toBe(opOf(r, "C2"));
    expect(opOf(r, "C3")).not.toBe(opOf(r, "C1"));
  });

  it("excludes botLike wallets from the operators", () => {
    const r = buildOperators([w("B", buys(["A", "B", "C"], 0), { botLike: true }), w("N", buys(["A", "B", "C"], 1))]);
    expect(r.flatMap((o) => o.wallets)).toEqual(["N"]);
  });

  it("is independent of input order", () => {
    const m = ["A", "B", "C"];
    const ws = [w("P1", buys(m, 1000)), w("P2", buys(m, 1002)), w("Z", buys(["X"], 9))];
    const key = (r: ReturnType<typeof buildOperators>) => r.map((o) => `${o.operatorId}:${o.wallets.join(",")}`).sort();
    expect(key(buildOperators([...ws].reverse()))).toEqual(key(buildOperators(ws)));
  });
});
