"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

export interface Me {
  email: string;
  role: "admin" | "member";
  workerOnline: boolean;
  heliusConfigured: boolean;
  creditsLeft: number;
  paused: boolean;
  defaultPreset: "cheap" | "balanced" | "deep";
  maxBudget: number;
  maxLive: number;
}

const MeCtx = createContext<Me | null>(null);
export const useMe = () => useContext(MeCtx);

const NAV = [
  { href: "/", label: "New analysis", icon: IconPlus, match: (p: string) => p === "/" },
  { href: "/runs", label: "Runs", icon: IconList, match: (p: string) => p.startsWith("/runs") },
  { href: "/watchlist", label: "Watchlist", icon: IconStar, match: (p: string) => p.startsWith("/watchlist") },
];

export function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const bare = path === "/login";
  const [me, setMe] = useState<Me | null>(null);

  const load = useCallback(async () => {
    const r = await fetch("/api/me").catch(() => null);
    if (r?.status === 401) router.replace(`/login?next=${encodeURIComponent(path)}`);
    if (r?.ok) setMe(await r.json());
  }, [path, router]);
  useEffect(() => {
    if (bare) return;
    void load();
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, [bare, load]);

  if (bare) return <>{children}</>;
  // Admins get an extra tab. The admin API answers "not found" to everyone else, so this is only navigation.
  const nav = me?.role === "admin" ? [...NAV, ADMIN_NAV] : NAV;

  const signOut = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
  };

  return (
    <MeCtx.Provider value={me}>
      <div className="min-h-screen lg:grid lg:grid-cols-[220px_1fr]">
        <aside className="hidden lg:flex flex-col border-r border-line bg-panel/60 sticky top-0 h-screen">
          <Link href="/" className="flex items-center gap-2.5 px-5 h-16">
            <Logo />
            <span className="leading-tight">
              <span className="block font-semibold tracking-tight text-[15px]">Elmon</span>
              <span className="block text-[10.5px] uppercase tracking-[0.14em] text-faint">Analytics</span>
            </span>
          </Link>
          <nav className="px-3 mt-2 space-y-0.5">
            {nav.map((n) => {
              const active = n.match(path);
              return (
                <Link
                  key={n.href}
                  href={n.href}
                  className={`flex items-center gap-2.5 h-9 px-3 rounded-md transition ${active ? "bg-panel-2 text-ink" : "text-dim hover:text-ink hover:bg-panel-2/60"}`}
                >
                  <n.icon active={active} />
                  {n.label}
                </Link>
              );
            })}
          </nav>
          <div className="mt-auto p-3 space-y-2">
            <WorkerState me={me} />
            {me && (
              <div className="flex items-center gap-2 px-2 py-2 rounded-md border border-line bg-panel">
                <span className="grid place-items-center size-7 rounded-full bg-raise text-[11px] font-medium uppercase">{me.email.slice(0, 1)}</span>
                <span className="min-w-0 flex-1 truncate text-[12px] text-dim" title={me.email}>
                  {me.email}
                </span>
                <button onClick={signOut} className="text-faint hover:text-ink text-[11.5px]" title="Sign out">
                  Sign out
                </button>
              </div>
            )}
          </div>
        </aside>

        {/* Phones and tablets: slim top bar, tabs at the bottom like a native app */}
        <header className="lg:hidden sticky top-0 z-30 border-b border-line bg-panel/90 backdrop-blur">
          <div className="flex items-center gap-3 px-4 h-14">
            <Link href="/" className="flex items-center gap-2">
              <Logo />
              <span className="leading-tight">
                <span className="block font-semibold tracking-tight text-[15px]">Elmon</span>
                <span className="block text-[9.5px] uppercase tracking-[0.14em] text-faint">Analytics</span>
              </span>
            </Link>
            <div className="ml-auto flex items-center gap-3">
              {me && (
                <span
                  className={`size-2.5 rounded-full ${me.workerOnline && me.heliusConfigured ? "bg-good" : "bg-warn animate-pulse-soft"}`}
                  title={me.workerOnline ? "Worker online" : "Worker offline: runs will wait in the queue"}
                />
              )}
              {me && (
                <button onClick={signOut} className="h-9 px-3 rounded-md border border-line-2 text-[13px] text-dim" title={me.email}>
                  Sign out
                </button>
              )}
            </div>
          </div>
        </header>

        <main className="min-w-0 px-4 sm:px-6 lg:px-8 pt-5 pb-28 lg:py-6 max-w-[1560px] w-full">{children}</main>

        <nav className="lg:hidden fixed bottom-0 inset-x-0 z-30 border-t border-line bg-panel/95 backdrop-blur pb-safe" aria-label="Main">
          <div className={`grid ${nav.length === 4 ? "grid-cols-4" : "grid-cols-3"}`}>
            {nav.map((n) => {
              const active = n.match(path);
              return (
                <Link
                  key={n.href}
                  href={n.href}
                  className={`flex flex-col items-center justify-center gap-1 h-16 text-[11.5px] ${active ? "text-ink" : "text-faint"}`}
                  aria-current={active ? "page" : undefined}
                >
                  <span className={`grid place-items-center h-7 w-12 rounded-full ${active ? "bg-accent/15" : ""}`}>
                    <n.icon active={active} />
                  </span>
                  {n.label.replace("New analysis", "New")}
                </Link>
              );
            })}
          </div>
        </nav>
      </div>
    </MeCtx.Provider>
  );
}

function WorkerState({ me }: { me: Me | null }) {
  if (!me) return null;
  const ok = me.workerOnline && me.heliusConfigured;
  return (
    <div className="hint hint-left flex items-center gap-2 px-2 text-[11.5px] text-faint" tabIndex={0}>
      <span className={`size-2 rounded-full ${ok ? "bg-good" : "bg-warn animate-pulse-soft"}`} />
      {ok ? "Worker online" : !me.workerOnline ? "Worker offline" : "Worker has no Helius key"}
      <span className="hint-bubble">
        {ok
          ? "The background worker is running. Runs start within seconds."
          : !me.workerOnline
            ? "No worker has checked in for a while. Runs will wait in the queue until it is back."
            : "The worker is running but HELIUS_API_KEY is not set on it."}
      </span>
    </div>
  );
}

function Logo() {
  return (
    <svg viewBox="0 0 32 32" className="size-7" aria-hidden>
      <rect width="32" height="32" rx="8" fill="var(--color-panel-2)" />
      <path d="M7 22l6-7 4 4 8-10" fill="none" stroke="var(--color-accent)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="25" cy="9" r="2.6" fill="var(--color-series-2)" />
    </svg>
  );
}

const ADMIN_NAV = { href: "/admin", label: "Admin", icon: IconShield, match: (p: string) => p.startsWith("/admin") };

function IconShield({ active }: { active: boolean }) {
  return (
    <svg viewBox="0 0 16 16" className={`size-4 ${active ? "text-accent" : ""}`} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
      <path d="M8 1.6l5.4 2v4.1c0 3.2-2.3 5.6-5.4 6.7-3.1-1.1-5.4-3.5-5.4-6.7V3.6z" />
      <path d="M5.8 8l1.6 1.6 2.9-3" strokeLinecap="round" />
    </svg>
  );
}

function IconPlus({ active }: { active: boolean }) {
  return (
    <svg viewBox="0 0 16 16" className={`size-4 ${active ? "text-accent" : ""}`} fill="none" stroke="currentColor" strokeWidth="1.6">
      <rect x="1.5" y="1.5" width="13" height="13" rx="3" />
      <path d="M8 5v6M5 8h6" strokeLinecap="round" />
    </svg>
  );
}
function IconList({ active }: { active: boolean }) {
  return (
    <svg viewBox="0 0 16 16" className={`size-4 ${active ? "text-accent" : ""}`} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <path d="M5.5 4h8M5.5 8h8M5.5 12h8" />
      <circle cx="2.5" cy="4" r=".6" fill="currentColor" />
      <circle cx="2.5" cy="8" r=".6" fill="currentColor" />
      <circle cx="2.5" cy="12" r=".6" fill="currentColor" />
    </svg>
  );
}
function IconStar({ active }: { active: boolean }) {
  return (
    <svg viewBox="0 0 16 16" className={`size-4 ${active ? "text-accent" : ""}`} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
      <path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.2L8 11.5l-3.8 2 .7-4.2-3.1-3 4.3-.6z" />
    </svg>
  );
}
