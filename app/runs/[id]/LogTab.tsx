"use client";
import { Panel } from "../../components/ui";
import type { RunData } from "./types";

export function LogTab({ data }: { data: RunData }) {
  return (
    <Panel title="Log" sub="What the run did, newest last">
      <div className="p-4 mono text-[12px] space-y-1 max-h-[70vh] overflow-auto scroll-thin">
        {data.log.map((l, i) => (
          <div key={i} className={`flex gap-3 ${l.level === "error" ? "text-bad" : l.level === "warn" ? "text-warn" : "text-dim"}`}>
            <span className="text-faint shrink-0">{new Date(l.ts).toLocaleTimeString()}</span>
            <span className="min-w-0 break-words">{l.msg}</span>
          </div>
        ))}
      </div>
    </Panel>
  );
}
