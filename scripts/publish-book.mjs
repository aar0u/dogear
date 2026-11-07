#!/usr/bin/env node
// Split a TXT novel into chapters and upload it to the WebDAV library.
//
//   node scripts/publish-book.mjs book.txt [--title 书名] [--author 作者] [--slug s]
//
// DAV_URL, DAV_USER, DAV_PASS (and optional DAV_ROOT) come from the environment
// or from .dev.vars. The manifest is uploaded last, so a half-finished upload
// never shows up on the shelf.

import { existsSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeDav } from "../src/dav.js";
import {
  buildManifest, newBookId, piecesToEntries, shortSlug, splitTextIntoPieces,
} from "../public/split-core.mjs";

// Detect the encoding the way the shelf expects: BOMs first, then strict UTF-8, then GB18030.
export function decodeText(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder("utf-16le").decode(buf);
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder("utf-16be").decode(buf);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf).replace(/^﻿/, "");
  } catch {
    return new TextDecoder("gb18030").decode(buf);
  }
}

function loadDevVars() {
  const file = join(fileURLToPath(new URL("..", import.meta.url)), ".dev.vars");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*"?(.*?)"?\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

export async function publishText(dav, text, { title, author = "", slug } = {}) {
  const { pieces, headingCount } = splitTextIntoPieces(text, { bookTitle: title });
  const entries = piecesToEntries(pieces);
  if (!entries.length) throw new Error("no text to publish");

  const existing = await dav.list("books");
  const taken = [];
  for (const d of existing.filter((e) => e.isDir)) {
    const m = await dav.getJson(`books/${d.name}/manifest.json`);
    if (m?.slug) taken.push(m.slug);
  }
  const id = newBookId();
  const finalSlug = slug ?? shortSlug(title, taken);
  const manifest = { ...buildManifest({ id, slug: finalSlug, title, entries }), ...(author ? { author } : {}) };

  let next = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < entries.length) {
      const e = entries[next++];
      await dav.put(`books/${id}/${e.file}`, e.body, "text/plain; charset=utf-8");
    }
  }));
  await dav.putJson(`books/${id}/manifest.json`, manifest);
  return { id, slug: finalSlug, chapters: entries.length, headingCount, totalChars: manifest.totalChars };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  loadDevVars();
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args.splice(i, 2)[1] : undefined;
  };
  const title = opt("title");
  const author = opt("author");
  const slug = opt("slug");
  const file = args[0];
  if (!file) {
    console.error("usage: publish-book.mjs book.txt [--title T] [--author A] [--slug S]");
    process.exit(2);
  }
  const text = decodeText(readFileSync(file));
  const result = await publishText(makeDav(process.env), text, {
    title: title ?? basename(file, extname(file)), author, slug,
  });
  console.log(`published ${result.slug} (${result.id}): ${result.chapters} chapters, ${result.totalChars} chars`);
  if (result.headingCount < 3) console.warn("warning: fewer than 3 chapter headings found; the book is one chapter");
}
