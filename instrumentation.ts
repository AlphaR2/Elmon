// Local development without Supabase keeps everything in one process: the in-memory database cannot be shared
// with a separate worker, so the worker loop runs inside `next dev`.
// Never in production: there the pipeline runs only in the separate worker (npm run worker), and a web server that
// is missing DATABASE_URL must fail its requests closed rather than start spending credits on its own.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NODE_ENV === "production") return;
  if (process.env.DATABASE_URL && process.env.ELMON_INPROCESS_WORKER !== "1") return;
  const { startWorker } = await import("./lib/worker");
  await startWorker({ signals: false });
}
