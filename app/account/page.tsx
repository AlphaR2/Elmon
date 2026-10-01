"use client";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button, Panel, Spinner } from "../components/ui";
import { useMe } from "../components/Shell";

export default function AccountPage() {
  return (
    <Suspense>
      <Account />
    </Suspense>
  );
}

function Account() {
  const me = useMe();
  const q = useSearchParams();
  const router = useRouter();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const forced = q.get("reset") === "1" || !!me?.mustChangePassword;
  const [leaving, setLeaving] = useState(false);
  const signOut = async (everywhere: boolean) => {
    if (everywhere && !confirm("Sign out on every device where this account is signed in?")) return;
    setLeaving(true);
    await fetch("/api/auth/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ everywhere }) }).catch(() => {});
    router.replace("/login");
    router.refresh();
  };

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (next !== repeat) return setMsg({ ok: false, text: "The two new passwords do not match." });
    setBusy(true);
    const r = await fetch("/api/auth/password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ current, next }) }).catch(() => null);
    const b = r ? await r.json().catch(() => ({})) : {};
    setBusy(false);
    if (!r || !r.ok) return setMsg({ ok: false, text: b.error ?? "Could not change the password." });
    setCurrent("");
    setNext("");
    setRepeat("");
    setMsg({ ok: true, text: "Password changed." });
    if (forced) setTimeout(() => router.replace("/"), 1200);
  }

  const field = "w-full h-11 sm:h-10 bg-bg border border-line rounded-lg px-3 outline-none focus:border-accent/70";
  return (
    <div className="max-w-md space-y-4">
      <div>
        <h1 className="text-[19px] sm:text-[22px] font-semibold tracking-tight">Account</h1>
        <p className="text-dim mt-1">
          {me ? (
            <>
              Signed in as <span className="text-ink">{me.email}</span>
              {me.role === "admin" ? " (admin)" : ""}.
            </>
          ) : (
            "Loading…"
          )}
        </p>
      </div>
      {forced && (
        <div className="rounded-lg border border-warn/40 bg-warn/[0.06] px-4 py-2.5 text-[12.5px] text-warn">
          Your password was reset by an admin. Choose your own now: enter the temporary one as the current password.
        </div>
      )}
      <Panel title="Sign out" sub="Sign out here, or everywhere you are signed in (other browsers, your phone).">
        <div className="p-4 flex flex-wrap gap-2">
          <Button onClick={() => signOut(false)} disabled={leaving}>
            Sign out
          </Button>
          <Button kind="danger" onClick={() => signOut(true)} disabled={leaving}>
            Sign out of all devices
          </Button>
        </div>
      </Panel>
      <Panel title="Change password">
        <form onSubmit={save} className="p-4 space-y-3.5">
          <label className="block">
            <div className="flex items-center justify-between text-dim text-[12.5px] mb-1.5">
              <span>Current password</span>
              <button type="button" onClick={() => setShow((v) => !v)} className="text-faint hover:text-ink text-[12px]">
                {show ? "Hide" : "Show"}
              </button>
            </div>
            <input type={show ? "text" : "password"} required autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} className={field} />
          </label>
          <label className="block">
            <div className="text-dim text-[12.5px] mb-1.5">New password</div>
            <input type={show ? "text" : "password"} required autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} className={field} />
            <div className="text-faint text-[11.5px] mt-1">At least 10 characters.</div>
          </label>
          <label className="block">
            <div className="text-dim text-[12.5px] mb-1.5">Repeat new password</div>
            <input type={show ? "text" : "password"} required autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} className={field} />
          </label>
          {msg && <div className={`text-[12.5px] ${msg.ok ? "text-good" : "text-bad"}`}>{msg.text}</div>}
          <div className="[&>button]:w-full sm:[&>button]:w-auto">
            <Button kind="primary" type="submit" disabled={busy || !current || !next}>
              {busy ? <Spinner /> : null} Change password
            </Button>
          </div>
        </form>
      </Panel>
    </div>
  );
}
