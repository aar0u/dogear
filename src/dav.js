// Minimal WebDAV client over fetch: only the verbs the reader needs.
// Paths are relative to DAV_URL + DAV_ROOT and use "/" separators.

const enc = new TextEncoder();

function basicAuth(user, pass) {
  const bytes = enc.encode(`${user}:${pass}`);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return `Basic ${btoa(bin)}`;
}

const tag = (name) => `(?:[\\w-]+:)?${name}`;
const RESPONSE_RE = new RegExp(`<${tag("response")}[\\s>][\\s\\S]*?</${tag("response")}>`, "gi");
const HREF_RE = new RegExp(`<${tag("href")}>([^<]+)</${tag("href")}>`, "i");
// attributes allowed: Koofr writes <D:collection xmlns:D="DAV:"/>
const COLLECTION_RE = new RegExp(`<${tag("collection")}(?:\\s[^>]*)?/?>`, "i");

// PROPFIND multistatus -> [{ name, isDir }], without the listed folder itself.
export function parseListing(xml) {
  const out = [];
  const items = xml.match(RESPONSE_RE) ?? [];
  for (const item of items) {
    const href = item.match(HREF_RE)?.[1];
    if (!href) continue;
    out.push({ href: decodeURIComponent(href.trim()), isDir: COLLECTION_RE.test(item) });
  }
  if (!out.length) return [];
  // the first response of a Depth:1 PROPFIND is the folder itself
  const self = out[0].href.replace(/\/+$/, "");
  return out
    .filter((e, i) => i > 0 && e.href.replace(/\/+$/, "") !== self)
    .map((e) => ({ name: e.href.replace(/\/+$/, "").split("/").pop(), isDir: e.isDir }));
}

export function makeDav(env) {
  if (!env.DAV_URL) throw new Error("DAV_URL is not set");
  const root = [env.DAV_URL.replace(/\/+$/, ""), (env.DAV_ROOT ?? "dogear").replace(/^\/+|\/+$/g, "")]
    .filter(Boolean).join("/");
  const auth = basicAuth(env.DAV_USER ?? "", env.DAV_PASS ?? "");

  const urlOf = (path) =>
    root + (path ? "/" + path.split("/").filter(Boolean).map(encodeURIComponent).join("/") : "");
  // 429/503 are retried with backoff: Koofr rate limits bursts, and a book upload is hundreds of PUTs
  const call = async (method, path, init = {}) => {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(urlOf(path), { method, ...init, headers: { authorization: auth, ...init.headers } });
      if ((res.status !== 429 && res.status !== 503) || attempt >= 4) return res;
      await res.arrayBuffer();
      const wait = Number(res.headers.get("retry-after")) * 1000 || 1000 * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, Math.min(wait, 15_000)));
    }
  };

  async function mkcols(path) {
    // create every missing ancestor of a file path, outermost first
    const parts = path.split("/").filter(Boolean);
    const dirs = ["", ...parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"))];
    for (const dir of dirs) {
      let res = await call("MKCOL", dir);
      // 423: another request is creating the same folder right now (Koofr); look again
      for (let i = 0; res.status === 423 && i < 3; i++) {
        await new Promise((resolve) => setTimeout(resolve, 700));
        res = await call("MKCOL", dir);
      }
      // 405 means "already exists" on every server tried; other codes are real failures
      if (!res.ok && res.status !== 405) throw new Error(`MKCOL ${dir || "/"}: ${res.status}`);
    }
  }

  const api = {
    // Raw Response; the caller decides how to treat 404.
    get: (path, init) => call("GET", path, init),

    async getJson(path) {
      const res = await call("GET", path);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
      try {
        return await res.json();
      } catch {
        return null; // a half-written or corrupt file reads as absent
      }
    },

    async put(path, body, contentType = "application/octet-stream") {
      const send = () => call("PUT", path, { body, headers: { "content-type": contentType } });
      let res = await send();
      // a missing parent folder is 409 on most servers and 404 on Koofr
      if (res.status === 409 || res.status === 404) {
        await mkcols(path);
        res = await send();
      }
      if (!res.ok) throw new Error(`PUT ${path}: ${res.status}`);
    },

    putJson: (path, value) => api.put(path, JSON.stringify(value), "application/json"),

    async list(path) {
      const res = await call("PROPFIND", path, { headers: { depth: "1", "content-type": "application/xml" } });
      if (res.status === 404) return [];
      if (!res.ok && res.status !== 207) throw new Error(`PROPFIND ${path}: ${res.status}`);
      return parseListing(await res.text());
    },

    async remove(path) {
      const res = await call("DELETE", path);
      if (!res.ok && res.status !== 404) throw new Error(`DELETE ${path}: ${res.status}`);
    },
  };
  return api;
}
