// Microsoft Edge "read aloud" TTS over WebSocket, runnable inside a Worker.
// Speaks the protocol of the edge-tts Python package: one wss connection per
// synthesis, speech.config + SSML in, MP3 audio frames out (24 kHz 48 kbps
// mono). Free, no API key — the endpoint authenticates with a time-derived
// Sec-MS-GEC hash of a public client token.

const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const WSS_HOST = "speech.platform.bing.com";
const WSS_PATH = "/consumer/speech/synthesize/readaloud/edge/v1";
// keep in sync with the edge-tts Python package's CHROMIUM_FULL_VERSION —
// Microsoft appears to reject tokens claiming stale browser versions
const CHROMIUM_FULL = "143.0.3650.75";
const CHROMIUM_MAJOR = CHROMIUM_FULL.split(".")[0];
const SYNTH_TIMEOUT_MS = 30_000;

// Sec-MS-GEC v2 (required since the v1 SHA-256-only token started getting
// HTTP 403): "<CS64 checksum>-<SHA-256>" over Edge's copyright line followed
// by "<windows ticks floored to 5 min><token>". The tick count deliberately
// goes through double-precision multiplication (ticks * 1e7 overflows 2^53):
// the server validates against the original client's rounding, and BigInt(double)
// prints that double's exact integer value.
// The CS64 part is adapted from msedge-tts (MIT), which worked it out from
// https://github.com/rany2/edge-tts/pull/492.
const EDGE_COPYRIGHT = "Copyright (C) Microsoft Corporation. All rights reserved.";
const SWAP_FIRST = { word: 0xEF0569FB, sum: 0x76F50F34, product: 0xC3EFEA97 };
const SWAP_SECOND = { word: 0xC31713DB, sum: 0x1881CE3C, product: 0x35BD1EC9 };
const MIX_FIRST = [0xCF98B111, 0x87085B9F, 0x12CEB96D, 0x257E1D83];
const MIX_SECOND = [0xA27416F5, 0xD38396FF, 0x7C932B89, 0xBFA49F69];

const swapHalves = (v) => ((v << 16) | (v >>> 16)) >>> 0;
const upperHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();

function swapTerm(word, key, m) {
  const sum = Math.imul(word, key) + Math.imul(swapHalves(word), m.word);
  const product = Math.imul(swapHalves(sum), m.sum) >>> 0;
  return (Math.imul(swapHalves(product), m.product) + product) >>> 0;
}

function swapAndMultiply(value, multipliers) {
  for (const m of multipliers) value = Math.imul(swapHalves(value), m) >>> 0;
  return value;
}

function cs64(message, digest) {
  const d = new DataView(digest.buffer, digest.byteOffset, digest.byteLength);
  const firstKey = (d.getUint32(0, true) | 1) >>> 0;
  const secondKey = (d.getUint32(4, true) | 1) >>> 0;
  // little-endian 32-bit word pairs, zero-padded to a whole pair
  const padded = new Uint8Array(Math.ceil(message.length / 8) * 8);
  padded.set(message);
  const words = new DataView(padded.buffer);
  let swapSum = 0, lastSwap = 0, mix = 0, mixSum = 0;
  for (let off = 0; off < padded.length; off += 8) {
    const first = words.getUint32(off, true);
    const second = words.getUint32(off + 4, true);
    const firstSwap = swapTerm(first, firstKey, SWAP_FIRST);
    lastSwap = swapTerm(second, secondKey, SWAP_SECOND);
    swapSum = (swapSum + firstSwap + lastSwap) >>> 0;
    mix = swapAndMultiply(Math.imul(mix + first, firstKey), MIX_FIRST);
    mixSum = (mixSum + mix) >>> 0;
    mix = swapAndMultiply(Math.imul(mix + second, secondKey), MIX_SECOND);
    mixSum = (mixSum + mix) >>> 0;
  }
  const out = new Uint8Array(8);
  const view = new DataView(out.buffer);
  view.setUint32(0, lastSwap ^ mix, true);
  view.setUint32(4, swapSum ^ mixSum, true);
  return out;
}

export async function secMsGec(unix = Math.floor(Date.now() / 1000)) {
  const floored = unix - (unix % 300);
  const ticks = (floored + 11644473600) * 10_000_000;
  const message = new TextEncoder().encode(`${EDGE_COPYRIGHT}${BigInt(ticks)}${TRUSTED_CLIENT_TOKEN}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", message));
  return `${upperHex(cs64(message, digest))}-${upperHex(digest)}`;
}

const muid = () => upperHex(crypto.getRandomValues(new Uint8Array(16)));

const escapeXml = (s) =>
  s.replace(/[&<>'"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&apos;", '"': "&quot;" }[c]),
  );

function ssml(text, voice, lang) {
  return (
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${lang}'>` +
    `<voice name='${voice}'>${escapeXml(text)}</voice></speak>`
  );
}

// The service reports each sentence it speaks as an audio.metadata text frame:
// Offset/Duration in 100 ns ticks from the start of the audio.
export function parseSentenceBoundaries(frame) {
  const body = frame.slice(frame.indexOf("\r\n\r\n") + 4);
  let meta;
  try { meta = JSON.parse(body).Metadata; } catch { return []; }
  const out = [];
  for (const m of Array.isArray(meta) ? meta : []) {
    if (m?.Type !== "SentenceBoundary") continue;
    const d = m.Data ?? {};
    out.push({
      t0: Math.round(Number(d.Offset) / 1e4), // ms
      t1: Math.round((Number(d.Offset) + Number(d.Duration)) / 1e4),
      text: String(d.text?.Text ?? ""),
    });
  }
  return out;
}

// text → { audio: Uint8Array of MP3 bytes, sentences: [{ t0, t1, text }] }
export async function edgeSynthesize(text, voice = "zh-CN-XiaoxiaoNeural") {
  const lang = voice.split("-").slice(0, 2).join("-");
  const connectionId = crypto.randomUUID().replaceAll("-", "");
  const url =
    `https://${WSS_HOST}${WSS_PATH}` +
    `?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
    `&Sec-MS-GEC=${await secMsGec()}` +
    `&Sec-MS-GEC-Version=2-${CHROMIUM_FULL}` +
    `&ConnectionId=${connectionId}`;

  const resp = await fetch(url, {
    headers: {
      Upgrade: "websocket",
      Pragma: "no-cache",
      "Cache-Control": "no-cache",
      Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
      "Accept-Language": "en-US,en;q=0.9",
      Cookie: `muid=${muid()};`,
      "User-Agent":
        `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ` +
        `(KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR}.0.0.0 Safari/537.36 ` +
        `Edg/${CHROMIUM_MAJOR}.0.0.0`,
    },
  });
  const ws = resp.webSocket;
  if (!ws) throw new Error(`edge-tts upgrade failed: HTTP ${resp.status}`);
  ws.accept();

  const ts = new Date().toString();
  ws.send(
    `X-Timestamp:${ts}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
    `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"true","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}`,
  );
  ws.send(
    `X-RequestId:${connectionId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${ts}\r\nPath:ssml\r\n\r\n` +
    ssml(text, voice, lang),
  );

  const parts = []; // Promise<Uint8Array|null> per binary frame
  const sentences = [];
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("edge-tts timed out"));
    }, SYNTH_TIMEOUT_MS);
    const fail = (err) => { clearTimeout(timer); reject(err); };

    ws.addEventListener("message", (ev) => {
      if (typeof ev.data === "string") {
        if (ev.data.includes("Path:audio.metadata")) sentences.push(...parseSentenceBoundaries(ev.data));
        if (!ev.data.includes("Path:turn.end")) return; // turn.start / response / audio.metadata
        clearTimeout(timer);
        ws.close();
        // binary frames may still be draining (workerd delivers Blobs) —
        // settle them all before concatenating
        Promise.all(parts).then((frames) => {
          const audio = frames.filter(Boolean);
          if (!audio.length) return reject(new Error("edge-tts returned no audio"));
          const out = new Uint8Array(audio.reduce((n, p) => n + p.length, 0));
          let off = 0;
          for (const p of audio) { out.set(p, off); off += p.length; }
          resolve({ audio: out, sentences });
        }, fail);
        return;
      }
      // binary frame (ArrayBuffer or Blob depending on runtime):
      // 2-byte big-endian header length, then header, then audio payload
      const ab = ev.data instanceof ArrayBuffer ? Promise.resolve(ev.data) : ev.data.arrayBuffer();
      parts.push(
        ab.then((raw) => {
          const buf = new Uint8Array(raw);
          const headerLen = (buf[0] << 8) | buf[1];
          const header = new TextDecoder().decode(buf.subarray(2, 2 + headerLen));
          return header.includes("Path:audio") ? buf.subarray(2 + headerLen) : null;
        }),
      );
    });
    ws.addEventListener("error", () => fail(new Error("edge-tts socket error")));
    ws.addEventListener("close", (ev) => {
      // resolves above on turn.end; a close before that is a failure
      fail(new Error(`edge-tts closed early (${ev.code})`));
    });
  });
}
