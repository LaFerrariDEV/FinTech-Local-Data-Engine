"use client";

import dynamic from "next/dynamic";

/**
 * The workbench is entirely client-side (Web Workers, WASM, canvas, OPFS), so it is loaded
 * without SSR. The server only ships the static shell.
 */
const Workbench = dynamic(() => import("@/components/workbench/workbench").then((m) => m.Workbench), {
  ssr: false,
  loading: () => (
    <div className="flex h-dvh items-center justify-center text-xs text-muted-foreground">
      <span className="mr-2 inline-block size-3.5 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-primary" />
      Loading QuantAgent…
    </div>
  ),
});

export function ClientWorkbench() {
  return <Workbench />;
}
