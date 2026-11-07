#!/usr/bin/env node
// Smoke-test a real WebDAV account with the exact calls the worker makes.
// Reads DAV_URL, DAV_USER, DAV_PASS, DAV_ROOT from the environment or .dev.vars,
// writes only under <DAV_ROOT>/_check/, removes it afterwards, and prints
// statuses and timings (never credentials).
//   node scripts/check-dav.mjs

import { makeDav } from "../src/dav.js";
import { loadDevVars } from "./publish-book.mjs";

loadDevVars();
const dav = makeDav(process.env);
let failed = 0;

async function step(name, fn) {
  const t0 = performance.now();
  try {
    const detail = await fn();
    console.log(`ok   ${name} (${Math.round(performance.now() - t0)} ms)${detail ? " " + detail : ""}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}: ${err.message}`);
    // stop at the first auth or rate-limit answer: more attempts only deepen a 429 lockout
    if (/: (401|403|429)$/.test(err.message)) {
      console.log("stopped: the server refused the credentials or is rate limiting. " +
        "Check DAV_USER/DAV_PASS (an app password, not the login password), then wait a few minutes.");
      process.exit(1);
    }
  }
}
const must = (cond, msg) => { if (!cond) throw new Error(msg); };

const dir = "_check";
const cn = `${dir}/sub/第一章 测试.txt`;

await step("PUT into missing folders (MKCOL fallback)", () => dav.put(cn, "你好，世界\n", "text/plain; charset=utf-8"));
await step("PUT again, folders already exist", () => dav.put(cn, "你好，世界2\n", "text/plain; charset=utf-8"));
await step("GET returns what was written", async () => {
  const res = await dav.get(cn);
  must(res.ok, `status ${res.status}`);
  must((await res.text()) === "你好，世界2\n", "content differs");
});
await step("GET missing file is 404", async () => {
  const res = await dav.get(`${dir}/nope.txt`);
  await res.arrayBuffer();
  must(res.status === 404, `status ${res.status}`);
});
await step("JSON round trip", async () => {
  await dav.putJson(`${dir}/state.json`, { a: 1, 书: "x" });
  const back = await dav.getJson(`${dir}/state.json`);
  must(back?.a === 1 && back.书 === "x", "content differs");
});
await step("PROPFIND lists children, decodes names", async () => {
  const names = (await dav.list(`${dir}/sub`)).map((e) => e.name);
  must(names.includes("第一章 测试.txt"), `got ${JSON.stringify(names)}`);
  const top = (await dav.list(dir)).map((e) => `${e.name}${e.isDir ? "/" : ""}`).sort();
  return top.join(" ");
});
await step("PROPFIND on missing folder is empty", async () => {
  must((await dav.list(`${dir}/none`)).length === 0, "not empty");
});
await step("cleanup", async () => {
  await dav.remove(cn);
  await dav.remove(`${dir}/state.json`);
  await dav.remove(`${dir}/sub`);
  await dav.remove(dir);
});

console.log(failed ? `${failed} step(s) failed` : "all steps passed");
process.exit(failed ? 1 : 0);
