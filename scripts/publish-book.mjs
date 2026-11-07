#!/usr/bin/env node
// Split a TXT or EPUB novel into chapters and upload it to the WebDAV library.
//
//   node scripts/publish-book.mjs book.txt|book.epub [--title 书名] [--author 作者] [--slug s]
//   node scripts/publish-book.mjs --from-dav 书名.epub     (a file already in DAV_ROOT)
//
// DAV_URL, DAV_USER, DAV_PASS (and optional DAV_ROOT) come from the environment
// or from .dev.vars. The manifest is uploaded last, so a half-finished upload
// never shows up on the shelf.

import { existsSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";
import { makeDav } from "../src/dav.js";
import { parseEpub } from "../public/epub-core.mjs";
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

export function loadDevVars() {
  const file = join(fileURLToPath(new URL("..", import.meta.url)), ".dev.vars");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*"?(.*?)"?\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

export async function publishText(dav, text, { title, author = "", slug } = {}) {
  const { pieces, headingCount } = splitTextIntoPieces(text, { bookTitle: title });
  return { ...(await publishPieces(dav, pieces, { title, author, slug })), headingCount };
}

export async function publishEpub(dav, bytes, { title, author, slug } = {}) {
  const book = parseEpub(unzipSync(new Uint8Array(bytes)));
  if (!book.chapters.length) throw new Error("no readable chapters in this EPUB");
  return publishPieces(dav, book.chapters, {
    title: title ?? (book.title || "untitled"), author: author ?? book.author, slug,
  });
}

async function publishPieces(dav, pieces, { title, author = "", slug }) {
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

  const upload = (e) => dav.put(`books/${id}/${e.file}`, e.body, "text/plain; charset=utf-8");
  // the first file alone: it creates the folders, which parallel requests would race to create
  await upload(entries[0]);
  let next = 1;
  let done = 1;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < entries.length) {
      await upload(entries[next++]);
      if (++done % 50 === 0) console.log(`uploaded ${done}/${entries.length}`);
    }
  }));
  await dav.putJson(`books/${id}/manifest.json`, manifest);
  return { id, slug: finalSlug, chapters: entries.length, totalChars: manifest.totalChars };
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
  const fromDav = opt("from-dav");
  const file = fromDav ?? args[0];
  if (!file) {
    console.error("usage: publish-book.mjs book.txt|book.epub [--title T] [--author A] [--slug S]\n" +
      "       publish-book.mjs --from-dav <path under DAV_ROOT> ...");
    process.exit(2);
  }
  const dav = makeDav(process.env);
  let bytes;
  if (fromDav) {
    const res = await dav.get(fromDav);
    if (!res.ok) throw new Error(`GET ${fromDav}: ${res.status}`);
    bytes = Buffer.from(await res.arrayBuffer());
  } else {
    bytes = readFileSync(file);
  }
  const result = extname(file).toLowerCase() === ".epub"
    ? await publishEpub(dav, bytes, { title, author, slug })
    : await publishText(dav, decodeText(bytes), { title: title ?? basename(file, extname(file)), author, slug });
  console.log(`published ${result.slug} (${result.id}): ${result.chapters} chapters, ${result.totalChars} chars`);
  if (result.headingCount < 3) console.warn("warning: fewer than 3 chapter headings found; the book is one chapter");
}
