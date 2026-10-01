import { getDb, json, type Db } from "./db";

// Limits ops change from the admin page, stored in app_config ('settings'). Read per request/run, so a change
// takes effect without a deploy. Unknown or out-of-range values fall back to the defaults below.

export interface AppSettings {
  maxLiveMember: number; // live runs one member may have
  maxLiveAdmin: number;
  maxBudgetMember: number; // largest per-run credit budget a member may set
  maxBudgetAdmin: number;
  resultTtlDays: number; // how long results are kept
  afterExportTtlHours: number; // ...or this long after the first export, whichever is first
  historyKeepDays: number; // wallet histories nobody asked about for this long are dropped
  defaultPreset: "cheap" | "balanced" | "deep";
  pauseNewRuns: boolean; // emergency stop: no new run starts (queued runs wait)
  codeDefaultUses: number;
  codeDefaultDays: number;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  maxLiveMember: 2,
  maxLiveAdmin: 5,
  maxBudgetMember: 60_000,
  maxBudgetAdmin: 200_000,
  resultTtlDays: 7,
  afterExportTtlHours: 24,
  historyKeepDays: 120,
  defaultPreset: "balanced",
  pauseNewRuns: false,
  codeDefaultUses: 5,
  codeDefaultDays: 7,
};

const RANGES: Partial<Record<keyof AppSettings, [number, number]>> = {
  maxLiveMember: [1, 20],
  maxLiveAdmin: [1, 50],
  maxBudgetMember: [1_000, 5_000_000],
  maxBudgetAdmin: [1_000, 5_000_000],
  resultTtlDays: [1, 90],
  afterExportTtlHours: [1, 24 * 30],
  historyKeepDays: [7, 730],
  codeDefaultUses: [1, 1000],
  codeDefaultDays: [1, 365],
};

// Validates a partial update. Throws with a readable message on a bad value.
export function parseAppSettings(input: unknown, base: AppSettings = DEFAULT_APP_SETTINGS): AppSettings {
  const src = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const out: AppSettings = { ...base };
  for (const k of Object.keys(src) as (keyof AppSettings)[]) {
    if (!(k in DEFAULT_APP_SETTINGS)) continue;
    const v = src[k];
    if (k === "pauseNewRuns") out.pauseNewRuns = v === true || v === "true";
    else if (k === "defaultPreset") {
      if (v !== "cheap" && v !== "balanced" && v !== "deep") throw new Error("defaultPreset must be cheap, balanced or deep");
      out.defaultPreset = v;
    } else {
      const r = RANGES[k]!;
      const n = Number(v);
      if (!Number.isFinite(n) || n < r[0] || n > r[1]) throw new Error(`${k} must be between ${r[0].toLocaleString()} and ${r[1].toLocaleString()}`);
      (out[k] as number) = Math.round(n);
    }
  }
  return out;
}

export async function getAppSettings(db?: Db): Promise<AppSettings> {
  const d = db ?? (await getDb());
  const row = await d.one<{ value: string }>("SELECT value FROM app_config WHERE key = 'settings'");
  try {
    return parseAppSettings(json(row?.value, {}));
  } catch {
    return { ...DEFAULT_APP_SETTINGS }; // a bad stored value never takes the app down
  }
}

export async function saveAppSettings(next: AppSettings, db?: Db): Promise<void> {
  const d = db ?? (await getDb());
  await d.run(
    `INSERT INTO app_config (key, value, updated_at) VALUES ('settings', $1, $2)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [JSON.stringify(next), Date.now()],
  );
}
