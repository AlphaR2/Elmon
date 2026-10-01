"use client";
import type { ReactNode } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import { mult, short, sol, usd } from "@/lib/format";

// Chart rules (dataviz skill): thin marks, >= 8px dots with a 2px surface ring, 2px lines with a 10% wash,
// recessive hairline grid, one y-axis, text in ink tokens (never series color), a legend whenever 2+ series,
// and a hover tooltip on every mark. Series order is fixed: blue, orange, aqua (validated on the panel surface).
const C = {
  s1: "#3987e5",
  s2: "#d95926",
  s3: "#199e70",
  surface: "#131519",
  grid: "#22262c",
  axis: "#323842",
  ink: "#eceef1",
  dim: "#a1a9b5",
  faint: "#6b7380",
};

// Dot mark: r 5.5 (>= 8px), 2px ring in the surface color so overlapping dots stay distinct.
const dot = (fill: string) =>
  function Dot(props: unknown) {
    const { cx, cy } = props as { cx?: number; cy?: number };
    if (cx == null || cy == null) return <g />;
    return <circle cx={cx} cy={cy} r={5.5} fill={fill} stroke={C.surface} strokeWidth={2} />;
  };

const axisProps = {
  stroke: C.axis,
  tickLine: false,
  tick: { fill: C.faint, fontSize: 11 },
} as const;

function TipBox({ title, rows }: { title: ReactNode; rows: [ReactNode, ReactNode, string?][] }) {
  return (
    <div className="rounded-lg border border-line-2 bg-raise px-3 py-2 text-[12px] shadow-[0_8px_24px_rgb(0_0_0/0.45)] min-w-44">
      <div className="text-dim mb-1">{title}</div>
      {rows.map(([k, v, key], i) => (
        <div key={i} className="flex items-center gap-2 py-px">
          {key && <span className="inline-block w-3 h-0.5 rounded" style={{ background: key }} />}
          <span className="font-medium text-ink num">{v}</span>
          <span className="text-faint ml-auto pl-3">{k}</span>
        </div>
      ))}
    </div>
  );
}

export function Legend({ items }: { items: { color: string; label: string; shape?: "dot" | "line" }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-dim">
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1.5">
          {i.shape === "line" ? (
            <span className="inline-block w-3.5 h-0.5 rounded" style={{ background: i.color }} />
          ) : (
            <span className="inline-block size-2.5 rounded-full" style={{ background: i.color }} />
          )}
          {i.label}
        </span>
      ))}
    </div>
  );
}

// ---------- Runner score vs profit score ----------

export interface TraderPoint {
  wallet: string;
  x: number; // profit score
  y: number; // runner score
  runners: number;
  netSol: number | null;
  starred: boolean;
}

type PickPayload = { payload?: TraderPoint } & Partial<TraderPoint>;

// The team's two questions on one plane: up = catches runners, right = makes money. Top-left is the
// "mad intuition but paperhands" corner; top-right is the rare wallet that does both.
export function RunnerProfitScatter({ points, onPick, height = 300 }: { points: TraderPoint[]; onPick?: (wallet: string) => void; height?: number }) {
  const traders = points.filter((p) => !p.starred);
  const starred = points.filter((p) => p.starred);
  const pick = (d: PickPayload) => {
    const w = d?.payload?.wallet ?? d?.wallet;
    if (w) onPick?.(w);
  };
  const corner = (text: string, pos: string) => <div className={`absolute ${pos} hidden md:block text-[10.5px] uppercase tracking-wider text-faint pointer-events-none`}>{text}</div>;
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <Legend items={[{ color: C.s1, label: "Trader" }, { color: C.s2, label: "Starred" }]} />
        <span className="text-faint text-[11px]">click a dot to open the wallet</span>
      </div>
      <div className="relative" style={{ height }}>
        {corner("Catches runners, sells early", "left-14 top-3")}
        {corner("Catches runners and profits", "right-4 top-3")}
        {corner("Profits without runners", "right-3 bottom-14")}
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ top: 8, right: 12, bottom: 18, left: 0 }}>
            <CartesianGrid stroke={C.grid} strokeDasharray="0" />
            <ReferenceArea x1={50} x2={103} y1={50} y2={103} fill={C.s1} fillOpacity={0.05} stroke="none" />
            <XAxis
              type="number"
              dataKey="x"
              domain={[0, 100]}
              ticks={[0, 25, 50, 75, 100]}
              {...axisProps}
              label={{ value: "Profit score →", position: "insideBottom", offset: -10, fill: C.faint, fontSize: 11 }}
            />
            <YAxis
              type="number"
              dataKey="y"
              domain={[-3, 103]}
              ticks={[0, 25, 50, 75, 100]}
              width={40}
              {...axisProps}
              label={{ value: "Runner score →", angle: -90, position: "insideLeft", offset: 14, fill: C.faint, fontSize: 11 }}
            />
            <ZAxis range={[110, 110]} />
            <ReferenceLine x={50} stroke={C.axis} />
            <ReferenceLine y={50} stroke={C.axis} />
            <Tooltip
              cursor={false}
              isAnimationActive={false}
              content={({ active, payload }) => {
                const p = active ? (payload?.[0]?.payload as TraderPoint | undefined) : undefined;
                if (!p) return null;
                return (
                  <TipBox
                    title={<span className="mono">{short(p.wallet, 5)}</span>}
                    rows={[
                      [`Runner score`, Math.round(p.y), p.starred ? C.s2 : C.s1],
                      [`Profit score`, Math.round(p.x)],
                      [`Runners caught`, p.runners],
                      [`Net SOL`, p.netSol != null ? sol(p.netSol, 1) : "—"],
                    ]}
                  />
                );
              }}
            />
            <Scatter data={traders} fill={C.s1} shape={dot(C.s1)} onClick={pick} cursor="pointer" isAnimationActive={false} />
            <Scatter data={starred} fill={C.s2} shape={dot(C.s2)} onClick={pick} cursor="pointer" isAnimationActive={false} />
          </ScatterChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ---------- cumulative PnL ----------

export function PnlCurve({ curve, height = 180 }: { curve: [number, number][]; height?: number }) {
  if (curve.length < 2) return <div className="text-faint text-[12px] py-6 text-center">Not enough closed trades to draw a curve.</div>;
  const data = curve.map(([t, v]) => ({ t: t * 1000, v }));
  const last = data[data.length - 1].v;
  const fmtDate = (t: number) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 40, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="pnlWash" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={C.s1} stopOpacity={0.16} />
              <stop offset="100%" stopColor={C.s1} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke={C.grid} vertical={false} />
          <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]} tickFormatter={fmtDate} {...axisProps} minTickGap={40} />
          <YAxis width={44} {...axisProps} tickFormatter={(v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1))} />
          <ReferenceLine y={0} stroke={C.axis} />
          <Tooltip
            isAnimationActive={false}
            cursor={{ stroke: C.dim, strokeWidth: 1 }}
            content={({ active, payload }) => {
              const p = active ? (payload?.[0]?.payload as { t: number; v: number } | undefined) : undefined;
              if (!p) return null;
              return <TipBox title={new Date(p.t).toLocaleString()} rows={[["SOL, cumulative", sol(p.v, 2), C.s1]]} />;
            }}
          />
          <Area
            type="monotone"
            dataKey="v"
            stroke={C.s1}
            strokeWidth={2}
            fill="url(#pnlWash)"
            dot={false}
            activeDot={{ r: 4, fill: C.s1, stroke: C.surface, strokeWidth: 2 }}
            isAnimationActive={false}
            label={(props: { index?: number; x?: number | string; y?: number | string }) =>
              props.index === data.length - 1 ? (
                <text x={Number(props.x) + 6} y={Number(props.y) + 4} fill={C.ink} fontSize={11} fontWeight={600}>
                  {sol(last, 1)}
                </text>
              ) : (
                <g />
              )
            }
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

// ---------- runner hits: entry vs peak ----------

export interface HitPoint {
  mint: string;
  symbol: string | null;
  entry: number;
  peak: number;
  exitMultiple: number | null;
  capture: number | null;
  estimated: boolean;
}

// Each runner the wallet caught: where it got in (x) against how high the token went (y), both log scale.
// Dots far above the 5x line are the big ones.
export function RunnerHitsChart({ hits, height = 220 }: { hits: HitPoint[]; height?: number }) {
  if (hits.length === 0) return <div className="text-faint text-[12px] py-6 text-center">No runners caught outside your batch.</div>;
  const xs = hits.map((h) => h.entry);
  const ys = hits.map((h) => h.peak);
  const lo = Math.max(100, Math.min(...xs) / 2);
  const hi = Math.max(...ys) * 1.6;
  const confirmed = hits.filter((h) => !h.estimated);
  const estimated = hits.filter((h) => h.estimated);
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <Legend items={[{ color: C.s1, label: "Peak from price history" }, ...(estimated.length ? [{ color: C.s3, label: "Peak estimated (lower bound)" }] : [])]} />
      </div>
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ top: 8, right: 12, bottom: 18, left: 4 }}>
            <CartesianGrid stroke={C.grid} />
            <XAxis
              type="number"
              dataKey="entry"
              scale="log"
              domain={[lo, Math.max(...xs) * 2]}
              tickFormatter={(v: number) => usd(v)}
              {...axisProps}
              label={{ value: "Entry market cap", position: "insideBottom", offset: -10, fill: C.faint, fontSize: 11 }}
            />
            <YAxis type="number" dataKey="peak" scale="log" domain={[lo * 5, hi]} tickFormatter={(v: number) => usd(v)} width={52} {...axisProps} />
            <ZAxis range={[72, 72]} />
            <ReferenceLine
              segment={[
                { x: lo, y: lo * 5 },
                { x: hi / 5, y: hi },
              ]}
              stroke={C.axis}
              ifOverflow="hidden"
              label={{ value: "5x", position: "insideTopLeft", fill: C.faint, fontSize: 10 }}
            />
            <Tooltip
              cursor={false}
              isAnimationActive={false}
              content={({ active, payload }) => {
                const h = active ? (payload?.[0]?.payload as HitPoint | undefined) : undefined;
                if (!h) return null;
                return (
                  <TipBox
                    title={h.symbol ? `$${h.symbol}` : short(h.mint)}
                    rows={[
                      ["peak", `${usd(h.peak)}${h.estimated ? "+" : ""}`, h.estimated ? C.s3 : C.s1],
                      ["entry", usd(h.entry)],
                      ["available", mult(h.peak / h.entry)],
                      ["it made", h.exitMultiple != null ? mult(h.exitMultiple) : "holding"],
                      ["captured", h.capture != null ? `${Math.round(h.capture * 100)}%` : "—"],
                    ]}
                  />
                );
              }}
            />
            <Scatter data={confirmed} fill={C.s1} shape={dot(C.s1)} isAnimationActive={false} />
            <Scatter data={estimated} fill={C.s3} shape={dot(C.s3)} isAnimationActive={false} />
          </ScatterChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ---------- horizontal bars (HTML) ----------

// Single-series bars with the value at the tip. <= 24px thick, rounded data end, square at the baseline.
export function Bars({ rows, format, max }: { rows: { key: string; label: ReactNode; value: number | null; note?: ReactNode }[]; format: (v: number) => string; max?: number }) {
  const m = max ?? Math.max(1, ...rows.map((r) => r.value ?? 0));
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <div key={r.key} className="grid grid-cols-[120px_1fr] items-center gap-3 group">
          <div className="truncate text-dim text-[12px]">{r.label}</div>
          <div className="flex items-center gap-2 min-w-0" title={r.value != null ? format(r.value) : "unknown"}>
            {r.value != null ? (
              <>
                <div className="h-3.5 rounded-r-[4px] bg-accent group-hover:brightness-125 transition" style={{ width: `${Math.max(1.5, (r.value / m) * 85)}%` }} />
                <span className="text-[12px] text-ink num whitespace-nowrap">{format(r.value)}</span>
                {r.note && <span className="text-[11px] text-faint whitespace-nowrap">{r.note}</span>}
              </>
            ) : (
              <span className="text-faint text-[12px]">unknown</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
