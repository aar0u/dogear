// Paragraph skipping for the ⏮/⏭ buttons.
import assert from "node:assert/strict";
import { paragraphStarts, RESTART_CHARS, skipTarget } from "../public/tts-core.mjs";

// the heading, then three paragraphs, one with a full-width indent and a blank line between two
const text = "第一章\n　　甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥天地玄黄。\n\n乙段很短。\n　　丙段在这里。\n";
const starts = paragraphStarts(text);
assert.deepEqual(starts.map((s) => text.slice(s, s + 2)), ["第一", "甲乙", "乙段", "丙段"], "indent and blank lines are skipped");
const [h, a, b, c] = starts;

// forward: the next paragraph, from anywhere inside this one; null after the last
assert.equal(skipTarget(text, h, 1), a);
assert.equal(skipTarget(text, a + 5, 1), b);
assert.equal(skipTarget(text, b, 1), c);
assert.equal(skipTarget(text, c + 2, 1), null, "off the end of the chapter");

// back: deep in a paragraph restarts it; just after its start goes to the one before
assert.equal(skipTarget(text, a + RESTART_CHARS + 1, -1), a, "restart this paragraph");
assert.equal(skipTarget(text, a + 3, -1), h, "only just began: the previous one");
assert.equal(skipTarget(text, b + 1, -1), a);
assert.equal(skipTarget(text, h + 1, -1), null, "off the start of the chapter");
assert.equal(skipTarget(text, h + RESTART_CHARS + 1, -1), h, "a long heading restarts itself");

console.log("test-tts-core ok");
