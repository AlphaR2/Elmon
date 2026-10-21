import type { OwnerEvent } from "../solana/tx";

// Events with a blockTime inside [from, to]. Events with no blockTime are dropped: they cannot be placed.
export function cutToWindow(events: OwnerEvent[], w: { from: number; to: number }): OwnerEvent[] {
  return events.filter((e) => e.blockTime != null && e.blockTime >= w.from && e.blockTime <= w.to);
}

// before = blockTime < t, after = blockTime >= t. Every event lands in exactly one half (no-time events go before,
// the selection half, so they can never help a held-out score).
export function splitAt(events: OwnerEvent[], t: number): { before: OwnerEvent[]; after: OwnerEvent[] } {
  const before: OwnerEvent[] = [];
  const after: OwnerEvent[] = [];
  for (const e of events) (e.blockTime != null && e.blockTime >= t ? after : before).push(e);
  return { before, after };
}
