// Loading skeletons: grey blocks in the shape of what is coming, so the page does not jump when data arrives.
// No hooks, so they work both in client pages and in route-level loading.tsx files. Screen readers hear "Loading".

export function Skeleton({ className = "", style }: { className?: string; style?: React.CSSProperties }) {
  return <span aria-hidden className={`skeleton block ${className}`} style={style} />;
}

function Busy({ children, label = "Loading" }: { children: React.ReactNode; label?: string }) {
  return (
    <div role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

export function SkeletonLines({ n = 3, className = "" }: { n?: number; className?: string }) {
  return (
    <div className={`space-y-2 ${className}`}>
      {Array.from({ length: n }, (_, i) => (
        <Skeleton key={i} className="h-3.5" style={{ width: `${[92, 78, 64, 85, 70][i % 5]}%` }} />
      ))}
    </div>
  );
}

function PanelShell({ children, title = true }: { children: React.ReactNode; title?: boolean }) {
  return (
    <section className="bg-panel border border-line rounded-xl">
      {title && (
        <div className="px-4 py-3.5 border-b border-line space-y-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-3 w-64 max-w-full" />
        </div>
      )}
      {children}
    </section>
  );
}

export function StatSkeletons({ n = 4 }: { n?: number }) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="rounded-xl border border-line bg-panel px-3.5 sm:px-4 py-3 space-y-2">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-6 w-16" />
          <Skeleton className="h-3 w-32 max-w-full" />
        </div>
      ))}
    </div>
  );
}

// A list of rows (runs, members, codes, watchlist entries).
export function ListSkeleton({ rows = 5, title = true }: { rows?: number; title?: boolean }) {
  return (
    <Busy>
      <PanelShell title={title}>
        <ul className="divide-y divide-line">
          {Array.from({ length: rows }, (_, i) => (
            <li key={i} className="flex items-center gap-3 px-4 py-3.5">
              <div className="flex-1 space-y-2 min-w-0">
                <Skeleton className="h-3.5" style={{ width: `${[55, 40, 62, 48, 58][i % 5]}%` }} />
                <Skeleton className="h-3" style={{ width: `${[35, 50, 28, 42, 38][i % 5]}%` }} />
              </div>
              <Skeleton className="h-6 w-14 rounded-full" />
            </li>
          ))}
        </ul>
      </PanelShell>
    </Busy>
  );
}

// A wide table (traders, watchlist on desktop).
export function TableSkeleton({ rows = 8, cols = 8 }: { rows?: number; cols?: number }) {
  return (
    <div className="divide-y divide-line">
      <div className="flex gap-4 px-4 py-3">
        {Array.from({ length: cols }, (_, c) => (
          <Skeleton key={c} className="h-3 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex items-center gap-4 px-4 py-3.5">
          {Array.from({ length: cols }, (_, c) => (
            <Skeleton key={c} className="h-3.5 flex-1" style={{ opacity: c === 0 ? 1 : 0.7 }} />
          ))}
        </div>
      ))}
    </div>
  );
}

function ChartSkeleton({ height = 280 }: { height?: number }) {
  return (
    <div className="p-4">
      <div className="flex gap-4 mb-3">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-3 w-16" />
      </div>
      <div className="relative rounded-lg border border-line/60" style={{ height }}>
        {[20, 45, 70].map((top) => (
          <div key={top} className="absolute inset-x-0 border-t border-line/50" style={{ top: `${top}%` }} />
        ))}
        {[[22, 30], [38, 55], [61, 40], [72, 22], [48, 68], [80, 60]].map(([l, t], i) => (
          <Skeleton key={i} className="absolute size-3 rounded-full" style={{ left: `${l}%`, top: `${t}%` }} />
        ))}
      </div>
    </div>
  );
}

// The whole run page: header, four stat tiles, tabs, chart + top picks, table.
export function RunPageSkeleton() {
  return (
    <Busy label="Loading run">
      <div className="space-y-5">
        <div className="flex flex-wrap items-start gap-4">
          <div className="space-y-2.5">
            <Skeleton className="h-3 w-12" />
            <Skeleton className="h-6 w-56 max-w-[70vw]" />
            <Skeleton className="h-3 w-72 max-w-[80vw]" />
          </div>
          <div className="w-full sm:w-auto sm:ml-auto flex gap-2">
            <Skeleton className="h-10 sm:h-8 w-24" />
            <Skeleton className="h-10 sm:h-8 w-20" />
          </div>
        </div>
        <StatSkeletons />
        <div className="flex gap-5 border-b border-line pb-3">
          {[64, 60, 70, 56, 40].map((w, i) => (
            <Skeleton key={i} className="h-4" style={{ width: w }} />
          ))}
        </div>
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
          <PanelShell>
            <ChartSkeleton />
          </PanelShell>
          <PanelShell>
            <ul className="divide-y divide-line">
              {Array.from({ length: 5 }, (_, i) => (
                <li key={i} className="flex items-center gap-3 px-4 py-3">
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-3.5 w-28" />
                    <Skeleton className="h-3 w-40 max-w-full" />
                  </div>
                  <Skeleton className="h-5 w-8" />
                </li>
              ))}
            </ul>
          </PanelShell>
        </div>
        <PanelShell>
          <div className="md:hidden divide-y divide-line">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="px-4 py-4 space-y-3">
                <Skeleton className="h-4 w-36" />
                <Skeleton className="h-7 w-14" />
                <div className="grid grid-cols-4 gap-2">
                  {Array.from({ length: 4 }, (_, c) => (
                    <Skeleton key={c} className="h-8" />
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="hidden md:block">
            <TableSkeleton rows={8} cols={9} />
          </div>
        </PanelShell>
      </div>
    </Busy>
  );
}

// Wallet card (drawer) body while its detail loads.
export function DrawerSkeleton() {
  return (
    <Busy label="Loading wallet">
      <div className="space-y-6">
        <SkeletonLines n={2} />
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="rounded-lg border border-line bg-panel-2/60 px-3 py-2 space-y-1.5">
              <Skeleton className="h-2.5 w-16" />
              <Skeleton className="h-4 w-10" />
            </div>
          ))}
        </div>
        <div className="space-y-2">
          <Skeleton className="h-3 w-32" />
          <Skeleton className="h-52 w-full rounded-lg" />
        </div>
        <div className="space-y-2">
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-40 w-full rounded-lg" />
        </div>
      </div>
    </Busy>
  );
}

export function AdminSkeleton() {
  return (
    <Busy label="Loading admin">
      <div className="space-y-5">
        <div className="space-y-2">
          <Skeleton className="h-6 w-28" />
          <Skeleton className="h-3 w-80 max-w-full" />
        </div>
        <div className="flex gap-1 p-1 border border-line rounded-lg w-fit">
          {[72, 60, 84, 64, 64, 64].map((w, i) => (
            <Skeleton key={i} className="h-8 sm:h-7" style={{ width: w }} />
          ))}
        </div>
        <StatSkeletons />
        <div className="grid gap-4 lg:grid-cols-2">
          <PanelShell>
            <div className="p-4">
              <SkeletonLines n={2} />
            </div>
          </PanelShell>
          <PanelShell>
            <div className="p-4">
              <SkeletonLines n={2} />
            </div>
          </PanelShell>
        </div>
        <ListSkeleton rows={4} />
      </div>
    </Busy>
  );
}

export function PageHeaderSkeleton() {
  return (
    <div className="space-y-2">
      <Skeleton className="h-6 w-40" />
      <Skeleton className="h-3 w-96 max-w-full" />
    </div>
  );
}

// Just the rows, for use inside a panel that is already on screen.
export function RowsSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <Busy>
      <ul className="divide-y divide-line">
        {Array.from({ length: rows }, (_, i) => (
          <li key={i} className="flex items-center gap-3 px-4 py-3.5">
            <div className="flex-1 space-y-2 min-w-0">
              <Skeleton className="h-3.5" style={{ width: `${[55, 40, 62, 48, 58][i % 5]}%` }} />
              <Skeleton className="h-3" style={{ width: `${[35, 50, 28, 42, 38][i % 5]}%` }} />
            </div>
            <Skeleton className="h-6 w-14 rounded-full" />
          </li>
        ))}
      </ul>
    </Busy>
  );
}
