"use client";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ background: "#0a0b0d", color: "#e6e7ea", fontFamily: "system-ui, sans-serif", margin: 0 }}>
        <div role="alert" style={{ display: "flex", minHeight: "100vh", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, padding: 24 }}>
          <strong style={{ fontSize: 14 }}>QuantAgent failed to start</strong>
          <pre style={{ fontSize: 12, color: "#8b909a", whiteSpace: "pre-wrap", maxWidth: 640 }}>{error.message}</pre>
          <button onClick={reset} style={{ fontSize: 12, padding: "6px 12px", borderRadius: 6, border: "1px solid #2a2e35", background: "transparent", color: "inherit", cursor: "pointer" }}>
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
