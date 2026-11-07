// Reader backend: books, reading positions, settings and bookmarks live as
// files on a WebDAV server; TTS audio is synthesized on demand and not stored.
// Static assets (the reader app) are served by the assets binding; this worker
// only runs for /api/* and /books/* (see run_worker_first in wrangler.jsonc).
//
// WebDAV layout under DAV_URL/DAV_ROOT:
//   books/<id>/manifest.json, books/<id>/<NNNN_title>.txt, books/<id>/cover.jpg
//   state/pos/<id>.json     {chapter, char_off, updated_at}
//   state/marks/<id>.json   {marks: [...], updated_at}
//   state/settings.json     {data, updated_at}

import { chunkChapter, ttsPrompt } from "../public/tts-core.mjs";
import { PACK_NAMES } from "../public/vendor/wasmtts/pack-manifest.mjs";
import { edgeSynthesize } from "./edge-tts.js";
import { makeDav } from "./dav.js";

const USER = "me";
const ID_RE = /^[\w一-鿿぀-ヿ-]{1,64}$/u;
const FILE_RE = /^[^/\\]{1,120}\.(?:txt|json|jpe?g|png|webp)$/u;
const LIBRARY_TTL_MS = 20_000;

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...extra },
  });
}

// ---------- auth: one shared reader key ----------

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

async function keyMatches(env, candidate) {
  if (!env.READER_KEY || !candidate) return false;
  const [a, b] = await Promise.all([sha256(candidate), sha256(env.READER_KEY)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function readerKey(request, url) {
  const header = request.headers.get("x-reader-key");
  if (header) return header;
  const m = (request.headers.get("cookie") ?? "").match(/(?:^|;\s*)bw_key=([^;]+)/);
  if (m) return decodeURIComponent(m[1]);
  return url.searchParams.get("key");
}

async function authenticate(request, env, url) {
  return (await keyMatches(env, readerKey(request, url))) ? { user: USER, label: "" } : null;
}

async function handleAuth(request, env, url, who) {
  if (request.method === "GET") {
    if (!who) return json({ error: "unauthorized" }, 401);
    return json({ user: who.user, label: who.label }, 200, { "cache-control": "no-store" });
  }
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  const key = typeof body?.key === "string" ? body.key.trim() : "";
  if (!key) return json({ error: "key required" }, 400);
  if (!(await keyMatches(env, key))) return json({ error: "unauthorized" }, 401);
  // Secure only on https: a Secure cookie is dropped on plain-http wrangler dev
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return json({ ok: true, user: USER, label: "" }, 200, {
    "set-cookie": `bw_key=${encodeURIComponent(key)}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly${secure}`,
    "cache-control": "no-store",
  });
}

// ---------- router ----------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      const gated =
        path === "/api/books" || path.startsWith("/api/books/") ||
        path === "/api/position" || path === "/api/settings" || path === "/api/bookmarks" ||
        path.startsWith("/api/tts/") || path.startsWith("/books/");
      const who = gated || path === "/api/auth" ? await authenticate(request, env, url) : null;
      if (gated && !who) return json({ error: "unauthorized" }, 401);

      if (path === "/api/version") return json({ build: "dev" }, 200, { "cache-control": "no-store" });
      if (path === "/api/auth") return await handleAuth(request, env, url, who);
      if (path === "/api/books") return await listBooks(request, env);
      if (path.startsWith("/api/books/")) return await resolveBook(request, env, path);
      if (path === "/api/position") return await handlePosition(request, env, url);
      if (path === "/api/settings") return await handleSettings(request, env);
      if (path === "/api/bookmarks") return await handleBookmarks(request, env, url);
      if (path.startsWith("/api/wasmtts/")) return await serveWasmttsAsset(path, env);
      if (path.startsWith("/api/tts/")) return await handleTts(request, env, path);
      // the client's diagnostic beacons and push registration have no backend here
      if (path === "/api/testlog") return new Response(null, { status: 204 });
      if (path.startsWith("/books/")) return await serveBook(request, env, path);
    } catch (err) {
      console.error(`${request.method} ${path}: ${err?.stack ?? err}`);
      return json({ error: "internal error" }, 500);
    }
    return json({ error: "not found" }, 404);
  },
};

// ---------- library ----------

// Per-isolate cache; a new book shows up within LIBRARY_TTL_MS.
let libraryCache = { at: 0, books: null };

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

async function loadLibrary(env) {
  if (libraryCache.books && Date.now() - libraryCache.at < LIBRARY_TTL_MS) return libraryCache.books;
  const dav = makeDav(env);
  const dirs = (await dav.list("books")).filter((e) => e.isDir && ID_RE.test(e.name));
  const manifests = await mapLimit(dirs, 6, async (d) => {
    const m = await dav.getJson(`books/${d.name}/manifest.json`);
    if (!m || !Array.isArray(m.chapters)) return null;
    return {
      id: d.name,
      slug: typeof m.slug === "string" && m.slug ? m.slug : d.name,
      title: m.title || d.name,
      author: m.author || "",
      chapters: m.chapters.length,
      totalChars: Number(m.totalChars) || 0,
      chapterChars: m.chapters.map((c) => Number(c.chars) || 0),
    };
  });
  const books = manifests.filter(Boolean);
  libraryCache = { at: Date.now(), books };
  return books;
}

async function listBooks(request, env) {
  if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
  const dav = makeDav(env);
  const library = await loadLibrary(env);
  const positions = await mapLimit(library, 6, (b) => dav.getJson(`state/pos/${b.id}.json`));
  const books = library.map((b, i) => {
    const out = {
      id: b.id, slug: b.slug, title: b.title,
      ...(b.author ? { author: b.author } : {}),
      chapters: b.chapters, totalChars: b.totalChars,
    };
    const pos = positions[i];
    if (pos && b.totalChars > 0) {
      let before = 0;
      for (let c = 0; c < Math.min(pos.chapter, b.chapterChars.length); c++) before += b.chapterChars[c];
      out.progress = {
        chapter: pos.chapter,
        updatedAt: pos.updated_at,
        pct: Number(Math.min(100, ((before + pos.char_off) / b.totalChars) * 100).toFixed(1)),
      };
    }
    return out;
  });
  books.sort((a, b) => a.title.localeCompare(b.title));
  return json({ books }, 200, { "cache-control": "no-store" });
}

async function resolveBook(request, env, path) {
  if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
  const slug = decodeURIComponent(path.slice("/api/books/".length));
  const b = (await loadLibrary(env)).find((x) => x.slug === slug || x.id === slug);
  if (!b) return json({ error: "not found" }, 404);
  return json({
    book: { id: b.id, slug: b.slug, title: b.title, chapters: b.chapters, totalChars: b.totalChars },
  }, 200, { "cache-control": "public, max-age=60" });
}

async function serveBook(request, env, path) {
  if (request.method !== "GET" && request.method !== "HEAD")
    return json({ error: "method not allowed" }, 405);
  const [id, file, ...rest] = decodeURIComponent(path.slice("/books/".length)).split("/");
  if (rest.length || !ID_RE.test(id ?? "") || !FILE_RE.test(file ?? "") || file.includes(".."))
    return json({ error: "bad key" }, 400);

  const res = await makeDav(env).get(`books/${id}/${file}`);
  if (res.status === 404) return json({ error: "not found" }, 404);
  if (!res.ok) return json({ error: "storage error" }, 502);

  const isManifest = file.endsWith(".json");
  const isImage = /\.(?:jpe?g|png|webp)$/.test(file);
  return new Response(request.method === "HEAD" ? null : res.body, {
    headers: {
      "content-type": isManifest ? "application/json"
        : file.endsWith(".png") ? "image/png"
        : file.endsWith(".webp") ? "image/webp"
        : isImage ? "image/jpeg"
        : "text/plain; charset=utf-8",
      // chapters are immutable (the reader adds ?v=<manifest.generatedAt> to bust them)
      "cache-control": isManifest ? "public, max-age=60"
        : isImage ? "public, max-age=86400"
        : "public, max-age=2592000, immutable",
    },
  });
}

// ---------- positions, settings, bookmarks ----------

// Updates are last-write-wins by client timestamp, capped at server time + 60 s
// so one device with a fast clock cannot freeze the slot.
function clampTs(updatedAt) {
  return Math.min(Number.isFinite(updatedAt) ? Math.floor(updatedAt) : Date.now(), Date.now() + 60_000);
}

// Write `record` (which carries updated_at) unless the stored one is newer.
// Koofr answers 423 Locked to a PUT while another PUT to the same file is
// still running, and position writes overlap (a beacon plus the timer flush,
// two devices). After a 423 the stored record is read again before retrying,
// so a slow older write cannot land on top of a newer one that got in first.
async function putLww(dav, path, record) {
  for (let attempt = 0; ; attempt++) {
    const prev = await dav.getJson(path);
    if (prev && record.updated_at < prev.updated_at) return;
    try {
      await dav.putJson(path, record);
      return;
    } catch (err) {
      if (err.status !== 423 || attempt >= 4) throw err;
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }
}

async function readBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function handlePosition(request, env, url) {
  const dav = makeDav(env);
  if (request.method === "GET") {
    const book = url.searchParams.get("book") ?? "";
    if (!ID_RE.test(book)) return json({ error: "book required" }, 400);
    const row = await dav.getJson(`state/pos/${book}.json`);
    return json({ position: row }, 200, { "cache-control": "no-store" });
  }
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  const body = await readBody(request);
  if (!body) return json({ error: "invalid json" }, 400);
  const { book, chapter, offset, updatedAt } = body;
  if (!ID_RE.test(book ?? "") || !Number.isInteger(chapter) || chapter < 0 ||
      !Number.isInteger(offset) || offset < 0)
    return json({ error: "invalid body" }, 400);
  const ts = clampTs(updatedAt);
  await putLww(dav, `state/pos/${book}.json`, { chapter, char_off: offset, updated_at: ts });
  return json({ ok: true });
}

function validSettings(s) {
  return s && typeof s === "object" &&
    Number.isInteger(s.fontSize) && s.fontSize >= 8 && s.fontSize <= 120 &&
    typeof s.vertical === "boolean" &&
    typeof s.bg === "string" && /^[a-z-]{0,32}$/.test(s.bg) &&
    (s.leading === undefined || (typeof s.leading === "number" && s.leading >= 1.1 && s.leading <= 2.5));
}

async function handleSettings(request, env) {
  const dav = makeDav(env);
  if (request.method === "GET") {
    const row = await dav.getJson("state/settings.json");
    return json({ settings: row?.data ?? null, updatedAt: row?.updated_at ?? 0 }, 200,
      { "cache-control": "no-store" });
  }
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  const body = await readBody(request);
  if (!body || !validSettings(body.settings)) return json({ error: "invalid body" }, 400);
  const s = body.settings;
  const ts = clampTs(body.updatedAt);
  const data = { fontSize: s.fontSize, vertical: s.vertical, bg: s.bg,
    ...(s.leading !== undefined ? { leading: s.leading } : {}) };
  await putLww(dav, "state/settings.json", { data, updated_at: ts });
  return json({ ok: true });
}

function validMarks(marks) {
  return Array.isArray(marks) && marks.length <= 200 && marks.every((m) =>
    m && typeof m.id === "string" && m.id.length > 0 && m.id.length <= 40 &&
    Number.isInteger(m.chapter) && m.chapter >= 0 &&
    Number.isInteger(m.offset) && m.offset >= 0 &&
    typeof m.label === "string" && m.label.length <= 80 &&
    Number.isFinite(m.createdAt));
}

// The whole list is one LWW unit: a bookmark list is small and one person edits it.
async function handleBookmarks(request, env, url) {
  const dav = makeDav(env);
  if (request.method === "GET") {
    const book = url.searchParams.get("book") ?? "";
    if (!ID_RE.test(book)) return json({ error: "book required" }, 400);
    const row = await dav.getJson(`state/marks/${book}.json`);
    return json({ marks: row?.marks ?? [], updatedAt: row?.updated_at ?? 0 }, 200,
      { "cache-control": "no-store" });
  }
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  const body = await readBody(request);
  if (!body || !ID_RE.test(body.book ?? "") || !validMarks(body.marks))
    return json({ error: "invalid body" }, 400);
  const ts = clampTs(body.updatedAt);
  await putLww(dav, `state/marks/${body.book}.json`, { marks: body.marks, updated_at: ts });
  return json({ ok: true });
}

// ---------- TTS ----------

async function handleTts(request, env, path) {
  if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
  const m = path.match(/^\/api\/tts\/([^/]+)\/([^/]+)\/(\d{1,4})$/);
  if (!m) return json({ error: "not found" }, 404);
  const id = decodeURIComponent(m[1]);
  const file = decodeURIComponent(m[2]);
  const chunkIdx = Number(m[3]);
  if (!ID_RE.test(id) || !FILE_RE.test(file) || !file.endsWith(".txt") || file.includes(".."))
    return json({ error: "bad key" }, 400);

  const res = await makeDav(env).get(`books/${id}/${file}`);
  if (res.status === 404) return json({ error: "not found" }, 404);
  if (!res.ok) return json({ error: "storage error" }, 502);
  const chunk = chunkChapter(await res.text())[chunkIdx];
  if (!chunk) return json({ error: "no such chunk" }, 404);

  let bytes;
  try {
    bytes = await edgeSynthesize(ttsPrompt(chunk.text));
  } catch (err) {
    // the player falls back to the offline engine on this status
    console.error(`tts ${id}/${file}/${chunkIdx}: ${err?.message ?? err}`);
    return json({ error: "tts failed" }, 502);
  }
  // the client's ?v=<manifest.generatedAt> makes a re-split book a new URL
  return new Response(bytes, {
    headers: { "content-type": "audio/mpeg", "cache-control": "public, max-age=2592000, immutable" },
  });
}

// ---------- offline TTS voice pack ----------

// The Matcha model files live on a GitHub release whose download host sends no
// CORS headers, so the page reads them through this same-origin allowlisted proxy.
// WASMTTS_RELEASE (wrangler.jsonc vars) is this repo's own release, filled by
// .github/workflows/voice-pack.yml from scripts/build-pack.mjs.
const WASMTTS_FILES = new Set(PACK_NAMES);
const ORT_WASM_RE = /^ort-\d+\.\d+\.\d+(?:[-.][\w.]+)?-wasm-simd-threaded\.wasm$/;

async function serveWasmttsAsset(path, env) {
  const name = path.slice("/api/wasmtts/".length);
  if (!WASMTTS_FILES.has(name) && !ORT_WASM_RE.test(name)) return json({ error: "not found" }, 404);
  if (!env.WASMTTS_RELEASE) return json({ error: "voice pack not configured" }, 404);
  const res = await fetch(env.WASMTTS_RELEASE + name, { redirect: "follow" });
  if (!res.ok) return json({ error: `upstream ${res.status}` }, 502);
  const headers = {
    "content-type": name.endsWith(".wasm") ? "application/wasm" : "application/octet-stream",
    "cache-control": "public, max-age=31536000, immutable",
  };
  const len = res.headers.get("content-length");
  if (len) headers["content-length"] = len;
  return new Response(res.body, { headers });
}
