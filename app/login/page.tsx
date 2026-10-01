"use client";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button, Segmented, Spinner } from "../components/ui";

export default function LoginPage() {
  return (
    <Suspense>
      <Login />
    </Suspense>
  );
}

const MIN = 10;

function Login() {
  const q = useSearchParams();
  const router = useRouter();
  const [mode, setMode] = useState<"signin" | "join">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [code, setCode] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const next = q.get("next") ?? "/";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (mode === "join") {
      if (password.length < MIN) return setError(`Use at least ${MIN} characters for your password.`);
      if (password !== confirm) return setError("The two passwords do not match.");
    }
    setBusy(true);
    const r = await fetch(mode === "signin" ? "/api/auth/login" : "/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(mode === "signin" ? { email, password } : { email, password, code }),
    }).catch(() => null);
    const b = r ? await r.json().catch(() => ({})) : {};
    setBusy(false);
    if (!r || !r.ok) return setError(b.error ?? "Something went wrong. Try again.");
    if (b.signIn) {
      setMode("signin");
      return setError(b.message);
    }
    const target = b.mustChangePassword ? "/account?reset=1" : next.startsWith("/") && !next.startsWith("//") ? next : "/";
    router.replace(target);
    router.refresh();
  }

  const field = "w-full h-11 sm:h-10 bg-bg border border-line rounded-lg px-3 outline-none focus:border-accent/70";
  return (
    <div className="min-h-screen grid place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-2.5 mb-8 justify-center">
          <svg viewBox="0 0 32 32" className="size-9" aria-hidden>
            <rect width="32" height="32" rx="8" fill="var(--color-panel-2)" />
            <path d="M7 22l6-7 4 4 8-10" fill="none" stroke="var(--color-accent)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
            <circle cx="25" cy="9" r="2.6" fill="var(--color-series-2)" />
          </svg>
          <div>
            <div className="font-semibold text-[17px] tracking-tight leading-5">Elmon</div>
            <div className="text-[10.5px] uppercase tracking-[0.14em] text-faint">Analytics</div>
          </div>
        </div>
        <div className="rounded-xl border border-line bg-panel p-5 sm:p-6">
          <div className="flex justify-center mb-5">
            <Segmented
              value={mode}
              onChange={(m) => {
                setMode(m);
                setError(null);
              }}
              options={[
                { v: "signin", label: "Sign in" },
                { v: "join", label: "I have an invite code" },
              ]}
            />
          </div>
          <form onSubmit={submit} className="space-y-3.5">
            <label className="block">
              <div className="text-dim text-[12.5px] mb-1.5">Email</div>
              <input type="email" required autoFocus autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@team.com" className={field} />
            </label>
            <label className="block">
              <div className="flex items-center justify-between text-dim text-[12.5px] mb-1.5">
                <span>{mode === "join" ? "Choose a password" : "Password"}</span>
                <button type="button" onClick={() => setShow((v) => !v)} className="text-faint hover:text-ink text-[12px]">
                  {show ? "Hide" : "Show"}
                </button>
              </div>
              <input
                type={show ? "text" : "password"}
                required
                autoComplete={mode === "join" ? "new-password" : "current-password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={field}
              />
              {mode === "join" && <div className="text-faint text-[11.5px] mt-1">At least {MIN} characters.</div>}
            </label>
            {mode === "join" && (
              <>
                <label className="block">
                  <div className="text-dim text-[12.5px] mb-1.5">Repeat password</div>
                  <input type={show ? "text" : "password"} required autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className={field} />
                </label>
                <label className="block">
                  <div className="text-dim text-[12.5px] mb-1.5">Invite code</div>
                  <input
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder="ELMN-XXXX-XXXX"
                    autoComplete="off"
                    spellCheck={false}
                    className={`${field} mono uppercase tracking-wider`}
                  />
                  <div className="text-faint text-[11.5px] mt-1">From your admin. Only needed once. (Admins: use the admin setup code.)</div>
                </label>
              </>
            )}
            {error && <div className="text-bad text-[12.5px]">{error}</div>}
            <div className="pt-1 [&>button]:w-full">
              <Button kind="primary" size="lg" type="submit" disabled={busy || !email || !password}>
                {busy ? <Spinner /> : null}
                {mode === "signin" ? "Sign in" : "Create my account"}
              </Button>
            </div>
            {mode === "signin" && <p className="text-faint text-[12px] text-center">Forgot your password? Ask your admin to reset it.</p>}
          </form>
        </div>
      </div>
    </div>
  );
}
