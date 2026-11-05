"use client";

import { useEffect } from "react";

export default function RouteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("[QuantAgent] route error", error);
  }, [error]);
  return (
    <div role="alert" className="flex h-dvh flex-col items-center justify-center gap-3 p-6 text-center">
      <div className="text-sm font-semibold">The workbench hit an unexpected error</div>
      <pre className="max-w-xl whitespace-pre-wrap text-xs text-muted-foreground">{error.message}</pre>
      <button onClick={reset} className="rounded-md border border-input px-3 py-1.5 text-xs hover:bg-accent">
        Reload workbench
      </button>
    </div>
  );
}
