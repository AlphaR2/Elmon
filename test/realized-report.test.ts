import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildReport, main, parseArgs, readWalletFile, ReportArgError, type HistoryLoader } from "../scripts/realized-report";
import type { OwnerEvent } from "@/lib/solana/tx";

const FROM = 1_000, SPLIT = 5_000, TO = 9_000;
let slot = 0;
const ev = (w: string, mint: string, kind: OwnerEvent["kind"], sol: number, t: number): OwnerEvent => ({
  signature: `s${++slot}`, slot, blockTime: t, owner: w, mint, kind, tokens: 1_000_000n, decimals: 6, lamports: BigInt(Math.round(sol * 1e9)), tokenAccount: "a",
});
// n round trips with a 10-minute hold; gain per trade; first trade at t0.
const trades = (w: string, tag: string, n: number, gain: number, t0: number) =>
  Array.from({ length: n }, (_, i) => [ev(w, `${tag}${i}`, "buy", 1, t0 + i * 500), ev(w, `${tag}${i}`, "sell", 1 + gain, t0 + i * 500 + 600)]).flat();

// A wallet with a pre-split record and a post-split record; each wallet trades its own tokens, so operators stay apart.
const wallet = (w: string, preGain: number, postGain: number, complete = true) => ({
  events: [...trades(w, `${w}p`, 6, preGain, FROM + 10), ...trades(w, `${w}q`, 4, postGain, SPLIT + 10)],
  complete,
});
function loaderOf(m: Record<string, { events: OwnerEvent[]; complete: boolean }>): HistoryLoader & { calls: number } {
  const fn = (async (w: string) => m[w] ?? null) as HistoryLoader & { calls: number };
  fn.calls = 0;
  return fn;
}
afterEach(() => vi.restoreAllMocks());

describe("realized report", () => {
  const cands = Array.from({ length: 12 }, (_, i) => `C${i}`);
  const ctrl = Array.from({ length: 22 }, (_, i) => `K${i}`);
  const histories = () => {
    const m: Record<string, ReturnType<typeof wallet>> = {};
    cands.forEach((c, i) => (m[c] = wallet(c, 0.3 + i / 100, i < 11 ? 0.2 : -0.2)));
    ctrl.forEach((c, i) => (m[c] = wallet(c, 0.3 + i / 100, i < 4 ? 0.2 : -0.2)));
    return m;
  };

  it("uses one window for both sides, the control never holds a candidate, and the fetch is never called", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await buildReport({ candidates: cands, control: [...ctrl, "C3"], from: FROM, to: TO, splitAt: SPLIT, load: loaderOf(histories()) });
    vi.unstubAllGlobals();
    expect(res.candidates.window).toEqual(res.control.window);
    expect(res.removedFromControl).toBe(1);
    expect(res.control.ranked.some((r) => cands.includes(r.wallet))).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(0);
    expect(res.verdict.verdict).toBe("passes");
    expect(res.markdown).toContain("0 credits");
    expect(res.markdown).toContain("| operators |");
    expect(res.candidates.steps.map((s) => s.label)).toEqual(["listed", "with saved history", "covering the window", "at least 5 closed", "not bot", "not top-trade", "operators"]);
  });

  it("is the same whether or not older events exist before the window", async () => {
    const withOld = histories();
    for (const w of cands) withOld[w] = { ...withOld[w], events: [...Array.from({ length: 8 }, (_, i) => [ev(w, `old${i}`, "buy", 1, 10 + i), ev(w, `old${i}`, "sell", 6, 100 + i)]).flat(), ...withOld[w].events] };
    const a = await buildReport({ candidates: cands, control: ctrl, from: FROM, to: TO, splitAt: SPLIT, load: loaderOf(histories()) });
    const b = await buildReport({ candidates: cands, control: ctrl, from: FROM, to: TO, splitAt: SPLIT, load: loaderOf(withOld) });
    expect(b.markdown).toBe(a.markdown);
  });

  it("drops wallets whose incomplete history does not reach the window, on both sides, and counts them", async () => {
    const m = histories();
    m.C0 = { ...m.C0, complete: false, events: m.C0.events.filter((e) => (e.blockTime ?? 0) > FROM + 100) };
    m.K0 = { ...m.K0, complete: false, events: m.K0.events.filter((e) => (e.blockTime ?? 0) > FROM + 100) };
    const res = await buildReport({ candidates: cands, control: ctrl, from: FROM, to: TO, splitAt: SPLIT, load: loaderOf(m) });
    expect(res.candidates.steps.find((s) => s.label === "covering the window")!.n).toBe(11);
    expect(res.control.steps.find((s) => s.label === "covering the window")!.n).toBe(21);
  });

  it("counts a sock-puppet group as one operator, so ten wallets are not ten operators", async () => {
    const m: Record<string, ReturnType<typeof wallet>> = {};
    const puppets = Array.from({ length: 10 }, (_, i) => `P${i}`);
    puppets.forEach((p, i) => {
      // identical tokens, buys within seconds of each other
      m[p] = { complete: true, events: [...trades(p, "shared", 6, 0.4, FROM + 10 + i), ...trades(p, "after", 4, 0.2, SPLIT + 10)] };
    });
    // same token names across puppets: events use the same mint strings
    const res = await buildReport({ candidates: puppets, control: ctrl, from: FROM, to: TO, splitAt: SPLIT, load: loaderOf({ ...histories(), ...m }) });
    expect(res.candidates.ranked).toHaveLength(10);
    expect(res.candidates.outcomes).toHaveLength(1);
    expect(res.verdict.verdict).toBe("fewer than 10 independent operators");
  });

  it("rejects a bad time order and bad arguments", async () => {
    await expect(buildReport({ candidates: [], control: [], from: 5, to: 4, splitAt: 3, load: loaderOf({}) })).rejects.toThrow(/--from < --split-at < --to/);
    expect(() => parseArgs(["--nope", "x"])).toThrow(ReportArgError);
    expect(() => parseArgs(["--candidates", "a", "--control", "b", "--from", "-1", "--to", "2", "--split-at", "1"])).toThrow(/--from/);
    expect(() => parseArgs(["--candidates", "a", "--control", "b", "--from", "1", "--to", "3", "--split-at", "2", "--exclude-mints", "=cmd()"])).toThrow(/mint/);
    expect(() => parseArgs(["--candidates"])).toThrow(/needs a value/);
  });

  it("main exits non-zero on bad arguments without touching the database", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await main(["--bogus", "1"])).toBe(1);
    expect(err).toHaveBeenCalled();
  });

  it("prints no secret from the environment", async () => {
    vi.stubEnv("HELIUS_API_KEY", "SECRETKEY-do-not-leak-0123456789");
    const res = await buildReport({ candidates: cands, control: ctrl, from: FROM, to: TO, splitAt: SPLIT, load: loaderOf(histories()) });
    vi.unstubAllEnvs();
    expect(res.markdown).not.toContain("SECRETKEY");
  });

  it("readWalletFile accepts addresses and comments, rejects junk", () => {
    const f = path.join(os.tmpdir(), `wl-${process.pid}.txt`);
    fs.writeFileSync(f, "# note\n11111111111111111111111111111112\n");
    expect(readWalletFile(f)).toEqual(["11111111111111111111111111111112"]);
    fs.writeFileSync(f, "=HYPERLINK(1)\n");
    expect(() => readWalletFile(f)).toThrow(/not a wallet address/);
    fs.unlinkSync(f);
  });
});
