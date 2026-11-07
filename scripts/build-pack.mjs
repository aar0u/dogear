#!/usr/bin/env node
// Assemble the offline-TTS voice pack (the files /api/wasmtts/* serves) from
// the upstream sources the wasmtts pin names, verifying size and SHA-256 of
// every file. The output folder is what you upload as your own GitHub release:
//
//   node scripts/build-pack.mjs [outDir]          (default: dist/pack)
//   gh release create wasmtts-pack dist/pack/* --repo <you>/<repo>
//   wrangler secret put WASMTTS_RELEASE    # https://github.com/<you>/<repo>/releases/download/wasmtts-pack/
//
// Run `pnpm run vendor` first: the pack list comes from the pinned wasmtts
// engine, and the compiled lexicon and ort's wasm are copied from it.

import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ensureEngine, packEntries, readAssets, sha256 } from "./wasmtts-pin.mjs";

const outDir = resolve(process.argv[2] ?? "dist/pack");
mkdirSync(outDir, { recursive: true });

const engine = await ensureEngine();
const entries = packEntries(readAssets(engine), engine);

for (const { name, bytes, sha256: want, url, local } of entries) {
  const target = join(outDir, name);
  if (local) {
    copyFileSync(local, target);
  } else {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    writeFileSync(target, Buffer.from(await res.arrayBuffer()));
  }
  const size = statSync(target).size;
  if (size !== bytes) throw new Error(`${name}: ${size} B, pin says ${bytes} B`);
  const hash = sha256(readFileSync(target));
  if (hash !== want) throw new Error(`${name}: SHA-256 ${hash}, pin says ${want}`);
  console.log(`ok ${name} (${bytes} B)`);
}
console.log(`pack complete: ${entries.length} files in ${outDir}`);
