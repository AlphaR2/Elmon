import bs58 from "bs58";

// Browser-safe helpers.

export function parseAddresses(text: string): { valid: string[]; invalid: string[] } {
  const parts = text.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const p of parts) {
    // Accept pump.fun / dexscreener / solscan links by taking the last path segment.
    const cand = p.includes("/") ? p.replace(/[?#].*$/, "").split("/").filter(Boolean).pop() ?? p : p;
    if (isAddress(cand)) {
      if (!valid.includes(cand)) valid.push(cand);
    } else invalid.push(p);
  }
  return { valid, invalid };
}

export function isAddress(s: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return false;
  try {
    return bs58.decode(s).length === 32;
  } catch {
    return false;
  }
}

export const short = (a: string | null | undefined, n = 4) => (a ? `${a.slice(0, n)}…${a.slice(-n)}` : "—");
export const sol = (x: number | null | undefined, digits = 2) =>
  x == null ? "—" : `${x >= 0 ? "" : "−"}${Math.abs(x).toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits })}`;
export const pct = (x: number | null | undefined) => (x == null ? "—" : `${Math.round(x * 100)}%`);
export const mult = (x: number | null | undefined) => (x == null ? "—" : `${x >= 10 ? x.toFixed(0) : x.toFixed(2)}x`);
export const num = (x: number | null | undefined) => (x == null ? "—" : Math.round(x).toLocaleString());
export const usd = (x: number | null | undefined) =>
  x == null ? "—" : x >= 1e6 ? `$${(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `$${(x / 1e3).toFixed(0)}K` : `$${x.toFixed(0)}`;
export function duration(minutes: number | null | undefined): string {
  if (minutes == null) return "—";
  if (minutes < 1) return `${Math.round(minutes * 60)}s`;
  if (minutes < 60) return `${Math.round(minutes)}m`;
  if (minutes < 60 * 48) return `${(minutes / 60).toFixed(1)}h`;
  return `${(minutes / 1440).toFixed(1)}d`;
}
export function ago(ms: number): string {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
export const solscan = (addr: string, kind: "account" | "token" | "tx" = "account") => `https://solscan.io/${kind}/${addr}`;

// Where to go after sign-in: a path on this site only (no protocol-relative or backslash tricks).
export const safeNext = (n: string | null | undefined): string =>
  n && n.startsWith("/") && !n.startsWith("//") && !n.startsWith("/\\") ? n : "/";
