"use client";
import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { AdminOverview } from "@/lib/adminData";
import type { AppSettings } from "@/lib/appSettings";
import { ago } from "@/lib/format";
import { Button, Empty, Hint, Panel, Segmented, Spinner, Stat, StatusPill } from "../components/ui";
import { Bars } from "../components/charts";
import { AdminSkeleton } from "../components/skeletons";

type Section = "overview" | "invites" | "members" | "runs" | "settings" | "activity";

const fmtDate = (ms: number | null) => (ms ? new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");

export default function AdminPage() {
  const [data, setData] = useState<AdminOverview | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "denied" | "error">("loading");
  const [section, setSection] = useState<Section>("overview");
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await fetch("/api/admin").catch(() => null);
    if (!r) return setState("error");
    if (r.status === 404 || r.status === 401) return setState("denied");
    if (!r.ok) return setState("error");
    setData(await r.json());
    setState("ok");
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load]);

  if (state === "denied")
    return (
      <div className="max-w-md mx-auto mt-24 text-center">
        <div className="text-[18px] font-semibold">Page not found</div>
        <Link href="/" className="text-accent-ink mt-3 inline-block">
          New analysis →
        </Link>
      </div>
    );
  if (state === "error") return <div className="text-bad">Could not load the admin page. Try again.</div>;
  if (!data) return <AdminSkeleton />;

  const say = (m: string) => {
    setNotice(m);
    setTimeout(() => setNotice(null), 5000);
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <h1 className="text-[19px] sm:text-[22px] font-semibold tracking-tight">Admin</h1>
          <p className="text-dim mt-1">Invite people, manage members and runs, and change limits without a deploy.</p>
        </div>
        {data.settings.pauseNewRuns && (
          <span className="sm:ml-auto inline-flex items-center gap-2 px-3 h-8 rounded-full border border-warn/50 bg-warn/10 text-warn text-[12.5px]">
            <span className="size-2 rounded-full bg-warn animate-pulse-soft" /> New runs are paused
          </span>
        )}
      </div>

      <div className="overflow-x-auto scroll-thin -mx-4 px-4 sm:mx-0 sm:px-0">
        <Segmented
          value={section}
          onChange={setSection}
          options={[
            { v: "overview", label: "Overview" },
            { v: "invites", label: `Invites` },
            { v: "members", label: `Members ${data.members.length}` },
            { v: "runs", label: "All runs" },
            { v: "settings", label: "Settings" },
            { v: "activity", label: "Activity" },
          ]}
        />
      </div>

      {notice && <div className="rounded-lg border border-line-2 bg-panel px-4 py-2.5 text-[12.5px] text-dim">{notice}</div>}

      {section === "overview" && <Overview d={data} reload={load} say={say} />}
      {section === "invites" && <Invites d={data} reload={load} say={say} />}
      {section === "members" && <Members d={data} reload={load} say={say} />}
      {section === "runs" && <AllRuns d={data} reload={load} say={say} />}
      {section === "settings" && <Settings d={data} reload={load} say={say} />}
      {section === "activity" && <Activity d={data} />}
    </div>
  );
}

type P = { d: AdminOverview; reload: () => Promise<void>; say: (m: string) => void };

// ---------- overview ----------

function Overview({ d, reload, say }: P) {
  const pct = d.credits.cap ? Math.min(100, (d.credits.used / d.credits.cap) * 100) : 0;
  const activeCodes = d.codes.filter((c) => c.status === "active").length;
  const togglePause = async () => {
    const next = !d.settings.pauseNewRuns;
    if (next && !confirm("Pause new runs? Runs already going finish; queued runs wait until you resume. Admins can still start runs.")) return;
    const r = await fetch("/api/admin/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pauseNewRuns: next }) });
    say(r.ok ? (next ? "New runs paused." : "New runs resumed.") : "Could not change it.");
    await reload();
  };
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat
          label="Worker"
          value={<span className={d.system.workerOnline ? "text-good" : "text-warn"}>{d.system.workerOnline ? "Online" : "Offline"}</span>}
          sub={d.system.workerSeenAt ? `seen ${ago(d.system.workerSeenAt)}` : "never seen"}
        />
        <Stat label="Runs now" value={d.system.running + d.system.queued} sub={`${d.system.running} running · ${d.system.queued} queued`} />
        <Stat label="Members" value={d.members.length} sub={`${d.admins.length} admin${d.admins.length === 1 ? "" : "s"} · ${activeCodes} active codes`} />
        <Stat
          label="Credits this month"
          tone="accent"
          value={`${Math.round(d.credits.used / 1000).toLocaleString()}k`}
          sub={`of ${Math.round(d.credits.cap / 1000).toLocaleString()}k usable (98% of ${Math.round(d.credits.limit / 1000).toLocaleString()}k)`}
          tip="Runs stop at 98% of the monthly limit. Change the limit under Settings."
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Emergency stop" sub="Stops new runs from starting. Runs already going finish. Admins can still start runs.">
          <div className="p-4 flex flex-wrap items-center gap-3">
            <span className={`text-[13px] ${d.settings.pauseNewRuns ? "text-warn" : "text-dim"}`}>
              {d.settings.pauseNewRuns ? "Paused: queued runs are waiting." : "Running normally."}
            </span>
            <span className="ml-auto">
              <Button kind={d.settings.pauseNewRuns ? "primary" : "danger"} onClick={togglePause}>
                {d.settings.pauseNewRuns ? "Resume new runs" : "Pause new runs"}
              </Button>
            </span>
          </div>
        </Panel>
        <Panel title="Data sources" sub="Keys live on the worker; this shows what it reported.">
          <div className="p-4 grid grid-cols-2 gap-3 text-[13px]">
            <SourceRow ok={d.system.helius} name="Helius" what="chain data (credits)" />
            <SourceRow ok={d.system.birdeye} name="Birdeye" what="faster price history" optional />
          </div>
        </Panel>
      </div>

      <Panel title="Where this month's credits went" sub="Admins only. Members never see credit details.">
        <div className="p-4 space-y-5">
          <div>
            <div className="flex items-center justify-between text-[12px] text-faint mb-1.5">
              <span>{d.credits.used.toLocaleString()} used</span>
              <span>{d.credits.cap.toLocaleString()} usable</span>
            </div>
            <div className="h-2 rounded-full bg-line overflow-hidden">
              <div className={`h-full rounded-full ${pct > 85 ? "bg-bad" : pct > 60 ? "bg-warn" : "bg-accent"}`} style={{ width: `${Math.max(1, pct)}%` }} />
            </div>
          </div>
          {d.credits.byStage.length > 0 && (
            <div>
              <div className="text-[12px] uppercase tracking-wider text-dim mb-2">By stage</div>
              <Bars rows={d.credits.byStage.map((s) => ({ key: s.stage ?? "other", label: s.stage ?? "other", value: s.credits }))} format={(v) => v.toLocaleString()} />
            </div>
          )}
          <div>
            <div className="text-[12px] uppercase tracking-wider text-dim mb-2">By member</div>
            {d.members.filter((m) => m.credits_month > 0).length === 0 ? (
              <div className="text-faint text-[12.5px]">No member runs this month.</div>
            ) : (
              <Bars
                rows={d.members.filter((m) => m.credits_month > 0).map((m) => ({ key: m.email, label: m.email, value: m.credits_month, note: `${m.runs_month} runs` }))}
                format={(v) => v.toLocaleString()}
              />
            )}
          </div>
          {d.credits.topRuns.length > 0 && (
            <div>
              <div className="text-[12px] uppercase tracking-wider text-dim mb-2">Most expensive runs</div>
              <ul className="divide-y divide-line">
                {d.credits.topRuns.map((r) => (
                  <li key={r.run_id} className="flex items-center gap-3 py-2 text-[13px]">
                    <Link href={`/runs/${r.run_id}`} className="hover:text-accent-ink truncate">
                      {r.label || `Run #${r.run_id}`}
                    </Link>
                    <span className="text-faint truncate text-[12px]">{r.email ?? "CLI"}</span>
                    <span className="ml-auto num">{Number(r.credits).toLocaleString()}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </Panel>
    </div>
  );
}

function SourceRow({ ok, name, what, optional }: { ok: boolean; name: string; what: string; optional?: boolean }) {
  return (
    <div className="flex items-start gap-2">
      <span className={`mt-1 size-2 rounded-full ${ok ? "bg-good" : optional ? "bg-line-2" : "bg-bad"}`} />
      <div>
        <div>
          {name} <span className="text-faint">{ok ? "set" : optional ? "not set (optional)" : "missing"}</span>
        </div>
        <div className="text-faint text-[12px]">{what}</div>
      </div>
    </div>
  );
}

// ---------- invites ----------

function Invites({ d, reload, say }: P) {
  const [uses, setUses] = useState(String(d.settings.codeDefaultUses));
  const [days, setDays] = useState(String(d.settings.codeDefaultDays));
  const [never, setNever] = useState(false);
  const [label, setLabel] = useState("");
  const [bound, setBound] = useState("");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const create = async () => {
    setBusy(true);
    setErr(null);
    const r = await fetch("/api/admin/codes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxUses: Number(uses), expiresInDays: never ? null : Number(days), label, boundEmail: bound }),
    });
    const b = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) return setErr(b.error ?? "Could not create the code.");
    setCreated(b.code);
    setCopied(false);
    setLabel("");
    setBound("");
    await reload();
  };
  const revoke = async (id: number) => {
    if (!confirm("Revoke this code? Nobody can use it after this. People who already joined stay members.")) return;
    const r = await fetch(`/api/admin/codes?id=${id}`, { method: "DELETE" });
    say(r.ok ? "Code revoked." : "Could not revoke it.");
    await reload();
  };
  const field = "w-full h-10 sm:h-9 bg-bg border border-line rounded-md px-3 outline-none focus:border-accent/70";

  return (
    <div className="space-y-4">
      <Panel title="New invite code" sub="Share it with the people you want to let in. A use only counts once they confirm their email.">
        <div className="p-4 space-y-4">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <label className="block">
              <div className="text-dim text-[12px] mb-1">Uses</div>
              <input type="number" min={1} max={1000} value={uses} onChange={(e) => setUses(e.target.value)} className={`${field} num`} />
            </label>
            <label className="block">
              <div className="text-dim text-[12px] mb-1 flex items-center gap-2">
                Expires in days
                <span className="inline-flex items-center gap-1 text-faint">
                  <input type="checkbox" checked={never} onChange={(e) => setNever(e.target.checked)} /> never
                </span>
              </div>
              <input type="number" min={1} max={365} disabled={never} value={days} onChange={(e) => setDays(e.target.value)} className={`${field} num disabled:opacity-40`} />
            </label>
            <label className="block">
              <div className="text-dim text-[12px] mb-1">Label (optional)</div>
              <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Debbie's group" className={field} />
            </label>
            <label className="block">
              <div className="text-dim text-[12px] mb-1">
                <Hint tip="Only this email can redeem the code. Safest for inviting one person: a leaked code is useless to anyone else.">
                  <span>Only for this email (optional)</span>
                </Hint>
              </div>
              <input type="email" value={bound} onChange={(e) => setBound(e.target.value)} placeholder="anyone with the code" className={field} />
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button kind="primary" onClick={create} disabled={busy}>
              {busy ? <Spinner /> : null} Generate code
            </Button>
            {err && <span className="text-bad text-[12.5px]">{err}</span>}
          </div>
          {created && (
            <div className="rounded-lg border border-accent/40 bg-accent/[0.07] p-4">
              <div className="text-[12px] text-dim">New code. Copy it now: it is not shown again.</div>
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <span className="mono text-[20px] sm:text-[22px] tracking-wider select-all">{created}</span>
                <Button
                  size="sm"
                  onClick={() =>
                    navigator.clipboard.writeText(created).then(() => {
                      setCopied(true);
                    })
                  }
                >
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
              <div className="text-faint text-[12px] mt-2">They sign in at the login page, tap “I have an invite code”, and enter it with their email.</div>
            </div>
          )}
        </div>
      </Panel>

      <Panel title="Codes" sub="Codes are stored as fingerprints; only the last 4 characters are shown.">
        {d.codes.length === 0 ? (
          <Empty>No codes yet.</Empty>
        ) : (
          <ul className="divide-y divide-line">
            {d.codes.map((c) => (
              <li key={c.id} className="px-4 py-3 flex flex-wrap items-center gap-x-4 gap-y-1.5">
                <span className="mono">ELMN-····-{c.hint}</span>
                <CodeStatus s={c.status} />
                <span className="text-[13px] num">
                  {c.uses}/{c.max_uses} used
                </span>
                {c.label && <span className="text-dim text-[13px]">{c.label}</span>}
                {c.bound_email && <span className="text-faint text-[12.5px]">only {c.bound_email}</span>}
                <span className="text-faint text-[12px]">
                  {c.expires_at ? (c.expires_at > Date.now() ? `expires ${fmtDate(c.expires_at)}` : `expired ${fmtDate(c.expires_at)}`) : "never expires"}
                </span>
                {c.redeemedBy.length > 0 && <span className="text-faint text-[12px] w-full sm:w-auto">joined: {c.redeemedBy.join(", ")}</span>}
                <span className="sm:ml-auto flex items-center gap-3">
                  <span className="text-faint text-[11.5px]">
                    by {c.created_by} · {ago(c.created_at)}
                  </span>
                  {c.status === "active" && (
                    <Button size="sm" kind="danger" onClick={() => revoke(c.id)}>
                      Revoke
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function CodeStatus({ s }: { s: string }) {
  const c = s === "active" ? "text-good border-good/35" : s === "revoked" ? "text-bad border-bad/35" : "text-faint border-line-2";
  return <span className={`px-2 py-0.5 rounded-full border text-[11px] ${c}`}>{s}</span>;
}

// ---------- members ----------

function Members({ d, reload, say }: P) {
  const [temp, setTemp] = useState<{ email: string; password: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const reset = async (email: string) => {
    if (!confirm(`Reset the password for ${email}? Their current password stops working. You get a temporary one to send them, and they choose their own when they next sign in.`)) return;
    const r = await fetch("/api/admin/members/password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) });
    const b = await r.json().catch(() => ({}));
    if (!r.ok) return say(b.error ?? "Could not reset the password.");
    setTemp({ email, password: b.password });
    setCopied(false);
    await reload();
  };
  const remove = async (email: string) => {
    if (!confirm(`Remove ${email}? They lose access immediately, even if signed in. Their past runs are not deleted.`)) return;
    const r = await fetch(`/api/admin/members?email=${encodeURIComponent(email)}`, { method: "DELETE" });
    const b = await r.json().catch(() => ({}));
    say(r.ok ? `${email} removed.` : b.error ?? "Could not remove.");
    await reload();
  };
  return (
    <div className="space-y-4">
      <Panel title="Admins" sub="Set in ELMON_ADMIN_EMAILS on the server. They cannot be removed from here.">
        <ul className="divide-y divide-line">
          {d.admins.map((a) => (
            <li key={a} className="px-4 py-2.5 flex items-center gap-2 text-[13px]">
              <span className="px-1.5 py-px rounded border border-accent/40 text-accent-ink text-[11px]">admin</span>
              {a}
            </li>
          ))}
        </ul>
      </Panel>
      {temp && (
        <div className="rounded-lg border border-accent/40 bg-accent/[0.07] p-4">
          <div className="text-[12px] text-dim">
            Temporary password for <span className="text-ink">{temp.email}</span>. Copy it now: it is not shown again. Send it to them privately.
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <span className="mono text-[18px] sm:text-[20px] tracking-wide select-all">{temp.password}</span>
            <Button size="sm" onClick={() => navigator.clipboard.writeText(temp.password).then(() => setCopied(true))}>
              {copied ? "Copied" : "Copy"}
            </Button>
            <Button size="sm" kind="ghost" onClick={() => setTemp(null)}>
              Done
            </Button>
          </div>
          <div className="text-faint text-[12px] mt-2">They sign in with it, and the app asks them to choose their own password straight away.</div>
        </div>
      )}
      <Panel title="Members" sub="People who joined with an invite code.">
        {d.members.length === 0 ? (
          <Empty title="No members yet">Create an invite code and share it.</Empty>
        ) : (
          <ul className="divide-y divide-line">
            {d.members.map((m) => (
              <li key={m.email} className="px-4 py-3 flex flex-wrap items-center gap-x-4 gap-y-1">
                <span className="text-[13.5px] min-w-0 break-all">{m.email}</span>
                <span className="text-faint text-[12px]">joined {ago(m.joined_at)}</span>
                <span className="text-faint text-[12px]">{m.last_seen ? `seen ${ago(m.last_seen)}` : "not seen yet"}</span>
                <span className="text-dim text-[12px] num">
                  {m.runs_month} runs · {Number(m.credits_month).toLocaleString()} credits this month
                </span>
                {m.code_hint && <span className="text-faint text-[11.5px] mono">via …{m.code_hint}</span>}
                <span className="ml-auto flex gap-2">
                  <Button size="sm" onClick={() => reset(m.email)}>
                    Reset password
                  </Button>
                  <Button size="sm" kind="danger" onClick={() => remove(m.email)}>
                    Remove
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

// ---------- all runs ----------

function AllRuns({ d, reload, say }: P) {
  const act = async (id: number, what: "stop" | "clear") => {
    if (what === "clear" && !confirm(`Clear run #${id} and its results? Saved chain data is kept.`)) return;
    const r = await fetch(what === "stop" ? `/api/runs/${id}/cancel` : `/api/runs/${id}`, { method: what === "stop" ? "POST" : "DELETE" });
    const b = await r.json().catch(() => ({}));
    say(r.ok ? (what === "stop" ? `Stopping run #${id}.` : `Run #${id} cleared.`) : b.error ?? "Could not do that.");
    await reload();
  };
  return (
    <Panel title="All runs" sub="Everyone's runs, live ones first. Open any run to see its results.">
      {d.runs.length === 0 ? (
        <Empty>No runs.</Empty>
      ) : (
        <ul className="divide-y divide-line">
          {d.runs.map((r) => {
            const live = ["queued", "running", "cancelling"].includes(r.status);
            const p = r.progress as { stage?: string; note?: string | null };
            return (
              <li key={r.id} className="px-4 py-3 flex flex-wrap items-center gap-x-4 gap-y-1.5">
                <Link href={`/runs/${r.id}`} className="font-medium hover:text-accent-ink truncate max-w-[60vw] sm:max-w-xs">
                  {r.label || `Run #${r.id}`}
                </Link>
                <StatusPill status={r.status} />
                {r.priority > 0 && (
                  <Hint tip="Started by an admin: goes ahead of member runs in the queue.">
                    <span className="text-[11px] text-accent-ink border border-accent/35 rounded px-1.5">priority</span>
                  </Hint>
                )}
                <span className="text-faint text-[12px] truncate">{r.created_by_email ?? "CLI"}</span>
                <span className="text-faint text-[12px]">
                  {r.inputs} {r.mode} · {ago(r.created_at)} · {Number(r.credits).toLocaleString()} credits
                </span>
                {live && p.note && <span className="text-dim text-[12px] w-full truncate">{p.note}</span>}
                {r.error && !live && <span className="text-warn text-[12px] w-full truncate">{r.error}</span>}
                <span className="sm:ml-auto flex gap-2">
                  {live && r.status !== "cancelling" && (
                    <Button size="sm" kind="danger" onClick={() => act(r.id, "stop")}>
                      Stop
                    </Button>
                  )}
                  {!live && (
                    <Button size="sm" kind="ghost" onClick={() => act(r.id, "clear")}>
                      Clear
                    </Button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

// ---------- settings ----------

const SETTING_FIELDS: { k: keyof AppSettings; label: string; help: string; group: string }[] = [
  { k: "maxLiveMember", label: "Live runs per member", help: "Runs a member can have queued or running at once.", group: "Limits" },
  { k: "maxBudgetMember", label: "Max run budget, member (credits)", help: "The largest per-run budget a member may set.", group: "Limits" },
  { k: "maxLiveAdmin", label: "Live runs per admin", help: "Runs an admin can have queued or running at once.", group: "Limits" },
  { k: "maxBudgetAdmin", label: "Max run budget, admin (credits)", help: "The largest per-run budget an admin may set.", group: "Limits" },
  { k: "resultTtlDays", label: "Keep results (days)", help: "Runs and their results are deleted after this many days.", group: "Retention" },
  { k: "afterExportTtlHours", label: "Keep after export (hours)", help: "…or this long after the first export, whichever comes first.", group: "Retention" },
  { k: "historyKeepDays", label: "Keep unused wallet histories (days)", help: "Saved trade histories nobody needed for this long are dropped to save space.", group: "Retention" },
  { k: "codeDefaultUses", label: "New code: uses", help: "Default uses for a new invite code.", group: "Invites" },
  { k: "codeDefaultDays", label: "New code: expires after (days)", help: "Default expiry for a new invite code.", group: "Invites" },
];

function Settings({ d, reload, say }: P) {
  const [form, setForm] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(d.settings).map(([k, v]) => [k, String(v)])));
  const [monthly, setMonthly] = useState(d.credits.limit ? String(d.credits.limit) : "");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setErr(null);
    const body: Record<string, unknown> = { ...form, pauseNewRuns: d.settings.pauseNewRuns };
    body.monthlyCredits = monthly.trim() === "" ? null : Number(monthly);
    const r = await fetch("/api/admin/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const b = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) return setErr(b.error ?? "Could not save.");
    say("Settings saved. They apply to new runs right away.");
    await reload();
  };
  const groups = [...new Set(SETTING_FIELDS.map((f) => f.group))];
  const field = "w-full h-10 sm:h-9 bg-bg border border-line rounded-md px-3 outline-none focus:border-accent/70 num";
  return (
    <Panel title="Settings" sub="Changes apply immediately. No deploy needed.">
      <div className="p-4 space-y-5">
        {groups.map((g) => (
          <div key={g}>
            <div className="text-[11px] uppercase tracking-wider text-faint mb-2">{g}</div>
            <div className="grid sm:grid-cols-2 xl:grid-cols-4 gap-3">
              {SETTING_FIELDS.filter((f) => f.group === g).map((f) => (
                <label key={f.k} className="block">
                  <div className="text-dim text-[12px] mb-1">
                    <Hint tip={f.help}>
                      <span>{f.label}</span>
                    </Hint>
                  </div>
                  <input type="number" value={form[f.k] ?? ""} onChange={(e) => setForm((s) => ({ ...s, [f.k]: e.target.value }))} className={field} />
                </label>
              ))}
            </div>
          </div>
        ))}
        <div>
          <div className="text-[11px] uppercase tracking-wider text-faint mb-2">Defaults and credits</div>
          <div className="grid sm:grid-cols-2 xl:grid-cols-4 gap-3">
            <label className="block">
              <div className="text-dim text-[12px] mb-1">Default depth for new runs</div>
              <select value={form.defaultPreset} onChange={(e) => setForm((s) => ({ ...s, defaultPreset: e.target.value }))} className="w-full h-10 sm:h-9 bg-bg border border-line rounded-md px-2">
                <option value="cheap">Cheap</option>
                <option value="balanced">Balanced</option>
                <option value="deep">Deep</option>
              </select>
            </label>
            <label className="block">
              <div className="text-dim text-[12px] mb-1">
                <Hint tip="Your Helius plan's monthly credits. All runs stop at 98% of this. Leave empty to use HELIUS_MONTHLY_CREDITS on the worker.">
                  <span>Monthly credit limit</span>
                </Hint>
              </div>
              <input type="number" value={monthly} onChange={(e) => setMonthly(e.target.value)} placeholder="from environment" className={field} />
            </label>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button kind="primary" onClick={save} disabled={busy}>
            {busy ? <Spinner /> : null} Save settings
          </Button>
          {err && <span className="text-bad text-[12.5px]">{err}</span>}
        </div>
      </div>
    </Panel>
  );
}

// ---------- activity ----------

const ACTION_LABEL: Record<string, string> = {
  "code.created": "created an invite code",
  "code.revoked": "revoked an invite code",
  "member.joined": "joined",
  "member.removed": "removed a member",
  "member.password_reset": "reset a member's password",
  "run.stopped": "stopped someone's run",
  "run.cleared": "cleared someone's run",
  "settings.changed": "changed settings",
};

function Activity({ d }: { d: AdminOverview }) {
  return (
    <Panel title="Activity" sub="The last 100 admin and access events.">
      {d.audit.length === 0 ? (
        <Empty>Nothing yet.</Empty>
      ) : (
        <ul className="divide-y divide-line">
          {d.audit.map((a) => (
            <li key={a.id} className="px-4 py-2.5 text-[13px] flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="text-faint text-[12px] w-full sm:w-36 shrink-0">{fmtDate(a.ts)}</span>
              <span className="break-all">{a.actor}</span>
              <span className="text-dim">{ACTION_LABEL[a.action] ?? a.action}</span>
              {a.target && <span className="mono text-[12px] break-all">{a.target}</span>}
              {a.detail != null && <Detail v={a.detail} />}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function Detail({ v }: { v: unknown }): ReactNode {
  if (!v || typeof v !== "object") return null;
  const parts = Object.entries(v as Record<string, unknown>)
    .filter(([, x]) => x != null && x !== "")
    .map(([k, x]) => `${k}: ${String(x)}`);
  return parts.length ? <span className="text-faint text-[12px] w-full sm:w-auto">{parts.join(" · ")}</span> : null;
}
