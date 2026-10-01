"use client"; // Error boundaries must be Client Components

import { useEffect } from "react";
import Link from "next/link";

// Shown when a page crashes. The rest of the app (nav, other pages) keeps working.
export default function Error({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div className="max-w-md mx-auto mt-24 text-center">
      <div className="text-[18px] font-semibold">Something went wrong on this page</div>
      <p className="text-dim mt-2">
        Your runs and results are safe. Try again; if it keeps happening, reload the page.
        {error.digest && <span className="block text-faint text-[12px] mt-2 mono">Reference: {error.digest}</span>}
      </p>
      <div className="mt-5 flex justify-center gap-3">
        <button onClick={() => retry()} className="h-9 px-4 rounded-md bg-accent text-white font-medium">
          Try again
        </button>
        <Link href="/" className="h-9 px-4 rounded-md border border-line-2 inline-flex items-center text-dim hover:text-ink">
          New analysis
        </Link>
      </div>
    </div>
  );
}
