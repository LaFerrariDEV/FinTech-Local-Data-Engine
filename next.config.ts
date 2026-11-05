import path from "node:path";
import type { NextConfig } from "next";

/**
 * Two deployment modes:
 *  - default: `next start` server (security + cache headers applied by Next).
 *  - STATIC_EXPORT=1: fully static site in ./out for GitHub Pages or any static host. The app is
 *    entirely client-side, so nothing is lost; NEXT_PUBLIC_BASE_PATH sets the sub-path
 *    (e.g. "/FinTech-Local-Data-Engine" for https://<user>.github.io/FinTech-Local-Data-Engine).
 */
const staticExport = process.env.STATIC_EXPORT === "1";
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  ...(staticExport ? { output: "export" as const, trailingSlash: true, images: { unoptimized: true } } : {}),
  ...(basePath ? { basePath } : {}),
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
  // Static hosts serve their own headers; Next only applies these in server mode.
  ...(staticExport
    ? {}
    : {
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
      }),
};

export default nextConfig;
