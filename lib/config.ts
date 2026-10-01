import { createHash } from "node:crypto";
import type { RunSettings } from "./settings";

export * from "./settings";

export function settingsHash(s: RunSettings): string {
  const ordered = Object.fromEntries(Object.keys(s).sort().map((k) => [k, (s as unknown as Record<string, unknown>)[k]]));
  return createHash("sha256").update(JSON.stringify(ordered)).digest("hex").slice(0, 16);
}
