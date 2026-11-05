#!/usr/bin/env node
/**
 * Copies the DuckDB-WASM runtime (WASM binaries + their worker scripts) into public/duckdb so
 * the app serves them from its own origin. No CDN is involved at runtime: the workbench stays
 * fully local-first and works offline once loaded.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "node_modules", "@duckdb", "duckdb-wasm", "dist");
const target = path.join(root, "public", "duckdb");
const files = ["duckdb-mvp.wasm", "duckdb-eh.wasm", "duckdb-browser-mvp.worker.js", "duckdb-browser-eh.worker.js"];

if (!existsSync(dist)) {
  console.error("[copy-duckdb-assets] @duckdb/duckdb-wasm is not installed; run npm install first.");
  process.exit(1);
}
const pkg = JSON.parse(readFileSync(path.join(root, "node_modules", "@duckdb", "duckdb-wasm", "package.json"), "utf8"));
mkdirSync(target, { recursive: true });
let copied = 0;
for (const file of files) {
  const from = path.join(dist, file);
  const to = path.join(target, file);
  if (!existsSync(from)) {
    console.error(`[copy-duckdb-assets] missing ${from}`);
    process.exit(1);
  }
  if (existsSync(to) && statSync(to).size === statSync(from).size && statSync(to).mtimeMs >= statSync(from).mtimeMs) continue;
  copyFileSync(from, to);
  copied++;
}
writeFileSync(path.join(target, "manifest.json"), `${JSON.stringify({ version: pkg.version, files }, null, 2)}\n`);
console.log(`[copy-duckdb-assets] duckdb-wasm ${pkg.version}: ${copied} file(s) updated in public/duckdb`);
