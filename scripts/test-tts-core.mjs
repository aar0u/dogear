// Paragraph skipping for the ⏮/⏭ buttons.
import assert from "node:assert/strict";
import { alignMarks, markOffsetAt, markTimeFor, paragraphStarts, RESTART_CHARS, skipTarget } from "../public/tts-core.mjs";

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

// synthesizer sentences → offsets in the raw chunk (text as Edge returned it
// for the probe: quotes and the newline dropped)
{
  const raw = "　　他推开门，屋里没有人。桌上放着一封信。\n“你来晚了。”身后忽然有人说话！\n三年前的今天。";
  const got = alignMarks(raw, [
    { t0: 100, text: "他推开门，屋里没有人。" },
    { t0: 2600, text: "桌上放着一封信。" },
    { t0: 6000, text: "你来晚了。" },
    { t0: 7400, text: "身后忽然有人说话！" },
    { t0: 10500, text: "三年前的今天。" },
  ]);
  assert.deepEqual(got.map(([, o]) => raw.slice(o, o + 2)), ["他推", "桌上", "你来", "身后", "三年"]);
  assert.deepEqual(got.map(([t]) => t), [100, 2600, 6000, 7400, 10500]);
  assert.equal(markOffsetAt(got, 0), got[0][1], "before the first mark: the first sentence");
  assert.equal(markOffsetAt(got, 2.6), got[1][1]);
  assert.equal(markOffsetAt(got, 99), got[4][1]);
  assert.equal(markTimeFor(got, got[2][1]), 6);
  assert.equal(markTimeFor(got, got[2][1] + 1), 6, "mid-sentence: that sentence's start");
  assert.equal(markTimeFor(got, 0), 0.1);
  // an added comma (ttsPrompt puts one between Han chars split by whitespace) is skipped
  const sp = alignMarks("第一章 天地", [{ t0: 0, text: "第一章，天地" }]);
  assert.deepEqual(sp, [[0, 0]]);
  // text that does not occur in the chunk: no map
  assert.equal(alignMarks("甲乙丙。", [{ t0: 0, text: "xyz" }]), null);
  assert.equal(alignMarks("甲乙丙。", []), null);
}

console.log("test-tts-core ok");
