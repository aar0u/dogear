// parseEpub on a small synthetic EPUB: titles from the NCX, contents page and cover
// skipped, heading line replaced by the TOC title, entities decoded, indent kept.
import assert from "node:assert/strict";
import { strToU8, unzipSync, zipSync } from "fflate";
import { decodeEntities, parseEpub } from "../public/epub-core.mjs";
import { decodeText, parseBook } from "../public/import-core.mjs";

const page = (body) => `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body>\n${body}\n</body></html>`;
const epub = zipSync({
  "META-INF/container.xml": strToU8(`<container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`),
  "OEBPS/content.opf": strToU8(`<package><metadata xmlns:dc="x"><dc:title>测试&amp;书</dc:title><dc:creator>某人</dc:creator></metadata>
    <manifest>
      <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
      <item id="cover" href="cover.html" media-type="application/xhtml+xml"/>
      <item id="toc" href="book-toc.html" media-type="application/xhtml+xml"/>
      <item id="c1" href="text/c1.html" media-type="application/xhtml+xml"/>
      <item id="c2" href="text/c2.html" media-type="application/xhtml+xml"/>
      <item id="c3" href="text/c3.html" media-type="application/xhtml+xml"/>
      <item id="img" href="cover.jpg" media-type="image/jpeg"/>
    </manifest>
    <spine toc="ncx"><itemref idref="cover" linear="no"/><itemref idref="toc"/><itemref idref="c1"/><itemref idref="c2"/><itemref idref="c3"/></spine></package>`),
  "OEBPS/toc.ncx": strToU8(`<ncx><navMap>
    <navPoint><navLabel><text>第一章 开始</text></navLabel><content src="text/c1.html"/></navPoint>
    <navPoint><navLabel><text>第二章 继续</text></navLabel><content src="text/c2.html#a"/></navPoint>
  </navMap></ncx>`),
  "OEBPS/cover.html": strToU8(page(`<img src="cover.jpg"/>`)),
  "OEBPS/book-toc.html": strToU8(page(`<h2>目录</h2>` + Array.from({ length: 12 }, (_, i) => `<p><a href="text/c1.html">章${i}</a></p>`).join(""))),
  "OEBPS/text/c1.html": strToU8(page(`<h2 id="title">第一章开始</h2>\n<p class="a">　　他说：&ldquo;你好&rdquo;。&amp;</p>\n<p>第二段<br/>换行</p>`)),
  "OEBPS/text/c2.html": strToU8(page(`<p>没有标题的章节正文。</p>`)),
  "OEBPS/text/c3.html": strToU8(page(`<h2>只有标题</h2>`)),
});

const book = parseEpub(unzipSync(epub));

assert.equal(book.title, "测试&书");
assert.equal(book.author, "某人");
assert.equal(book.chapters.length, 2, "cover, contents page and the heading-only page are skipped");

const [c1, c2] = book.chapters;
assert.equal(c1.title, "第一章　开始", "TOC title wins, spaced like TXT headings");
assert.equal(c1.body.split("\n")[0], c1.title, "first line of body is the title");
assert.deepEqual(c1.body.split("\n").slice(1), ["　　他说：“你好”。&", "第二段", "换行"]);
assert.equal(c2.title, "第二章　继续", "fragment in the NCX src still maps to the file");
assert.equal(c2.body, "第二章　继续\n没有标题的章节正文。");

assert.equal(decodeEntities("&#x4e2d;&#25991;&nbsp;&unknown;"), "中文 &unknown;");

// the browser uploader's entry point: EPUB and TXT (UTF-8 and GBK) through parseBook
const viaEpub = parseBook({ name: "测试.epub", bytes: epub, unzipSync });
assert.deepEqual([viaEpub.title, viaEpub.author, viaEpub.pieces.length], ["测试&书", "某人", 2]);
const txt = "第一章 开始\n正文一\n第二章 继续\n正文二\n第三章 结束\n正文三\n";
const viaTxt = parseBook({ name: "我的书.txt", bytes: strToU8(txt), unzipSync });
assert.deepEqual([viaTxt.title, viaTxt.pieces.length, viaTxt.headingCount], ["我的书", 3, 3]);
assert.equal(decodeText(new Uint8Array([0xb5, 0xda, 0xd5, 0xc2])), "第章", "GBK bytes");
assert.equal(parseBook({ name: "x.txt", bytes: strToU8("没有章节标题的文字\n"), unzipSync }).headingCount, 0);
assert.throws(() => parseEpub({}), /not an EPUB/);
console.log("test-epub ok");
