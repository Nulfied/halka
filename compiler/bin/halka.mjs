#!/usr/bin/env node
// Halka launcher. Prefers the compiled build; falls back to running the
// TypeScript sources directly (Node >= 22.6 strips types natively).
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist", "cli", "main.js");
const src = join(here, "..", "src", "cli", "main.ts");

const entry = existsSync(dist) ? dist : src;
const { main } = await import(pathToFileURL(entry).href);
await main(process.argv.slice(2));
