// EPUB -> chapters, as pure functions over the unzipped archive ({path: Uint8Array}).
// No I/O and no DOM, so the publish script (node) and a future browser importer
// share it; the caller supplies the unzip step (fflate's unzipSync).
//
// Each chapter comes back as { title, body } where the first line of body IS the
// title, the same contract split-core.mjs gives TXT chapters (the reader shows
// that line as the heading and skips it as a paragraph).

import { spaceHeading, spaceHeadingLine } from "./split-core.mjs";

const decoder = new TextDecoder("utf-8");

const NAMED = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  mdash: "—", ndash: "–", hellip: "…", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
};

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"));
  return m ? decodeEntities(m[1] ?? m[2]) : null;
};

const stripTags = (s) => decodeEntities(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();

// "OEBPS/text" + "../images/a.jpg" -> "OEBPS/images/a.jpg"
function resolvePath(baseDir, href) {
  const out = baseDir ? baseDir.split("/") : [];
  for (const part of decodeURIComponent(href.split("#")[0]).split("/")) {
    if (part === "..") out.pop();
    else if (part && part !== ".") out.push(part);
  }
  return out.join("/");
}

const readText = (files, path) => (files[path] ? decoder.decode(files[path]) : null);

// One chapter page -> { heading, lines, links }: lines are the visible paragraphs, one per
// line (a paragraph's own full-width indent is kept), heading is the first h1-h3.
export function pageToLines(html) {
  const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html;
  const heading = stripTags(body.match(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/i)?.[1] ?? "") || null;
  const links = (body.match(/<a\b/gi) ?? []).length;
  const lines = decodeEntities(
    body
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "")
      .replace(/[ \t\r\n\f]+/g, " ") // source indentation is not content; \s would also eat the U+3000 paragraph indent
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|h[1-6]|li|dt|dd|tr|blockquote|section)>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .split("\n")
    .map((l) => l.replace(/^ +| +$/g, ""))
    .filter((l) => l !== "");
  return { heading, lines, links };
}

// href-path -> chapter title, from the NCX or the EPUB 3 nav document
function readToc(files, items, opfDir) {
  const titles = new Map();
  const add = (href, label) => {
    const key = resolvePath(opfDir, href);
    const title = stripTags(label);
    if (title && !titles.has(key)) titles.set(key, title);
  };
  const ncx = items.find((i) => i.type === "application/x-dtbncx+xml");
  const ncxText = ncx && readText(files, resolvePath(opfDir, ncx.href));
  if (ncxText) {
    const re = /<navLabel[^>]*>\s*<text[^>]*>([\s\S]*?)<\/text>\s*<\/navLabel>\s*<content[^>]*\bsrc\s*=\s*"([^"]*)"/gi;
    for (const m of ncxText.matchAll(re)) add(m[2], m[1]);
  }
  if (!titles.size) {
    const nav = items.find((i) => /\bnav\b/.test(i.properties ?? ""));
    const navText = nav && readText(files, resolvePath(opfDir, nav.href));
    if (navText) {
      const navDir = resolvePath(opfDir, nav.href).split("/").slice(0, -1).join("/");
      for (const m of navText.matchAll(/<a\b[^>]*\bhref\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
        const key = resolvePath(navDir, m[1]);
        const title = stripTags(m[2]);
        if (title && !titles.has(key)) titles.set(key, title);
      }
    }
  }
  return titles;
}

export function parseEpub(files) {
  const container = readText(files, "META-INF/container.xml");
  const opfPath = container && attr(container.match(/<rootfile\b[^>]*>/i)?.[0] ?? "", "full-path");
  const opf = opfPath && readText(files, opfPath);
  if (!opf) throw new Error("not an EPUB: no package document");
  const opfDir = opfPath.split("/").slice(0, -1).join("/");

  const items = [...opf.matchAll(/<item\b[^>]*>/gi)].map((m) => ({
    id: attr(m[0], "id"), href: attr(m[0], "href"), type: attr(m[0], "media-type"), properties: attr(m[0], "properties"),
  }));
  const byId = new Map(items.map((i) => [i.id, i]));
  const spine = [...opf.matchAll(/<itemref\b[^>]*>/gi)]
    .map((m) => ({ item: byId.get(attr(m[0], "idref")), linear: attr(m[0], "linear") }))
    .filter((s) => s.item && s.linear !== "no" && /x?html/.test(s.item.type ?? ""));

  const meta = (tag) => {
    const m = opf.match(new RegExp(`<dc:${tag}\\b[^>]*>([\\s\\S]*?)</dc:${tag}>`, "i"));
    return m ? stripTags(m[1]) : "";
  };
  const toc = readToc(files, items, opfDir);

  const chapters = [];
  for (const { item } of spine) {
    const path = resolvePath(opfDir, item.href);
    const html = readText(files, path);
    if (!html) continue;
    const { heading, lines, links } = pageToLines(html);
    // a contents page: many links, little text around each
    if (links >= 10 && lines.join("").length / links < 80) continue;
    const content = heading && lines[0] === heading ? lines.slice(1) : lines;
    if (!content.length) continue; // divider or cover page with nothing to read

    const title = toc.get(path) ?? heading ?? `第 ${chapters.length + 1} 章`;
    chapters.push({ title: spaceHeading(title), body: spaceHeadingLine([title, ...content].join("\n")) });
  }
  return { title: meta("title"), author: meta("creator"), chapters };
}
