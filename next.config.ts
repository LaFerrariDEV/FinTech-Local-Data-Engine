import path from "node:path";
import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  webpack(config) {
    // Worker and server bundles do not apply the "browser" export condition, which would pull
    // DuckDB's Node build (with dynamic requires) into the bundle. The engine only ever runs in
    // the browser, so pin the browser ESM build for every compilation.
    config.resolve.alias = {
      ...(config.resolve.alias ?? {}),
      "@duckdb/duckdb-wasm$": path.resolve(process.cwd(), "node_modules/@duckdb/duckdb-wasm/dist/duckdb-browser.mjs"),
    };
    return config;
  },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      {
        // DuckDB-WASM runtime: large, versioned through public/duckdb/manifest.json.
        source: "/duckdb/:file*",
        headers: [{ key: "Cache-Control", value: "public, max-age=86400, stale-while-revalidate=604800" }],
      },
    ];
  },
};

export default nextConfig;
