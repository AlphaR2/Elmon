import { describe, expect, it } from "vitest";
import { funderFromTx, mintEvents, normalizeTx, ownerEvents, ownerSolDelta } from "@/lib/solana/tx";
import { parseLaunch } from "@/lib/pipeline/fetch";
import { buyTx, createTx, FEE, fundTx, makeTx, sellTx, SOL } from "./helpers";

const W = "Wallet1111", M = "Mint1111";

describe("owner balance changes", () => {
  it("nets ATA rent out of a buy, leaving price plus fee", () => {
    const t = normalizeTx(buyTx({ wallet: W, mint: M, sol: 1.5, tokens: 1000, slot: 1, time: 100 }))!;
    expect(ownerSolDelta(t, W)).toBe(-BigInt(1.5 * SOL + FEE));
    const [e] = ownerEvents(t, W);
    expect(e.kind).toBe("buy");
    expect(e.lamports).toBe(BigInt(1.5 * SOL + FEE));
    expect(Number(e.tokens) / 1e6).toBe(1000);
    expect(e.tokenAccount).toBe(`ata-${W}-${M}`);
  });

  it("nets the rent refund out of a closing sell", () => {
    const t = normalizeTx(sellTx({ wallet: W, mint: M, sol: 3, tokens: 1000, held: 1000, slot: 2, time: 200, close: true }))!;
    const [e] = ownerEvents(t, W);
    expect(e.kind).toBe("sell");
    expect(e.lamports).toBe(BigInt(3 * SOL - FEE));
  });

  it("reads tokens arriving without SOL as a transfer", () => {
    const raw = makeTx({
      sig: "x", slot: 1, time: 1, signers: ["Other"],
      lamports: { Other: [SOL, SOL - FEE] },
      tokens: [
        { account: "a1", owner: "Other", mint: M, pre: 5e6, post: 0 },
        { account: "a2", owner: W, mint: M, pre: 0, post: 5e6 },
      ],
    });
    const t = normalizeTx(raw)!;
    expect(ownerEvents(t, W)[0].kind).toBe("transfer_in");
    expect(ownerEvents(t, "Other")[0].kind).toBe("transfer_out");
  });

  it("skips a two-token route instead of guessing", () => {
    const raw = makeTx({
      sig: "r", slot: 1, time: 1, signers: [W],
      lamports: { [W]: [10 * SOL, 9 * SOL] },
      tokens: [
        { account: "a1", owner: W, mint: "A", pre: 0, post: 5e6 },
        { account: "a2", owner: W, mint: "B", pre: 0, post: 7e6 },
      ],
    });
    expect(ownerEvents(normalizeTx(raw)!, W)).toEqual([]);
  });

  it("ignores failed transactions", () => {
    const raw = buyTx({ wallet: W, mint: M, sol: 1, tokens: 10, slot: 1, time: 1 });
    raw.meta!.err = { x: 1 };
    expect(ownerEvents(normalizeTx(raw)!, W)).toEqual([]);
  });

  it("finds the funder as the signer with the biggest outflow", () => {
    const t = normalizeTx(fundTx({ from: "Funder", to: W, sol: 2, slot: 1, time: 1 }))!;
    expect(funderFromTx(t, W)).toBe("Funder");
    expect(funderFromTx(t, "Funder")).toBeNull();
  });

  it("handles v0 loaded addresses in json encoding", () => {
    const raw = buyTx({ wallet: W, mint: M, sol: 1, tokens: 10, slot: 1, time: 1 });
    // move the curve to the loaded list
    const keys = raw.transaction.message.accountKeys as string[];
    const idx = keys.indexOf(`curve-${M}`);
    const last = keys.length - 1;
    // swap curve to last position, then treat it as loaded
    [keys[idx], keys[last]] = [keys[last], keys[idx]];
    const pre = raw.meta!.preBalances, post = raw.meta!.postBalances;
    [pre[idx], pre[last]] = [pre[last], pre[idx]];
    [post[idx], post[last]] = [post[last], post[idx]];
    for (const b of [...raw.meta!.preTokenBalances!, ...raw.meta!.postTokenBalances!]) {
      if (b.accountIndex === idx) b.accountIndex = last;
      else if (b.accountIndex === last) b.accountIndex = idx;
    }
    const loaded = keys.pop()!;
    raw.meta!.loadedAddresses = { writable: [loaded], readonly: [] };
    const t = normalizeTx(raw)!;
    expect(t.keys).toContain(loaded);
    expect(t.lamportDelta.get(`curve-${M}`)).toBe(BigInt(SOL));
  });
});

describe("launch parsing", () => {
  it("ranks first buyers, marks the deployer and block-0, and drops the curve's side of sells", () => {
    const txs = [
      createTx({ deployer: "Dev", mint: M, slot: 10, time: 1000, devBuySol: 2 }),
      buyTx({ wallet: "A", mint: M, sol: 1, tokens: 100, slot: 10, time: 1000 }),
      buyTx({ wallet: "B", mint: M, sol: 1, tokens: 100, slot: 12, time: 1004 }),
      sellTx({ wallet: "A", mint: M, sol: 2, tokens: 100, held: 100, slot: 13, time: 1006 }),
      buyTx({ wallet: "A", mint: M, sol: 1, tokens: 50, slot: 14, time: 1008, ataExists: true }),
      buyTx({ wallet: "C", mint: M, sol: 0.5, tokens: 20, slot: 20, time: 1100 }),
    ].map((r) => normalizeTx(r)!);
    const l = parseLaunch(M, txs, 2);
    expect(l.deployer).toBe("Dev");
    expect(l.launchpad).toBe("pump.fun");
    expect(l.buys.map((b) => [b.wallet, b.rank, b.sameSlot])).toEqual([
      ["Dev", 0, true],
      ["A", 1, true],
      ["B", 2, false],
    ]);
    expect(l.buys[2].secsAfterCreate).toBe(4);
    // the curve never appears as a buyer
    expect(mintEvents(txs[3], M).some((e) => e.owner === `curve-${M}` && e.kind === "buy")).toBe(true);
    expect(l.buys.some((b) => b.wallet.startsWith("curve"))).toBe(false);
  });
});
