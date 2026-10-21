import { describe, expect, it } from "vitest";
import { walletListVerdict, wilson } from "@/lib/core/verdict";
import type { OperatorOutcome } from "@/lib/core/walletList.types";

const outcomes = (n: number, successes: number, prefix = "o"): OperatorOutcome[] =>
  Array.from({ length: n }, (_, i) => ({ operatorId: `${prefix}${i}`, heldOutNetSol: i < successes ? 1 : -1, heldOutClosed: 3, success: i < successes }));

describe("wilson", () => {
  it("matches known values", () => {
    const w = wilson(5, 10);
    expect(w.lo).toBeCloseTo(0.237, 3);
    expect(w.hi).toBeCloseTo(0.763, 3);
    expect(w.rate).toBe(0.5);
  });
  it("stays inside [0,1] at the edges and is empty for n = 0", () => {
    expect(wilson(0, 10).lo).toBe(0);
    expect(wilson(10, 10).hi).toBe(1);
    expect(wilson(0, 0)).toEqual({ n: 0, successes: 0, rate: null, lo: null, hi: null });
  });
});

describe("walletListVerdict", () => {
  it("fewer than 10 operators, however good", () => {
    expect(walletListVerdict(outcomes(9, 9), outcomes(40, 4)).verdict).toBe("fewer than 10 independent operators");
  });
  it("counts operators, not wallets: ten wallets of one operator is one", () => {
    // ten wallets collapsed upstream into one operator outcome
    expect(walletListVerdict(outcomes(1, 1), outcomes(40, 4)).verdict).toBe("fewer than 10 independent operators");
  });
  it("control missing or too small", () => {
    expect(walletListVerdict(outcomes(12, 12), []).verdict).toBe("control missing or too small");
    expect(walletListVerdict(outcomes(12, 12), outcomes(19, 1)).verdict).toBe("control missing or too small");
  });
  it("no better than control when the lower bound does not clear the control rate", () => {
    expect(walletListVerdict(outcomes(10, 6), outcomes(20, 10)).verdict).toBe("no better than control");
  });
  it("passes only when 10+ operators, 20+ control and the Wilson lower bound beats the control rate", () => {
    const r = walletListVerdict(outcomes(30, 27), outcomes(40, 8));
    expect(r.verdict).toBe("passes");
    expect(r.candidate.lo!).toBeGreaterThan(r.control.rate!);
  });
});
