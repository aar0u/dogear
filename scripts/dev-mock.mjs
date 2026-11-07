#!/usr/bin/env node
// Local dev without a real WebDAV account: an in-memory WebDAV server seeded
// with one sample book, plus `wrangler dev` pointed at it.
//   node scripts/dev-mock.mjs   -> http://127.0.0.1:8787  (reader key: dev-key)
import { spawn } from "node:child_process";
import { makeDav } from "../src/dav.js";
import { publishText } from "./publish-book.mjs";
import { startMockDav } from "./mock-dav.mjs";

const mock = await startMockDav();
const env = { DAV_URL: mock.url, DAV_USER: mock.user, DAV_PASS: mock.pass, DAV_ROOT: "novel" };

const chapters = Array.from({ length: 12 }, (_, i) =>
  `第${i + 1}章 示例章节\n` + "这是一段用于测试排版和朗读的示例文字。".repeat(60 + i * 10).replace(/。/g, "。\n"))
  .join("\n");
await publishText(makeDav(env), chapters, { title: "示例小说", author: "测试" });

const vars = { ...env, READER_KEY: "dev-key" };
const args = ["wrangler", "dev", "--port", "8787", ...Object.entries(vars).flatMap(([k, v]) => ["--var", `${k}:${v}`])];
const child = spawn("npx", args, { stdio: "inherit" });
const stop = () => { child.kill(); mock.close(); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
child.on("exit", () => process.exit(0));
