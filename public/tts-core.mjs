// TTS chunking core shared by src/worker.js (synthesis) and the reader's
// audio player in app.js. Pure functions over strings — both sides must
// produce identical chunk boundaries, or the audio the worker synthesizes
// and the char offsets the reader tracks drift apart.

// Measured on edge-tts zh-TW-HsiaoChenNeural (劍來 ch.1, 248-char chunk →
// 54.6 s): Mandarin speech averages ~4.5 chars/sec. Only a fallback for
// playback→offset mapping — the player prefers proportional mapping over
// the real audio.duration once metadata is loaded.
export const CHARS_PER_SEC = 4.5;

// Whole sentences are packed up to this many chars per chunk (~60–70 s of
// audio per synthesis request). Chunk 0 is always the heading line alone
// (chapter number + name announced by themselves — and at ~2 s of audio it
// doubles as the fast start); the first content chunk after it stays small
// so narration flows while the big chunks synthesize.
export const CHUNK_CHARS = 280;
export const FIRST_CHUNK_CHARS = 100;

// Exported because wasm-tts.mjs splits the same text again, one sentence per
// synthesis unit: two definitions of "what ends a sentence" would drift, and
// the drift would show up as audio boundaries that disagree with chunk offsets.
export const ENDERS = "。！？；\n";
export const CLOSERS = "」』”’）)】";

// Chapter text → [{ start, chars, text }] where start is the char offset of
// the chunk in `text` (same offsets as the reader's p[data-off] paragraphs)
// and text is the raw slice — clean it with ttsPrompt() before synthesis.
export function chunkChapter(text) {
  const headChunks = [];
  // the heading line (chapter number + name) is its own chunk
  const lead = text.match(/^\s*/)[0].length;
  let bodyStart = lead;
  if (lead < text.length) {
    let nl = text.indexOf("\n", lead);
    if (nl === -1) nl = text.length;
    // absorb blank lines after the heading so the body starts at content
    let end = nl;
    while (end < text.length && !text[end].trim()) end++;
    headChunks.push({ start: lead, end });
    bodyStart = end;
  }

  // sentence spans: split after 。！？；or newline, plus any closing quotes
  const sentences = [];
  let s = bodyStart;
  for (let i = bodyStart; i < text.length; i++) {
    if (ENDERS.includes(text[i])) {
      let e = i + 1;
      while (e < text.length && CLOSERS.includes(text[e])) e++;
      sentences.push([s, e]);
      s = e;
      i = e - 1;
    }
  }
  if (s < text.length) sentences.push([s, text.length]);

  // a "sentence" longer than a whole chunk (no 。！？； for hundreds of
  // chars) would blow past the model's input comfort zone — sub-split it at
  // secondary pauses ，、：, hard-cutting as a last resort
  const spans = sentences.flatMap(([a, b]) =>
    b - a <= CHUNK_CHARS ? [[a, b]] : subSplit(text, a, b),
  );

  const chunks = headChunks;
  let cur = null;
  for (const [a, b] of spans) {
    if (!text.slice(a, b).trim()) {
      // whitespace-only span (blank line): absorb into the current chunk so
      // the next chunk starts at real content
      if (cur) cur.end = b;
      continue;
    }
    // chunk 0 is the heading; the first content chunk stays small
    const limit = chunks.length <= 1 ? FIRST_CHUNK_CHARS : CHUNK_CHARS;
    if (cur && cur.end - cur.start + (b - a) > limit) {
      chunks.push(cur);
      cur = null;
    }
    if (!cur) cur = { start: a, end: b };
    else cur.end = b;
  }
  if (cur) chunks.push(cur);

  return chunks.map((c) => ({
    start: c.start,
    chars: c.end - c.start,
    text: text.slice(c.start, c.end),
  }));
}

const PAUSES = "，、：";

function subSplit(text, a, b) {
  const out = [];
  let s = a;
  for (let i = a; i < b; i++) {
    const atPause = PAUSES.includes(text[i]);
    if ((atPause && i + 1 - s >= CHUNK_CHARS / 2) || i + 1 - s >= CHUNK_CHARS) {
      out.push([s, i + 1]);
      s = i + 1;
    }
  }
  if (s < b) out.push([s, b]);
  return out;
}

// Start of the sentence containing raw index `i` in `text` — the same
// ENDERS+CLOSERS walk chunkChapter (above) and wasm-tts's segments() run,
// so "snap a reading to a sentence" can never disagree with where the
// splitters cut. The player starts a new reading here: the requested char
// is usually mid-sentence (a page opens wherever the previous one ended),
// and audio must open on a sentence, not a fragment.
export function sentenceStartFor(text, i) {
  let s = 0;
  for (let j = 0; j < text.length; j++) {
    if (!ENDERS.includes(text[j])) continue;
    let e = j + 1;
    while (e < text.length && CLOSERS.includes(text[e])) e++;
    if (e > i) break;
    s = e;
    j = e - 1;
  }
  return s;
}

// End of the sentence containing raw index `i` — the first boundary after
// `i` in the same walk, so [sentenceStartFor, sentenceEndFor) is exactly one
// sentence span. The player highlights this span as it is spoken.
export function sentenceEndFor(text, i) {
  for (let j = 0; j < text.length; j++) {
    if (!ENDERS.includes(text[j])) continue;
    let e = j + 1;
    while (e < text.length && CLOSERS.includes(text[e])) e++;
    if (e > i) return e;
    j = e - 1;
  }
  return text.length;
}

// Index of the chunk containing char offset `off` (clamped to valid range).
export function chunkIndexFor(chunks, off) {
  let idx = 0;
  for (let i = 0; i < chunks.length; i++) {
    if (chunks[i].start <= off) idx = i;
    else break;
  }
  return idx;
}

// Raw chunk slice → text sent to the model: collapse newlines and full-width
// indent spaces (paragraph layout, not speech) into single spaces, then turn
// the ones between Han characters into 「，」. A heading's 「第幾章 名字」 gap
// marks a break the owner wants HEARD (2026-08-15), and the offline
// frontend skips whitespace before tokenizing — a bare space was a pause
// only the online voices happened to honor. A comma is the one break mark
// every engine reads, and reads alike. Only between Han: a zh-en boundary
// Offsets of the first character of every paragraph (a non-blank line) — the
// same numbers the reader puts on its p[data-off] elements.
export function paragraphStarts(text) {
  const starts = [];
  let at = 0;
  for (const line of text.split("\n")) {
    const ink = line.search(/\S/);
    if (ink >= 0) starts.push(at + ink);
    at += line.length + 1;
  }
  return starts;
}

// If the voice has been in a paragraph for fewer than this many characters,
// ⏮ goes to the paragraph before it instead of restarting this one.
export const RESTART_CHARS = 20;

// Where ⏮/⏭ (d = -1 / +1) should take the voice, as an offset in the chapter:
// the start of the next paragraph, or the start of this one (the one before when
// the voice has only just begun this one). null = off the end or the start of
// the chapter, i.e. the neighbouring chapter.
export function skipTarget(text, off, d) {
  const starts = paragraphStarts(text);
  if (d > 0) return starts.find((s) => s > off) ?? null;
  const here = starts.findLast((s) => s <= off);
  if (here !== undefined && off - here > RESTART_CHARS) return here;
  return starts.findLast((s) => s < (here ?? off)) ?? null;
}

// keeps its space, which is a word break, not a pause.
export function ttsPrompt(chunkText) {
  return chunkText.replace(/[\s　]+/g, " ").trim()
    .replace(/(?<=\p{Script=Han}) (?=\p{Script=Han})/gu, "，");
}

// The synthesizer reports the sentences it spoke as text (t0/t1 in ms), with
// the chunk's quotes and line breaks stripped and the commas ttsPrompt adds.
// Find each one's first char in the chunk's raw text: [[t0, offset in chunk]].
// A char the raw text lacks (an added comma) is skipped; a char further than
// LOOKAHEAD raw chars on (a quote, an indent, a newline) is not searched for.
// null when the text cannot be followed — the caller falls back to the
// proportional estimate rather than trusting a bad map.
// Position in a chunk from its marks: the char offset (in the chunk) of the
// sentence being spoken `sec` seconds in, and the time a sentence containing
// chunk offset `rel` starts at. Before the first mark the first sentence counts.
export function markOffsetAt(marks, sec) {
  let at = marks[0][1];
  for (const [t, off] of marks) {
    if (t > sec * 1000) break;
    at = off;
  }
  return at;
}

export function markTimeFor(marks, rel) {
  let at = marks[0][0];
  for (const [t, off] of marks) {
    if (off > rel) break;
    at = t;
  }
  return at / 1000;
}

const LOOKAHEAD = 6;
export function alignMarks(raw, sentences) {
  const marks = [];
  let cur = 0;
  for (const s of sentences) {
    const chars = [...s.text].filter((ch) => ch.trim());
    if (!chars.length) continue;
    let first = -1;
    for (const ch of chars) {
      const at = raw.slice(cur, cur + LOOKAHEAD).indexOf(ch);
      if (at < 0) continue;
      cur += at + 1;
      if (first < 0) first = cur - 1;
    }
    if (first < 0 || (marks.length && first <= marks[marks.length - 1][1])) return null;
    marks.push([s.t0, first]);
  }
  return marks.length ? marks : null;
}
