// In-memory WebDAV server for tests: GET, PUT, MKCOL, DELETE, PROPFIND (Depth 1).
import { createServer } from "node:http";

// missingParent: the status a server answers for PUT/MKCOL under a missing folder
// (409 per RFC 4918; Koofr answers 404).
// locked: how many PUTs to answer with 423 before accepting (Koofr locks a file
// that another PUT is still writing).
export function startMockDav({ user = "u", pass = "p", missingParent = 409, locked = 0 } = {}) {
  let lockedLeft = locked;
  const files = new Map(); // "a/b.txt" -> { body: Buffer, type }
  const dirs = new Set([""]);
  const mtimes = new Map(); // folder -> ms, set when created; tests may backdate it
  const expected = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
  const rel = (url) =>
    decodeURIComponent(new URL(url, "http://x").pathname).replace(/^\/dav\/?/, "").replace(/\/+$/, "");
  const parentOf = (p) => p.split("/").slice(0, -1).join("/");
  const esc = (s) => encodeURIComponent(s).replace(/%2F/g, "/");

  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== expected) {
      res.writeHead(401, { "www-authenticate": 'Basic realm="x"' }).end();
      return;
    }
    const p = rel(req.url);
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const send = (code, headers = {}, data) => res.writeHead(code, headers).end(data);

    if (req.method === "GET") {
      const f = files.get(p);
      return f ? send(200, { "content-type": f.type }, f.body) : send(404);
    }
    if (req.method === "PUT") {
      if (!dirs.has(parentOf(p))) return send(missingParent);
      if (lockedLeft > 0 && p.startsWith("state/")) { lockedLeft--; return send(423); }
      files.set(p, { body, type: req.headers["content-type"] ?? "application/octet-stream" });
      return send(201);
    }
    if (req.method === "MKCOL") {
      if (dirs.has(p)) return send(405);
      if (!dirs.has(parentOf(p))) return send(missingParent);
      dirs.add(p);
      mtimes.set(p, Date.now());
      return send(201);
    }
    if (req.method === "DELETE") {
      // deleting a folder removes everything under it
      const prefix = p + "/";
      const isDir = dirs.has(p);
      for (const f of [...files.keys()]) if (f.startsWith(prefix)) files.delete(f);
      for (const d of [...dirs]) if (d.startsWith(prefix)) { dirs.delete(d); mtimes.delete(d); }
      const had = files.delete(p) || dirs.delete(p) || isDir;
      mtimes.delete(p);
      return send(had ? 204 : 404);
    }
    if (req.method === "PROPFIND") {
      if (!dirs.has(p)) return send(404);
      const prefix = p ? p + "/" : "";
      const kids = [
        ...[...dirs].filter((d) => d && d.startsWith(prefix) && !d.slice(prefix.length).includes("/")),
        ...[...files.keys()].filter((f) => f.startsWith(prefix) && !f.slice(prefix.length).includes("/")),
      ];
      const entry = (path, isDir) =>
        `<d:response><d:href>/dav/${esc(path)}${isDir ? "/" : ""}</d:href><d:propstat><d:prop>` +
        `<d:resourcetype>${isDir ? "<d:collection/>" : ""}</d:resourcetype>` +
        (isDir && mtimes.has(path) ? `<d:getlastmodified>${new Date(mtimes.get(path)).toUTCString()}</d:getlastmodified>` : "") +
        `</d:prop></d:propstat></d:response>`;
      const xml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${entry(p, true)}` +
        kids.map((k) => entry(k, dirs.has(k))).join("") + "</d:multistatus>";
      return send(207, { "content-type": "application/xml" }, xml);
    }
    send(405);
  });

  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}/dav`,
        user, pass, files, dirs, mtimes,
        close: () => new Promise((r) => server.close(r)),
      })));
}
