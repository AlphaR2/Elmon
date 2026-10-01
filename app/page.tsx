"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { DEFAULT_SETTINGS, estimateCredits, PRESETS, SETTING_HELP, type PresetName, type RunMode, type RunSettings } from "@/lib/settings";
import { parseAddresses, short } from "@/lib/format";
import { Button, Hint, KindBadge, Panel, Segmented, Spinner } from "./components/ui";
import type { Classified } from "@/lib/classify";
import { RunsList } from "./components/RunsList";
import { useMe } from "./components/Shell";

const RECOMMENDED = 5;

const STEPS: Record<RunMode, { t: string; d: string }[]> = {
  tokens: [
    { t: "Launches", d: "Reads each token from its first trade: the deployer and the first buyers." },
    { t: "Overlap", d: "Keeps the wallets that were early in several of your tokens." },
    { t: "Runners", d: "Checks how many other tokens each wallet caught early before they ran." },
    { t: "Profit", d: "Scores what they actually made, leaving your tokens out." },
  ],
  wallets: [
    { t: "History", d: "Reads each wallet's recent trades." },
    { t: "Runners", d: "Counts the tokens it caught early before they ran." },
    { t: "Profit", d: "Scores what it actually made." },
  ],
};

// Rough time: launches ~2 s each, history ~3 s per wallet page, price lookups ~2.2 s each (free API).
function estimateMinutes(mode: RunMode, n: number, s: RunSettings): [number, number] {
  const hist = (mode === "tokens" ? s.historyTopK : n) * (s.adaptiveHistory ? 2 : Math.ceil(s.historyMaxTxs / 100) * 1.2);
  const lo = (mode === "tokens" ? n * 2 : 0) + hist + Math.min(s.peakLookups, 40) * 2.2;
  const hi = (mode === "tokens" ? n * 6 : 0) + hist * 2 + s.peakLookups * 2.4;
  return [Math.max(1, Math.round(lo / 60)), Math.max(2, Math.round(hi / 60))];
}

export default function NewAnalysis() {
  const router = useRouter();
  const me = useMe();
  const [mode, setMode] = useState<RunMode>("tokens");
  const [text, setText] = useState("");
  const [label, setLabel] = useState("");
  const [preset, setPreset] = useState<PresetName>("balanced");
  const [overrides, setOverrides] = useState<Partial<RunSettings>>({});
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Start on the admin's default depth (once, unless the user already picked one).
  const [pickedPreset, setPickedPreset] = useState(false);
  useEffect(() => {
    if (me && !pickedPreset) setPreset(me.defaultPreset);
  }, [me, pickedPreset]);
  // The run budget never exceeds what this account may spend per run (set by the admin).
  const settings: RunSettings = useMemo(() => {
    const s = { ...DEFAULT_SETTINGS, ...PRESETS[preset].settings, ...overrides };
    return me ? { ...s, runBudget: Math.min(s.runBudget, me.maxBudget) } : s;
  }, [preset, overrides, me]);
  const parsed = useMemo(() => parseAddresses(text), [text]);
  const n = parsed.valid.length;

  // Token or wallet, checked while you paste (free public sources, debounced). Results are remembered per address.
  const [kinds, setKinds] = useState<Record<string, Classified>>({});
  const [checking, setChecking] = useState(false);
  const validKey = parsed.valid.join(",");
  useEffect(() => {
    const todo = parsed.valid.filter((a) => !kinds[a]);
    if (todo.length === 0) return;
    const t = setTimeout(async () => {
      setChecking(true);
      try {
        const r = await fetch("/api/classify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ addresses: todo.slice(0, 200) }) });
        if (r.ok) {
          const got = (await r.json()) as Record<string, Classified>;
          setKinds((k) => ({ ...k, ...got }));
        }
      } catch {
        // the check is a hint; the run itself does not depend on it
      } finally {
        setChecking(false);
      }
    }, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [validKey]);
  const kindOf = (a: string) => kinds[a]?.kind ?? "unknown";
  const notTokens = parsed.valid.filter((a) => ["wallet", "empty", "token-account", "program", "other"].includes(kindOf(a)));
  const notWallets = parsed.valid.filter((a) => ["token", "token-account", "program"].includes(kindOf(a)));
  const mismatch = mode === "tokens" ? notTokens : notWallets;
  const allWrongKind = mismatch.length > 0 && mismatch.length === n;
  // Offer the other mode only when every address fits it.
  const otherModeFits =
    mode === "tokens" ? parsed.valid.every((a) => ["wallet", "empty"].includes(kindOf(a))) : parsed.valid.every((a) => kindOf(a) === "token");
  const est = useMemo(() => estimateCredits(mode, n, settings), [mode, n, settings]);
  const mins = estimateMinutes(mode, n, settings);
  const minTokens = Math.max(2, settings.minHits);
  const tooFew = mode === "tokens" && n < minTokens;
  const lowCredits = me != null && n > 0 && me.creditsLeft < est.low;
  const canStart = n > 0 && parsed.invalid.length === 0 && !tooFew && !lowCredits && !busy;

  const remove = (a: string) => setText(parsed.valid.filter((x) => x !== a).join("\n"));

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, inputs: parsed.valid, settings, label }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to start");
      router.push(`/runs/${body.id}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  const readiness =
    mode === "wallets"
      ? n === 0
        ? { tone: "text-faint", text: "Paste wallet addresses to profile them" }
        : { tone: "text-good", text: `${n} wallet${n === 1 ? "" : "s"} ready` }
      : n === 0
        ? { tone: "text-faint", text: `Paste ${RECOMMENDED} or more tokens that ran` }
        : n < minTokens
          ? { tone: "text-warn", text: `Add ${minTokens - n} more: wallets are found by being early in several tokens` }
          : n < RECOMMENDED
            ? { tone: "text-warn", text: `${n} tokens: works, but ${RECOMMENDED}+ finds far more overlap` }
            : { tone: "text-good", text: `${n} tokens, good to go` };

  const setOverride = (k: keyof RunSettings, v: string | boolean) =>
    setOverrides((o) => ({ ...o, [k]: typeof v === "boolean" ? v : k === "funderScope" ? v : Number(v) }));

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
      <div className="space-y-5 min-w-0">
        <div>
          <h1 className="text-[21px] sm:text-[24px] font-semibold tracking-tight leading-tight">Find the wallets that keep catching runners</h1>
          <p className="text-dim mt-1.5 max-w-2xl">
            Paste tokens that ran. Elmon finds who got in early on several of them, sets insiders aside, and ranks the rest by how many other runners
            they caught, then by what they actually made.
          </p>
        </div>

        {me?.paused && me.role !== "admin" && (
          <div className="rounded-lg border border-warn/35 bg-warn/[0.06] px-4 py-2.5 text-[12.5px] text-warn">
            New runs are paused by an admin right now. You can look at existing runs; starting a new one will work again once they resume.
          </div>
        )}
        {me && !me.workerOnline && (
          <div className="rounded-lg border border-warn/35 bg-warn/[0.06] px-4 py-2.5 text-[12.5px] text-warn">
            The background worker is offline. You can start a run; it will wait in the queue until the worker is back.
          </div>
        )}

        <Panel>
          <div className="p-4 sm:p-5 space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <Segmented
                value={mode}
                onChange={setMode}
                options={[
                  { v: "tokens", label: "Paste tokens" },
                  { v: "wallets", label: "Paste wallets" },
                ]}
              />
              <span className={`text-[12.5px] ${readiness.tone}`}>{readiness.text}</span>
            </div>

            <div className="rounded-lg border border-line bg-bg focus-within:border-accent/70 transition">
              {n > 0 && (
                <div className="flex flex-wrap gap-1.5 p-2.5 pb-0">
                  {parsed.valid.map((a) => {
                    const k = kindOf(a);
                    const wrong = mismatch.includes(a);
                    const sym = kinds[a]?.symbol;
                    return (
                      <span
                        key={a}
                        title={a}
                        className={`inline-flex items-center gap-1.5 h-6 pl-1.5 pr-1 rounded-md border mono text-[11.5px] ${wrong ? "bg-warn/[0.08] border-warn/50" : "bg-panel-2 border-line-2"}`}
                      >
                        <KindBadge kind={k === "token" ? "token" : k === "wallet" || k === "empty" ? "account" : "unknown"} />
                        {sym ? <span className="font-sans text-ink">${sym}</span> : null}
                        <span className={sym ? "text-faint" : ""}>{short(a, 4)}</span>
                        {k === "token-account" && <span className="font-sans text-warn text-[10.5px]">token account</span>}
                        {k === "program" && <span className="font-sans text-warn text-[10.5px]">program</span>}
                        {k === "empty" && mode === "tokens" && <span className="font-sans text-warn text-[10.5px]">not on chain</span>}
                        <button onClick={() => remove(a)} className="text-faint hover:text-ink px-1" aria-label={`Remove ${a}`}>
                          ×
                        </button>
                      </span>
                    );
                  })}
                  {checking && (
                    <span className="inline-flex items-center h-6 px-1">
                      <Spinner />
                    </span>
                  )}
                </div>
              )}
              <textarea
                suppressHydrationWarning
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={
                  mode === "tokens"
                    ? "Token mint addresses, one per line. pump.fun, DexScreener and Solscan links work too."
                    : "Wallet addresses, one per line."
                }
                spellCheck={false}
                className="w-full h-36 bg-transparent p-3 mono text-[12.5px] outline-none resize-y placeholder:text-faint"
              />
            </div>
            {mismatch.length > 0 && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-warn/40 bg-warn/[0.06] px-3 py-2 text-[12.5px] text-warn">
                <span>
                  {mode === "tokens"
                    ? allWrongKind
                      ? "These are not token mints: they look like wallets."
                      : `${mismatch.length} of these ${mismatch.length === 1 ? "is not a token mint" : "are not token mints"} (marked).`
                    : allWrongKind
                      ? "These look like tokens, not wallets."
                      : `${mismatch.length} of these ${mismatch.length === 1 ? "is not a wallet" : "are not wallets"} (marked).`}
                </span>
                <span className="ml-auto flex gap-2">
                  {allWrongKind && otherModeFits ? (
                    <Button size="sm" onClick={() => setMode(mode === "tokens" ? "wallets" : "tokens")}>
                      Switch to {mode === "tokens" ? "Paste wallets" : "Paste tokens"}
                    </Button>
                  ) : null}
                  <Button size="sm" onClick={() => setText(parsed.valid.filter((a) => !mismatch.includes(a)).join("\n"))}>
                    Remove {mismatch.length === 1 ? "it" : "them"}
                  </Button>
                </span>
              </div>
            )}
            {parsed.invalid.length > 0 && (
              <div className="text-bad text-[12px]">
                Not a Solana address: <span className="mono">{parsed.invalid.slice(0, 3).join(", ")}</span>
                {parsed.invalid.length > 3 ? ` and ${parsed.invalid.length - 3} more` : ""}
              </div>
            )}

            <div>
              <div className="text-[12px] text-faint mb-2">How deep</div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {(Object.keys(PRESETS) as PresetName[]).map((p) => {
                  const on = preset === p;
                  const pe = estimateCredits(mode, Math.max(n, mode === "tokens" ? RECOMMENDED : 1), { ...DEFAULT_SETTINGS, ...PRESETS[p].settings });
                  return (
                    <button
                      key={p}
                      suppressHydrationWarning
                      onClick={() => {
                        setPreset(p);
                        setPickedPreset(true);
                        setOverrides({});
                      }}
                      className={`text-left rounded-lg border p-3 transition ${on ? "border-accent/60 bg-accent/[0.07]" : "border-line hover:border-line-2 bg-panel-2/40"}`}
                    >
                      <div className="flex items-center gap-2">
                        <span className={`size-3.5 rounded-full border-2 ${on ? "border-accent bg-accent/40" : "border-line-2"}`} />
                        <span className="font-medium">{PRESETS[p].label}</span>
                        {p === "balanced" && <span className="text-[10.5px] text-accent-ink ml-auto">recommended</span>}
                      </div>
                      <div className="text-dim text-[11.5px] mt-1.5 leading-snug">{PRESETS[p].blurb}</div>
                      <div className="text-faint text-[11px] mt-1.5">
                        up to ~{Math.round(Math.min(pe.high, me?.maxBudget ?? pe.high) / 1000)}k credits
                        {me && (PRESETS[p].settings.runBudget ?? 0) > me.maxBudget ? " (capped for your account)" : ""}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3 pt-1">
              <input
                suppressHydrationWarning
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Name this batch (optional)"
                className="flex-1 min-w-48 h-10 bg-bg border border-line rounded-lg px-3 outline-none focus:border-accent/70"
              />
              <Button kind="ghost" onClick={() => setShowAdvanced((v) => !v)}>
                {showAdvanced ? "Hide settings" : "Fine-tune"}
              </Button>
              <span className="w-full sm:w-auto [&>button]:w-full">
              <Button kind="primary" size="lg" onClick={start} disabled={!canStart}>
                {busy ? <Spinner /> : null}
                {busy ? "Starting…" : mode === "tokens" ? "Find wallets" : "Analyse wallets"}
              </Button>
              </span>
            </div>
            {n > 0 && (
              <div className="flex flex-wrap gap-x-5 gap-y-1 text-[12px] text-faint">
                <Hint tip="Upper bound. Saved launches, funders and wallet histories from earlier runs cost nothing, so repeat batches are much cheaper. The run stops at its budget.">
                  <span>
                    ≈ {est.low.toLocaleString()} to {est.high.toLocaleString()} credits
                  </span>
                </Hint>
                <span>
                  ≈ {mins[0]} to {mins[1]} min
                </span>
                {lowCredits && <span className="text-bad">Not enough credits left this month for this run.</span>}
              </div>
            )}
            {error && <div className="rounded-md border border-bad/40 bg-bad/[0.06] px-3 py-2 text-bad">{error}</div>}
          </div>

          {showAdvanced && (
            <div className="border-t border-line p-4 sm:p-5">
              {(["Launch", "Candidates", "Funders", "History", "Runners", "Copying", "Budget"] as const).map((group) => {
                const items = SETTING_HELP.filter((h) => h.group === group && h.modes.includes(mode));
                if (items.length === 0) return null;
                return (
                  <div key={group} className="mb-4 last:mb-0">
                    <div className="text-[11px] uppercase tracking-wider text-faint mb-2">{group}</div>
                    <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-x-5 gap-y-3">
                      {items.map((h) => (
                        <label key={h.key} className="block">
                          <div className="flex items-center gap-1.5 text-dim text-[12px] mb-1">
                            {h.label}
                            <Hint tip={h.help}>
                              <span className="text-faint cursor-help text-[10px] border border-line-2 rounded-full size-3.5 grid place-items-center">i</span>
                            </Hint>
                          </div>
                          {h.key === "funderScope" ? (
                            <select value={settings.funderScope} onChange={(e) => setOverride("funderScope", e.target.value)} className="w-full h-8 bg-bg border border-line rounded-md px-2">
                              <option value="candidates">candidates only (insiders on demand)</option>
                              <option value="all">every early buyer (costly)</option>
                            </select>
                          ) : typeof settings[h.key] === "boolean" ? (
                            <select
                              value={String(settings[h.key])}
                              onChange={(e) => setOverride(h.key, e.target.value === "true")}
                              className="w-full h-8 bg-bg border border-line rounded-md px-2"
                            >
                              <option value="true">yes</option>
                              <option value="false">no</option>
                            </select>
                          ) : (
                            <input
                              type="number"
                              value={settings[h.key] as number}
                              onChange={(e) => setOverride(h.key, e.target.value)}
                              className="w-full h-8 bg-bg border border-line rounded-md px-2 num"
                            />
                          )}
                        </label>
                      ))}
                    </div>
                  </div>
                );
              })}
              <div className="flex justify-end">
                <Button kind="ghost" onClick={() => setOverrides({})}>
                  Reset to {PRESETS[preset].label.toLowerCase()}
                </Button>
              </div>
            </div>
          )}
        </Panel>

        <div className={`grid grid-cols-1 gap-3 ${mode === "tokens" ? "sm:grid-cols-2 xl:grid-cols-4" : "sm:grid-cols-3"}`}>
          {STEPS[mode].map((s, i) => (
            <div key={s.t} className="rounded-xl border border-line bg-panel/60 p-3.5">
              <div className="flex items-center gap-2">
                <span className="grid place-items-center size-5 rounded-full bg-raise text-[11px] text-dim">{i + 1}</span>
                <span className="font-medium">{s.t}</span>
              </div>
              <div className="text-dim text-[12px] mt-1.5 leading-snug">{s.d}</div>
            </div>
          ))}
        </div>
      </div>
      <div className="min-w-0">
        <RunsList limit={8} />
      </div>
    </div>
  );
}
