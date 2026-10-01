"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { TAG_DEFS } from "@/lib/core/tags";
import { short, solscan } from "@/lib/format";

// ---------- text & identity ----------

export type AddrKind = "account" | "token";

// W / T badge so a wallet is never mistaken for a token. The letter carries the meaning (not the tint), and the
// token badge opens the token's chart.
export function KindBadge({ kind, a }: { kind: AddrKind | "unknown"; a?: string }) {
  const base = "inline-grid place-items-center w-4 h-4 rounded-[4px] border text-[9.5px] font-semibold leading-none font-sans shrink-0";
  if (kind === "unknown")
    return (
      <Hint tip="Not checked yet">
        <span className={`${base} border-line text-faint`}>?</span>
      </Hint>
    );
  if (kind === "token") {
    const badge = <span className={`${base} border-series-3/50 bg-series-3/15 text-[#7fdcb8]`}>T</span>;
    return (
      <Hint tip={a ? "Token. Click for its chart." : "Token"}>
        {a ? (
          <a href={`https://dexscreener.com/solana/${a}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} aria-label="Token chart">
            {badge}
          </a>
        ) : (
          badge
        )}
      </Hint>
    );
  }
  return (
    <Hint tip="Wallet">
      <span className={`${base} border-line-2 bg-raise text-dim`}>W</span>
    </Hint>
  );
}

// B: the wallet trades like a bot. A label, not a verdict: many good traders run bots.
export function BotBadge() {
  return (
    <Hint tip="Bot-like: 30+ trades with a median hold under 2 min, or 5+ buy-then-sell pairs within 5 s. Shown, not filtered: plenty of good traders use bots.">
      <span className="inline-grid place-items-center w-4 h-4 rounded-[4px] border border-warn/50 bg-warn/12 text-warn text-[9.5px] font-semibold leading-none font-sans shrink-0">
        B
      </span>
    </Hint>
  );
}

// A token named in a table: symbol (or short mint) with an optional figure, linking to its chart.
export function TokenChip({ mint, symbol, value, tip }: { mint: string; symbol: string | null | undefined; value?: ReactNode; tip?: ReactNode }) {
  const chip = (
    <a
      href={`https://dexscreener.com/solana/${mint}`}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="inline-flex items-center gap-1 h-5 px-1.5 rounded border border-series-3/30 bg-series-3/[0.08] text-[11px] whitespace-nowrap hover:border-series-3/60"
    >
      <span className="text-[#7fdcb8]">{symbol ? `$${symbol}` : short(mint, 3)}</span>
      {value != null && <span className="text-dim num">{value}</span>}
    </a>
  );
  return tip ? <Hint tip={tip}>{chip}</Hint> : chip;
}

export function Addr({
  a,
  kind = "account",
  n = 4,
  label,
  badge = true,
  bot = false,
}: {
  a: string | null | undefined;
  kind?: AddrKind;
  n?: number;
  label?: string;
  badge?: boolean;
  bot?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  if (!a) return <span className="text-faint">—</span>;
  return (
    <span className="inline-flex items-center gap-1.5 mono text-[12.5px] whitespace-nowrap group/addr">
      {badge && <KindBadge kind={kind} a={a} />}
      {bot && <BotBadge />}
      <a href={solscan(a, kind)} target="_blank" rel="noreferrer" className="hover:text-accent-ink" title={a} onClick={(e) => e.stopPropagation()}>
        {label ?? short(a, n)}
      </a>
      <button
        className="opacity-0 group-hover/addr:opacity-100 focus:opacity-100 text-faint hover:text-ink text-[11px] w-4"
        title="Copy address"
        aria-label="Copy address"
        onClick={(e) => {
          e.stopPropagation();
          void navigator.clipboard.writeText(a).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 900);
          });
        }}
      >
        {copied ? "✓" : "⧉"}
      </button>
    </span>
  );
}

// Hover/focus explanation. `children` is the anchor; `tip` the bubble.
export function Hint({ tip, children, left = false, className = "" }: { tip: ReactNode; children: ReactNode; left?: boolean; className?: string }) {
  return (
    <span className={`hint ${left ? "hint-left" : ""} inline-flex ${className}`} tabIndex={0}>
      {children}
      <span className="hint-bubble" role="tooltip">
        {tip}
      </span>
    </span>
  );
}

export function InfoDot({ tip }: { tip: ReactNode }) {
  return (
    <Hint tip={tip}>
      <span className="grid place-items-center size-3.5 rounded-full border border-line-2 text-[9px] text-faint cursor-help">i</span>
    </Hint>
  );
}

const TAG_STYLE: Record<string, string> = {
  "runner-catcher": "bg-accent/15 text-accent-ink border-accent/35",
  conviction: "bg-series-3/15 text-[#5fd1a6] border-series-3/35",
  paperhands: "bg-series-2/12 text-[#ee9a78] border-series-2/35",
  dev: "bg-bad/15 text-bad border-bad/30",
  "dev-linked": "bg-bad/15 text-bad border-bad/30",
  bundle: "bg-violet/15 text-violet border-violet/30",
  "shared-funder": "bg-violet/10 text-violet border-violet/20",
  "block-0": "bg-warn/12 text-warn border-warn/30",
  sniper: "bg-warn/8 text-warn border-warn/20",
  fresh: "bg-raise text-dim border-line-2",
  "service-funded": "bg-raise text-dim border-line-2",
  "bot-like": "bg-warn/12 text-warn border-warn/30",
  busy: "bg-raise text-dim border-line-2",
  "thin-history": "bg-transparent text-faint border-line",
  "too-fast": "bg-warn/8 text-warn border-warn/20",
  dormant: "bg-transparent text-faint border-line",
};

export function Tag({ t }: { t: string }) {
  return (
    <Hint tip={TAG_DEFS[t] ?? t}>
      <span className={`inline-block px-1.5 py-px rounded border text-[11px] leading-4 whitespace-nowrap cursor-default ${TAG_STYLE[t] ?? "bg-raise text-dim border-line-2"}`}>{t}</span>
    </Hint>
  );
}

export function Signed({ v, children }: { v: number | null | undefined; children: ReactNode }) {
  if (v == null) return <span className="text-faint">—</span>;
  return <span className={v > 0 ? "text-good" : v < 0 ? "text-bad" : "text-dim"}>{children}</span>;
}

// ---------- containers ----------

export function Panel({
  title,
  sub,
  right,
  children,
  className = "",
}: {
  title?: ReactNode;
  sub?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`bg-panel border border-line rounded-xl ${className}`}>
      {(title || right) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 min-h-12 py-2 border-b border-line">
          <div className="min-w-0">
            <h2 className="font-medium text-[13.5px]">{title}</h2>
            {sub && <div className="text-faint text-[11.5px] mt-0.5">{sub}</div>}
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">{right}</div>
        </div>
      )}
      {children}
    </section>
  );
}

export function Empty({ title, children, action }: { title?: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="px-6 py-12 text-center">
      {title && <div className="font-medium">{title}</div>}
      {children && <div className="text-dim mt-1 max-w-md mx-auto">{children}</div>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

// ---------- controls ----------

export function Button({
  children,
  onClick,
  kind = "default",
  disabled,
  href,
  title,
  size = "md",
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  kind?: "default" | "primary" | "danger" | "ghost";
  disabled?: boolean;
  href?: string;
  title?: string;
  size?: "sm" | "md" | "lg";
  type?: "button" | "submit";
}) {
  const cls = {
    default: "bg-panel-2 border-line-2 hover:border-faint text-ink",
    primary: "bg-accent border-accent text-white hover:brightness-110 font-medium shadow-[0_0_0_1px_rgb(57_135_229/0.3),0_6px_20px_-6px_rgb(57_135_229/0.6)]",
    danger: "bg-panel-2 border-bad/40 text-bad hover:border-bad",
    ghost: "border-transparent text-dim hover:text-ink hover:bg-panel-2",
  }[kind];
  // Phones get 36-44px tap targets; desktop keeps the compact terminal sizes.
  const sz = { sm: "h-9 sm:h-7 px-3 sm:px-2.5 text-[13px] sm:text-[12px]", md: "h-10 sm:h-8 px-3.5 sm:px-3 text-[13.5px] sm:text-[12.5px]", lg: "h-11 sm:h-10 px-5 text-[14px] sm:text-[13.5px]" }[size];
  const c = `inline-flex items-center justify-center gap-1.5 rounded-md border transition whitespace-nowrap disabled:opacity-40 disabled:pointer-events-none ${sz} ${cls}`;
  if (href)
    return (
      <a href={href} className={c} title={title}>
        {children}
      </a>
    );
  return (
    <button type={type} className={c} onClick={onClick} disabled={disabled} title={title} suppressHydrationWarning>
      {children}
    </button>
  );
}

export function Chip({ on, onClick, children, title }: { on: boolean; onClick: () => void; children: ReactNode; title?: string }) {
  return (
    <button
      suppressHydrationWarning
      onClick={onClick}
      title={title}
      aria-pressed={on}
      className={`h-9 sm:h-7 px-3 sm:px-2.5 rounded-full border text-[13px] sm:text-[12px] transition ${on ? "border-accent/50 text-accent-ink bg-accent/10" : "border-line-2 text-dim hover:text-ink"}`}
    >
      {on ? "✓ " : ""}
      {children}
    </button>
  );
}

export function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { v: T; label: ReactNode }[] }) {
  return (
    <div className="inline-flex items-center gap-1 p-1 bg-bg rounded-lg border border-line" role="tablist">
      {options.map((o) => (
        <button
          key={o.v}
          suppressHydrationWarning
          role="tab"
          aria-selected={value === o.v}
          onClick={() => onChange(o.v)}
          className={`px-3.5 sm:px-3 h-9 sm:h-7 rounded-md text-[13.5px] sm:text-[12.5px] transition ${value === o.v ? "bg-raise text-ink shadow-sm" : "text-dim hover:text-ink"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// Small dropdown menu (export options and similar).
export function Menu({ label, children, kind = "default" }: { label: ReactNode; children: ReactNode; kind?: "default" | "primary" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      <Button kind={kind} onClick={() => setOpen((v) => !v)}>
        {label} <span className="text-[10px] opacity-70">▾</span>
      </Button>
      {open && (
        <div className="absolute right-0 top-full mt-1.5 z-50 min-w-60 max-w-[calc(100vw-2rem)] rounded-lg border border-line-2 bg-raise p-1 shadow-[0_12px_40px_rgb(0_0_0/0.5)]" onClick={() => setOpen(false)}>
          {children}
        </div>
      )}
    </div>
  );
}

export function MenuItem({ href, onClick, children, sub }: { href?: string; onClick?: () => void; children: ReactNode; sub?: ReactNode }) {
  const c = "block w-full text-left px-3 py-2.5 sm:py-2 rounded-md hover:bg-panel-2";
  const body = (
    <>
      <div>{children}</div>
      {sub && <div className="text-faint text-[11.5px] mt-0.5">{sub}</div>}
    </>
  );
  return href ? (
    <a href={href} className={c}>
      {body}
    </a>
  ) : (
    <button className={c} onClick={onClick} suppressHydrationWarning>
      {body}
    </button>
  );
}

// ---------- data widgets ----------

export function StatusPill({ status }: { status: string }) {
  const map: Record<string, [string, string]> = {
    queued: ["text-dim border-line-2", "queued"],
    running: ["text-accent-ink border-accent/40 bg-accent/10", "running"],
    cancelling: ["text-warn border-warn/40", "stopping"],
    done: ["text-good border-good/35", "done"],
    failed: ["text-bad border-bad/40", "failed"],
    stopped: ["text-warn border-warn/40", "stopped"],
  };
  const [c, label] = map[status] ?? ["text-dim border-line", status];
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[11px] whitespace-nowrap ${c}`}>
      {status === "running" && <span className="size-1.5 rounded-full bg-accent animate-pulse-soft" />}
      {label}
    </span>
  );
}

export function Stat({ label, value, sub, tip, tone }: { label: ReactNode; value: ReactNode; sub?: ReactNode; tip?: ReactNode; tone?: "accent" }) {
  return (
    <div className={`rounded-xl border px-3.5 sm:px-4 py-3 min-w-0 ${tone === "accent" ? "border-accent/30 bg-accent/[0.06]" : "border-line bg-panel"}`}>
      <div className="flex items-center gap-1.5 text-faint text-[11.5px]">
        {label}
        {tip && <InfoDot tip={tip} />}
      </div>
      <div className="mt-1 text-[20px] sm:text-[22px] font-semibold tracking-tight leading-7">{value}</div>
      {sub && <div className="text-dim text-[11.5px] mt-0.5">{sub}</div>}
    </div>
  );
}

// 0-100 score with a thin bar. Color is the accent; the number carries the value.
export function ScoreBar({ v, width = 56, hint }: { v: number | null | undefined; width?: number; hint?: string }) {
  if (v == null) return <span className="text-faint" title={hint}>{hint ? hint : "—"}</span>;
  return (
    <span className="inline-flex items-center gap-2">
      <span className="w-7 text-right font-medium">{Math.round(v)}</span>
      <span className="h-1.5 rounded-full bg-line overflow-hidden" style={{ width }}>
        <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.max(2, Math.min(100, v))}%` }} />
      </span>
    </span>
  );
}

// A share (0-1) as a small bar, for capture.
export function ShareBar({ v, width = 48 }: { v: number | null | undefined; width?: number }) {
  if (v == null) return <span className="text-faint">—</span>;
  return (
    <span className="inline-flex items-center gap-2">
      <span className="h-1.5 rounded-full bg-line overflow-hidden" style={{ width }}>
        <span className="block h-full rounded-full bg-series-2" style={{ width: `${Math.max(3, Math.min(100, v * 100))}%` }} />
      </span>
      <span className="text-dim w-9">{Math.round(v * 100)}%</span>
    </span>
  );
}

export function Th({
  children,
  sortKey,
  sort,
  setSort,
  className = "",
  tip,
}: {
  children: ReactNode;
  sortKey?: string;
  sort?: { key: string; dir: 1 | -1 };
  setSort?: (s: { key: string; dir: 1 | -1 }) => void;
  className?: string;
  tip?: ReactNode;
}) {
  const active = sortKey && sort?.key === sortKey;
  const label = (
    <span className="inline-flex items-center gap-1">
      {children}
      {active ? <span className="text-accent-ink">{sort!.dir === -1 ? "↓" : "↑"}</span> : null}
    </span>
  );
  return (
    <th
      className={`px-3 h-9 text-left font-normal text-[11.5px] text-faint border-b border-line whitespace-nowrap ${sortKey ? "cursor-pointer select-none hover:text-ink" : ""} ${active ? "text-ink" : ""} ${className}`}
      onClick={() => sortKey && setSort?.({ key: sortKey, dir: active ? ((-sort!.dir) as 1 | -1) : -1 })}
      aria-sort={active ? (sort!.dir === -1 ? "descending" : "ascending") : undefined}
    >
      {tip ? <Hint tip={tip}>{label}</Hint> : label}
    </th>
  );
}

export function Spinner() {
  return <span className="inline-block size-3.5 rounded-full border-2 border-line-2 border-t-accent animate-spin" aria-hidden />;
}
