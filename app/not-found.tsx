import Link from "next/link";

export default function NotFound() {
  return (
    <div className="max-w-md mx-auto mt-24 text-center">
      <div className="text-[18px] font-semibold">Page not found</div>
      <p className="text-dim mt-2">This page does not exist, or the run it belonged to has been cleared.</p>
      <div className="mt-5 flex justify-center gap-3">
        <Link href="/" className="h-9 px-4 rounded-md bg-accent text-white font-medium inline-flex items-center">
          New analysis
        </Link>
        <Link href="/runs" className="h-9 px-4 rounded-md border border-line-2 inline-flex items-center text-dim hover:text-ink">
          Your runs
        </Link>
      </div>
    </div>
  );
}
