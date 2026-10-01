"use client";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Button, Spinner } from "../components/ui";

export default function LoginPage() {
  return (
    <Suspense>
      <Login />
    </Suspense>
  );
}

function Login() {
  const q = useSearchParams();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [showCode, setShowCode] = useState(false);
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const initialError = {
    link: "That sign-in link has expired or was already used. Send a new one.",
    code: "Your invite code ran out or was revoked before you clicked the link. Ask your admin for a new one.",
    access: "This email does not have access yet. Enter the invite code your admin gave you.",
  }[q.get("error") ?? ""] ?? null;
  const [error, setError] = useState<string | null>(initialError);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setState("sending");
    setError(null);
    const r = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, code: code.trim() || undefined, next: q.get("next") ?? "/" }),
    }).catch(() => null);
    const b = r ? await r.json().catch(() => ({})) : {};
    if (!r || !r.ok) {
      setError(b.error ?? "Could not send the link. Try again.");
      setState("idle");
      return;
    }
    setState("sent");
  }

  return (
    <div className="min-h-screen grid place-items-center px-4">
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
        <div className="rounded-xl border border-line bg-panel p-6">
          {state === "sent" ? (
            <div className="text-center">
              <div className="font-medium">Check your email</div>
              <p className="text-dim mt-1.5">If {email} has access, a sign-in link is on its way. It works once.</p>
              <button className="text-accent-ink mt-4 text-[12.5px] hover:underline" onClick={() => setState("idle")}>
                Use a different email
              </button>
            </div>
          ) : (
            <form onSubmit={send} className="space-y-4">
              <div>
                <div className="font-medium">Sign in</div>
                <p className="text-dim text-[12.5px] mt-1">We email you a one-time link. Access is by invitation.</p>
              </div>
              <input
                type="email"
                required
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@team.com"
                className="w-full h-11 sm:h-10 bg-bg border border-line rounded-lg px-3 outline-none focus:border-accent/70"
              />
              {showCode || q.get("error") === "access" ? (
                <div>
                  <label className="block text-dim text-[12.5px] mb-1.5" htmlFor="code">
                    Invite code
                  </label>
                  <input
                    id="code"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder="ELMN-XXXX-XXXX"
                    autoComplete="off"
                    spellCheck={false}
                    className="w-full h-11 sm:h-10 bg-bg border border-line rounded-lg px-3 mono uppercase tracking-wider outline-none focus:border-accent/70"
                  />
                  <p className="text-faint text-[11.5px] mt-1.5">Only needed the first time. Your code is used once you click the email link.</p>
                </div>
              ) : (
                <button type="button" onClick={() => setShowCode(true)} className="text-accent-ink text-[12.5px] hover:underline">
                  New here? I have an invite code
                </button>
              )}
              {error && <div className="text-bad text-[12.5px]">{error}</div>}
              <div className="flex">
                <Button kind="primary" size="lg" type="submit" disabled={state === "sending" || !email}>
                  {state === "sending" ? <Spinner /> : null}
                  Email me a link
                </Button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
