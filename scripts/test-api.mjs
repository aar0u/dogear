// End-to-end check of the worker against an in-memory WebDAV server:
// publish a GBK book, list it, read a chapter, sync position/settings/bookmarks, auth.
import assert from "node:assert/strict";
import worker from "../src/worker.js";
import { makeDav, parseListing } from "../src/dav.js";
import { secMsGec } from "../src/edge-tts.js";
import { decodeText, publishText } from "./publish-book.mjs";
import { startMockDav } from "./mock-dav.mjs";

const dav = await startMockDav();
const env = { DAV_URL: dav.url, DAV_USER: dav.user, DAV_PASS: dav.pass, DAV_ROOT: "novel", READER_KEY: "secret-key-1234" };
const call = (path, init = {}, key = env.READER_KEY) =>
  worker.fetch(new Request("http://t" + path, {
    ...init, headers: { "x-reader-key": key, "content-type": "application/json", ...init.headers },
  }), env, { waitUntil() {} });
const post = (path, body) => call(path, { method: "POST", body: JSON.stringify(body) });

try {
  const text = "第一章 开始\n这是第一章的正文。\n第二章 继续\n这是第二章的正文。\n第三章 结束\n这是第三章的正文。\n";
  // encodings: UTF-8, UTF-16LE with BOM, and GBK bytes for "第章"
  assert.equal(decodeText(Buffer.from(text)), text);
  assert.equal(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")])), text);
  assert.equal(decodeText(Buffer.from([0xb5, 0xda, 0xd5, 0xc2])), "第章");

  const client = makeDav(env);
  const pub = await publishText(client, text, { title: "测试书", author: "某人" });
  assert.equal(pub.chapters, 3);

  // auth
  assert.equal((await call("/api/books", {}, "wrong")).status, 401);
  assert.equal((await call("/api/books", {}, "")).status, 401);
  const login = await worker.fetch(new Request("http://t/api/auth", {
    method: "POST", body: JSON.stringify({ key: env.READER_KEY }),
  }), env, {});
  assert.equal(login.status, 200);
  assert.match(login.headers.get("set-cookie"), /dogear_key=/);
  assert.equal((await worker.fetch(new Request("http://t/api/auth", { method: "POST", body: JSON.stringify({ key: "x" }) }), env, {})).status, 401);

  // shelf and book
  const shelf = await (await call("/api/books")).json();
  assert.equal(shelf.books.length, 1);
  assert.deepEqual(
    { title: shelf.books[0].title, author: shelf.books[0].author, chapters: shelf.books[0].chapters },
    { title: "测试书", author: "某人", chapters: 3 });
  assert.equal(shelf.books[0].progress, undefined);
  const { id, slug } = shelf.books[0];
  assert.equal((await (await call(`/api/books/${encodeURIComponent(slug)}`)).json()).book.id, id);
  assert.equal((await call("/api/books/nope")).status, 404);

  // chapter files incl. non-ASCII names, and path traversal
  const manifest = await (await call(`/books/${id}/manifest.json`)).json();
  const file = manifest.chapters[1].file;
  const chapter = await call(`/books/${id}/${encodeURIComponent(file)}`);
  assert.equal(chapter.status, 200);
  assert.match(await chapter.text(), /第二章/);
  assert.equal((await call(`/books/${id}/..%2F..%2Fstate%2Fsettings.json`)).status, 400);
  assert.equal((await call(`/books/${id}/nothing.txt`)).status, 404);

  // position: LWW, progress on the shelf
  assert.equal((await (await call(`/api/position?book=${id}`)).json()).position, null);
  await post("/api/position", { book: id, chapter: 1, offset: 5, updatedAt: 2000 });
  await post("/api/position", { book: id, chapter: 0, offset: 1, updatedAt: 1000 }); // older: ignored
  const pos = (await (await call(`/api/position?book=${id}`)).json()).position;
  assert.deepEqual(pos, { chapter: 1, char_off: 5, updated_at: 2000 });
  const shelf2 = await (await call("/api/books")).json();
  assert.equal(shelf2.books[0].progress.chapter, 1);
  assert.ok(shelf2.books[0].progress.pct > 0);
  assert.equal((await post("/api/position", { book: id, chapter: -1, offset: 0 })).status, 400);
  assert.equal((await call("/api/position?book=../x")).status, 400);

  // settings incl. line spacing
  assert.equal((await (await call("/api/settings")).json()).settings, null);
  assert.equal((await post("/api/settings", { settings: { bg: "", leading: 1.7 }, updatedAt: 10 })).status, 200);
  assert.deepEqual((await (await call("/api/settings")).json()).settings, { bg: "", leading: 1.7 });
  assert.equal((await post("/api/settings", { settings: { bg: "", leading: 9 } })).status, 400, "spacing out of range");
  assert.equal((await post("/api/settings", { settings: { bg: "Not Valid!" } })).status, 400, "paper name");
  // a client that still sends the retired fields is accepted, and they are not stored
  assert.equal((await post("/api/settings", { settings: { fontSize: 20, vertical: true, bg: "pink", leading: 1.5 }, updatedAt: 20 })).status, 200);
  assert.deepEqual((await (await call("/api/settings")).json()).settings, { bg: "pink", leading: 1.5 });

  // bookmarks
  const marks = [{ id: "m1", chapter: 1, offset: 7, label: "好句", createdAt: 5 }];
  assert.equal((await post("/api/bookmarks", { book: id, marks, updatedAt: 100 })).status, 200);
  assert.deepEqual((await (await call(`/api/bookmarks?book=${id}`)).json()).marks, marks);
  await post("/api/bookmarks", { book: id, marks: [], updatedAt: 50 }); // older: ignored
  assert.equal((await (await call(`/api/bookmarks?book=${id}`)).json()).marks.length, 1);
  assert.equal((await post("/api/bookmarks", { book: id, marks: [{ id: "" }], updatedAt: 1 })).status, 400);

  // upload from the browser: chapters first, the manifest last, bad input refused
  const upId = "bupload01";
  const put = (path, body) => call(path, { method: "PUT", body });
  assert.equal((await put(`/api/upload/${upId}/${encodeURIComponent("0000_第一章.txt")}`, "第一章\n正文\n")).status, 200);
  assert.equal((await put(`/api/upload/${upId}/manifest.json`, JSON.stringify({ id: "other", chapters: [{}] }))).status, 400, "manifest id must match");
  assert.equal((await put(`/api/upload/${upId}/..%2Fx.txt`, "x")).status, 400);
  assert.equal((await put(`/api/upload/${upId}/evil.exe`, "x")).status, 400);
  assert.equal((await put(`/api/upload/${upId}/big.txt`, "a".repeat(2 * 1024 * 1024 + 1))).status, 413);
  assert.equal((await call(`/api/upload/${upId}/x.txt`, { method: "PUT", body: "x" }, "wrong")).status, 401);
  assert.equal((await (await call("/api/books")).json()).books.some((b) => b.id === upId), false, "unfinished: not on the shelf");
  const upManifest = { id: upId, slug: "up", title: "上传书", totalChars: 6,
    chapters: [{ title: "第一章", file: "0000_第一章.txt", chars: 6, bytes: 18 }] };
  assert.equal((await put(`/api/upload/${upId}/manifest.json`, JSON.stringify(upManifest))).status, 200);
  assert.equal((await (await call("/api/books")).json()).books.some((b) => b.id === upId), true, "finished: on the shelf at once");
  assert.equal((await call(`/api/upload/${upId}`, { method: "DELETE" })).status, 409, "a published book is never deleted here");

  // deleting a published book takes its files, position and bookmarks with it
  await post("/api/position", { book: upId, chapter: 0, offset: 1, updatedAt: 3000 });
  await post("/api/bookmarks", { book: upId, marks: [{ id: "m", chapter: 0, offset: 1, label: "", createdAt: 1 }], updatedAt: 3000 });
  assert.equal((await call("/api/books/..%2Fx", { method: "DELETE" })).status, 400);
  assert.equal((await call(`/api/books/${upId}`, { method: "DELETE" }, "wrong")).status, 401);
  assert.equal((await call(`/api/books/${upId}`, { method: "DELETE" })).status, 200);
  assert.equal((await (await call("/api/books")).json()).books.some((b) => b.id === upId), false, "off the shelf at once");
  assert.ok(![...dav.files.keys()].some((k) => k.includes(upId)), "no file of the book is left");
  assert.equal((await (await call(`/api/position?book=${upId}`)).json()).position, null);
  assert.equal((await call(`/api/books/${upId}`, { method: "DELETE" })).status, 200, "deleting twice is harmless");

  // interrupted uploads: an old unfinished folder is cleared, a recent one and published books stay
  await put("/api/upload/bstale001/0000_a.txt", "a");
  await put("/api/upload/bfresh001/0000_a.txt", "a");
  dav.mtimes.set("novel/books/bstale001", 0);
  const cleaned = await (await call("/api/upload-cleanup", { method: "POST" })).json();
  assert.deepEqual(cleaned.removed, ["bstale001"]);
  assert.ok(!dav.dirs.has("novel/books/bstale001") && ![...dav.files.keys()].some((k) => k.startsWith("novel/books/bstale001/")));
  assert.ok(dav.dirs.has("novel/books/bfresh001") && dav.dirs.has(`novel/books/${id}`), "a recent upload and a published book stay");
  assert.equal((await call("/api/upload/bfresh001", { method: "DELETE" })).status, 200, "own failed upload can be dropped");
  assert.ok(!dav.dirs.has("novel/books/bfresh001"));

  // PROPFIND parsing: other prefixes/casing, the folder itself excluded, %-escapes decoded
  const xml = `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">
    <D:response><D:href>/dav/books/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response>
    <D:response><D:href>/dav/books/b1%20x/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response>
    <D:response><D:href>/dav/books/a.txt</D:href><D:propstat><D:prop><D:resourcetype/></D:prop></D:propstat></D:response>
  </D:multistatus>`;
  assert.deepEqual(parseListing(xml), [{ name: "b1 x", isDir: true }, { name: "a.txt", isDir: false }]);
  // Koofr's form: attributes on <collection/>, no trailing slash on hrefs, props in any order
  const koofrXml = `<D:multistatus xmlns:D="DAV:">
    <D:response><D:href>/dav/Koofr/dogear/books</D:href><D:propstat><D:prop><D:resourcetype><D:collection xmlns:D="DAV:"/></D:resourcetype></D:prop></D:propstat></D:response>
    <D:response><D:href>/dav/Koofr/dogear/books/b1</D:href><D:propstat><D:prop><D:displayname>b1</D:displayname><D:resourcetype><D:collection xmlns:D="DAV:"/></D:resourcetype></D:prop></D:propstat></D:response>
    <D:response><D:href>/dav/Koofr/dogear/books/x.txt</D:href><D:propstat><D:prop><D:resourcetype></D:resourcetype></D:prop></D:propstat></D:response>
  </D:multistatus>`;
  assert.deepEqual(parseListing(koofrXml), [{ name: "b1", isDir: true }, { name: "x.txt", isDir: false }]);
  assert.deepEqual(parseListing(""), []);
  const modXml = `<D:multistatus xmlns:D="DAV:"><D:response><D:href>/d/</D:href></D:response>
    <D:response><D:href>/d/b1</D:href><D:propstat><D:prop><D:getlastmodified>Sat, 07 Nov 2026 07:11:01 GMT</D:getlastmodified><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response></D:multistatus>`;
  assert.deepEqual(parseListing(modXml), [{ name: "b1", isDir: true, modified: Date.UTC(2026, 10, 7, 7, 11, 1) }]);

  // a server (Koofr) that answers 404, not 409, for PUT under a missing folder
  const koofrLike = await startMockDav({ missingParent: 404 });
  try {
    const kd = makeDav({ DAV_URL: koofrLike.url, DAV_USER: koofrLike.user, DAV_PASS: koofrLike.pass, DAV_ROOT: "r" });
    await kd.putJson("a/b/c.json", { ok: 1 });
    assert.deepEqual(await kd.getJson("a/b/c.json"), { ok: 1 });
  } finally {
    await koofrLike.close();
  }

  // a 423 Locked on the position file is retried, and an older write that
  // loses the race to a newer one does not overwrite it
  const lockedDav = await startMockDav({ locked: 2 });
  try {
    const lenv = { DAV_URL: lockedDav.url, DAV_USER: lockedDav.user, DAV_PASS: lockedDav.pass, DAV_ROOT: "r", READER_KEY: env.READER_KEY };
    const lpost = (body) => worker.fetch(new Request("http://t/api/position", {
      method: "POST", headers: { "x-reader-key": env.READER_KEY }, body: JSON.stringify(body),
    }), lenv, {});
    assert.equal((await lpost({ book: "b1", chapter: 2, offset: 9, updatedAt: 5000 })).status, 200);
    const stored = await makeDav(lenv).getJson("state/pos/b1.json");
    assert.deepEqual(stored, { chapter: 2, char_off: 9, updated_at: 5000 });
    assert.equal((await lpost({ book: "b1", chapter: 0, offset: 1, updatedAt: 4000 })).status, 200);
    assert.equal((await makeDav(lenv).getJson("state/pos/b1.json")).updated_at, 5000);
  } finally {
    await lockedDav.close();
  }

  // Sec-MS-GEC v2 golden value, produced by the edge-tts Python package's
  // generate_sec_ms_gec_v2(1762500000)
  assert.equal(await secMsGec(1762500000),
    "713C2BF431375CEC-2322C6B3E513D50276E09641CE873C8914A93295C8DDA6121A6CBE99EDD41784");
  console.log("test-api ok");
} finally {
  await dav.close();
}
