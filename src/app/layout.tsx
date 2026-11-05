import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "QuantAgent — Local Data Engine",
  description: "Local-first workbench for AI algorithmic trading agents: DuckDB-WASM in a Web Worker, OHLCV analytics, backtesting and an LLM agent.",
};

export const viewport: Viewport = {
  themeColor: "#0a0b0d",
  colorScheme: "dark",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="dark">
      <body className="antialiased">{children}</body>
    </html>
  );
}
