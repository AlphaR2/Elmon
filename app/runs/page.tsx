import { RunsList } from "../components/RunsList";

export default function RunsPage() {
  return (
    <div className="max-w-4xl space-y-4">
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight">Runs</h1>
        <p className="text-dim mt-1">Your analyses. Export what you need: results clear on their own, saved chain data keeps the next run cheap.</p>
      </div>
      <RunsList title="All runs" />
    </div>
  );
}
