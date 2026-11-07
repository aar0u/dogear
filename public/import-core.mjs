// A book file (TXT or EPUB) -> pieces ready for piecesToEntries. Shared by the
// browser uploader and scripts/publish-book.mjs; the caller supplies the unzip
// step (fflate's unzipSync) because the two import it from different places.

import { parseEpub } from "./epub-core.mjs";
import { splitTextIntoPieces } from "./split-core.mjs";

// BOMs first, then strict UTF-8, then GB18030 (covers GBK).
export function decodeText(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder("utf-16le").decode(buf);
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder("utf-16be").decode(buf);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf).replace(/^﻿/, "");
  } catch {
    return new TextDecoder("gb18030").decode(buf);
  }
}

export function parseBook({ name, bytes, unzipSync }) {
  const base = name.replace(/\.[^.]+$/, "");
  if (/\.epub$/i.test(name)) {
    const book = parseEpub(unzipSync(bytes));
    return { title: book.title || base, author: book.author, pieces: book.chapters, headingCount: book.chapters.length };
  }
  const { pieces, headingCount } = splitTextIntoPieces(decodeText(bytes), { bookTitle: base });
  return { title: base, author: "", pieces, headingCount };
}
