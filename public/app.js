"use strict";

// ---------- tiny DOM helpers ----------

const $ = (sel, root = document) => root.querySelector(sel);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat(2)) {
    if (c === null || c === undefined) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

// stamped by deploy.sh at deploy time; "dev" means an unstamped local build.
// Lives inside app.js so it always names the shell actually running, even
// when the service worker served a cached copy.
const BUILD = "dev";

// ---------- the network cap ----------
//
// A dying cellular connection does not FAIL fetches, it hangs them for 60+ s.
// Every boot-path request that has something local to fall back on is capped
// here instead of waiting that out: past the cap the local copy wins and the
// next flush (or the next boot) reconciles. That is what "the app takes
// forever to open on bad signal" actually is — not a slow answer, but a
// question nobody was ever going to answer.
//
// The rule for using it: cap a request only when losing it costs nothing.
// A request with no local fallback (a book never cached, a shelf never seen)
// is deliberately left uncapped — there the network is the only answer, and
// cutting it short turns merely slow into broken. The service worker draws
// the same line with the same number (NET_MS in sw.js).
const NET_MS = 1000;
const capped = (ms = NET_MS) => ({ signal: AbortSignal.timeout(ms) });

// ---------- settings (font size / theme / paper color, per device) ----------

// paper colors: the [data-bg] values, in cycle order; "" is the theme
// default. Display names live in i18n.js under "bg.<value>".
const BACKGROUNDS = [
  "", "light-brown", "mid-brown", "gold-brown", "dark-brown", "snow-white",
  "pink", "light-orange", "light-yellow", "light-green", "light-cyan",
  "light-blue", "light-purple", "magenta",
];

// factory defaults: light theme, 金褐 paper (sampled off the user's preferred
// reader screenshot, #e0cb97) — a value the user ever set on this
// device (even back to these) always wins; null means untouched
const DEFAULTS = { theme: "light", bg: "gold-brown", size: 22, leading: 4 / 3, width: 38 };

// line length choices, in em (about characters per line for CJK)
const WIDTHS = [28, 34, 38, 46, 56];

// line spacing = 行距 ÷ 字號, cycled by the ↕ button. 4/3 is the pre-existing
// look (字級 = pitch × ¾), so the first step is the unchanged default.
const LEADINGS = [1.2, 4 / 3, 1.5, 1.7, 1.9, 2.1];

// bg and leading sync to the server (settingsChanged marks + schedules the
// push); theme and size deliberately stay per-device
const settings = {
  // Text size in CSS pixels. Per-device like theme: a phone and a desktop want
  // different sizes for the same text, so syncing it would make one of them wrong.
  get size() {
    const v = Number(localStorage.getItem("dogear_size"));
    return v >= 12 && v <= 60 ? v : DEFAULTS.size;
  },
  set size(v) {
    localStorage.setItem("dogear_size", String(Math.min(60, Math.max(12, Math.round(v)))));
    applySettings();
  },
  get leading() {
    const v = Number(localStorage.getItem("dogear_leading"));
    return v >= 1.1 && v <= 2.5 ? v : DEFAULTS.leading;
  },
  set leading(v) { localStorage.setItem("dogear_leading", String(v)); applySettings(); settingsChanged(); },
  // Line length in em. Per-device like size: it depends on the screen.
  get width() {
    const v = Number(localStorage.getItem("dogear_width"));
    return WIDTHS.includes(v) ? v : DEFAULTS.width;
  },
  set width(v) { localStorage.setItem("dogear_width", String(v)); applySettings(); },
  get theme() { return localStorage.getItem("dogear_theme") ?? DEFAULTS.theme; },
  set theme(v) { localStorage.setItem("dogear_theme", v); applySettings(); },
  get bg() { return localStorage.getItem("dogear_bg") ?? DEFAULTS.bg; },
  set bg(v) { localStorage.setItem("dogear_bg", v); applySettings(); settingsChanged(); },
};

// Screen Wake Lock (iOS 16.4+): keep the display on while reading. A
// per-device choice like theme — it is about THIS screen's battery. The
// system releases the lock whenever the app hides; the visibilitychange
// hook re-acquires on return.
let wakeLock = null;
const wakeOn = () => localStorage.getItem("dogear_wake") === "1";
async function applyWakeLock() {
  $("#wakeBtn")?.classList.toggle("active", wakeOn());
  const want = wakeOn() && document.visibilityState === "visible" && !!$("#content");
  if (want && !wakeLock && "wakeLock" in navigator) {
    try {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    } catch { /* denied (e.g. low-power mode) — retried on next visibility flip */ }
  } else if (!want && wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}
document.addEventListener("visibilitychange", applyWakeLock);
function toggleWake() {
  localStorage.setItem("dogear_wake", wakeOn() ? "0" : "1");
  applyWakeLock();
}

function applySettings() {
  const root = document.documentElement;
  root.dataset.theme = settings.theme;
  if (settings.bg) root.dataset.bg = settings.bg;
  else delete root.dataset.bg;
  applyGrid(); // the line size and height are derived from the settings
}

// A size or spacing change reflows the whole line grid, so without
// re-anchoring the same scroll position shows DIFFERENT text — the reader
// visually jumps, and the next scroll would save that drifted point as the
// bookmark. Land back on the tracked offset instead. The bookmark itself is a
// char offset — independent of size and spacing — so this only re-aims the
// view, never rewrites the record.
function reanchor() {
  if ($("#content p[data-off]")) restoreScroll(state.off);
}

// Everything this panel sets, back to the defaults — including what is kept
// only on this device (the engine, the speed, keep-awake). The synced ones go
// through their setters, so the server copy is overwritten too instead of
// bringing the old values back at the next open. Progress, bookmarks and
// downloaded data are not touched.
function resetSettings() {
  settings.theme = DEFAULTS.theme;
  settings.bg = DEFAULTS.bg;
  settings.size = DEFAULTS.size;
  settings.leading = DEFAULTS.leading;
  settings.width = DEFAULTS.width;
  for (const key of ["dogear_tts", "dogear_tts_rate", "dogear_wake"]) {
    try { localStorage.removeItem(key); } catch { /* private mode */ }
  }
  reanchor();
  applyWakeLock(); // the keep-awake preference just went back to off
  $("#settingsPanel")?.remove();
  toggleSettings(); // reopen, showing the defaults
}

// The progress line ("7/915 · 0.6%") toggles full screen. iPhone Safari has no
// Fullscreen API (only an installed home-screen app is full screen there), so
// the tap does nothing in that browser.
function toggleFullscreen() {
  if (document.fullscreenElement) return void document.exitFullscreen?.();
  document.documentElement.requestFullscreen?.()?.catch(() => { /* refused here */ });
}

// ---------- the reading-settings panel ----------
//
// Theme, paper colour, text size and line spacing are lists you pick from, not
// buttons that cycle: a cycle makes you press through the choices you do not
// want (light → dark → auto, where auto looks like light, took two presses to
// get back to light), and a button cannot say what it is set to.

// The sizes offered, in pixels; the stored value is always among them.
function sizeOptions() {
  const sizes = new Set([14, 16, 18, 20, 22, 24, 26, 28, 32, 36, 40, 44, settings.size]);
  return [...sizes].sort((a, b) => a - b).map((n) => [n, String(n)]);
}

function toggleSettings() {
  if ($("#settingsPanel")) return void $("#settingsPanel").remove();
  const select = (options, value, onChange) => {
    const s = el("select", { onchange: (e) => onChange(e.target.value) },
      options.map(([v, label]) => el("option", { value: String(v) }, label)));
    s.value = String(value);
    return s;
  };
  const row = (key, control) => el("label", { class: "set-row" }, el("span", {}, t(key)), control);
  const leading = LEADINGS.find((l) => Math.abs(l - settings.leading) < 0.01) ?? DEFAULTS.leading;
  const panel = el("div", { id: "settingsPanel", role: "dialog" },
    row("set.theme", select(
      [["auto", t("theme.auto")], ["light", t("theme.light")], ["dark", t("theme.dark")]],
      settings.theme, (v) => { settings.theme = v; })),
    row("set.bg", select(
      BACKGROUNDS.map((b) => [b, t("bg." + (b || "default"))]),
      settings.bg, (v) => { settings.bg = v; })),
    row("set.size", select(sizeOptions(), settings.size, (v) => { settings.size = Number(v); reanchor(); })),
    row("set.leading", select(
      LEADINGS.map((l) => [l, String(+l.toFixed(2))]),
      leading, (v) => { settings.leading = Number(v); reanchor(); })),
    row("set.width", select(
      WIDTHS.map((w) => [w, t("width." + w)]),
      settings.width, (v) => { settings.width = Number(v); reanchor(); })),
    el("div", { class: "set-links" },
      el("button", { class: "linklike", onclick: resetSettings }, t("set.reset")),
      // keyboard help is for a keyboard: not offered on a touch-only screen
      matchMedia("(pointer: fine)").matches
        ? el("button", { class: "linklike", onclick: toggleHelp }, t("set.keys")) : null));
  document.body.append(panel);
  // a press anywhere outside closes it
  const close = (e) => {
    if (panel.isConnected && e.target instanceof Element && e.target.closest("#settingsPanel, #settingsBtn")) return;
    panel.remove();
    removeEventListener("pointerdown", close, true);
  };
  addEventListener("pointerdown", close, true);
}

// ---------- line grid ----------
//
// The text size is a number of pixels, and the line height follows from it:
//
//     font  = the chosen size
//     pitch = font × leading                the line height, a whole number of px
//                                           (iOS snaps line advances to whole
//                                           pixels; a fractional pitch made
//                                           the lines drift)
//
// The document scrolls, freely. `band` is the document y of the first line
// at scroll 0 (#content's padding-top), which is where a restored position
// and the position tracker look.
const GRID = { pitch: 0, band: 0 };

function gridPitch() {
  // changing the leading moves the lines apart without resizing the text
  const font = settings.size;
  return { font, pitch: Math.max(8, Math.round(font * settings.leading)) };
}

function applyGrid() {
  const c = $("#content");
  if (!c) return;
  const { font, pitch } = gridPitch();
  GRID.pitch = pitch;
  GRID.band = parseFloat(getComputedStyle(c).paddingTop);
  c.style.maxWidth = settings.width + "em";
  c.style.fontSize = font.toFixed(2) + "px";
  c.style.lineHeight = pitch + "px";
  // paragraph gaps and the chapter head ride this, so every block's size
  // stays a whole number of lines
  c.style.setProperty("--pitch", pitch + "px");
}

const scrollEnd = () => Math.max(0, document.documentElement.scrollHeight - innerHeight);

// ---------- reader state ----------

const state = {
  slug: null,       // what the URL says — a label, and it can change
  id: null,         // what the book is stored and bookmarked under — it cannot
  uid: null,
  manifest: null,
  cum: [],          // cumulative chars up to and including chapter i
  idx: 0,
  off: 0,           // char offset within the current chapter file
  loading: true,    // chapter open in flight (or failed) — parks tap paging
  cache: new Map(), // chapter file -> text (converted, for a hans book)
  hant: null,       // OpenCC cn→tw when the open book is Simplified, else null
  dirty: false,
  lastSaved: null,
  syncTimer: 0,
};

let syncState = "ok"; // ok | pending | sending | err

// ---------- boot / routing ----------

applySettings();
console.log("dogear build " + BUILD); // visible on any route via remote inspector
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
// installed app: ask for durable storage up front — the shell + font caches
// deserve evict-last even before any offline book (the offline toggle also
// calls persistStorage, so browser-tab reading is covered there)
if (isStandalone()) persistStorage();
// re-assert this device's push subscription (see healPush): the refresh
// button and a reinstall both invalidate it behind the user's back
healPush();
// the app icon badge has two writers: the service worker when a 新書上架
// push lands, and checkVersion below while an update sits unapplied.
// Looking at the app is what marks a push read — including switching back
// to an app that was already open, which is how iOS multitasking usually
// goes; checkVersion re-asserts its dot right after this clear for as long
// as the update is still pending.
//
// Marking read takes CLOSING the notifications, not just clearing the
// badge. iOS keeps every shown notification in the SW registration's store
// even after the user sweeps the notification center clean (measured on
// the owner's phone: a swept tray still answered getNotifications with 6,
// unchanged ten minutes later), and setBadge in sw.js counts that store on
// the next push — uncounted ghosts would re-inflate the badge forever.
// close() is the one removal WebKit honors from us.
const clearBadge = () => navigator.clearAppBadge?.().catch(() => {});
const clearNews = async () => {
  clearBadge();
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    for (const n of (await reg?.getNotifications()) ?? []) n.close();
  } catch { /* no SW or no permission: nothing was ever shown to close */ }
};
clearNews();
addEventListener("visibilitychange", () => document.hidden || clearNews());
// a deploy while the app sits open on a phone: the shell is network-first,
// so the update is one reload away — this only makes its ARRIVAL visible.
// Checked on open and whenever the app comes back to the foreground (how
// an installed PWA mostly lives); answered with a dismissible note, never
// a forced reload — the reader may be mid-sentence.
checkVersion();
addEventListener("visibilitychange", () => document.hidden || checkVersion());

// ---------- static chrome (the markup lives in index.html) ----------

// zh ships in the markup; a device that picked English gets its sweep here,
// before boot()'s first paint lands in the microtask queue
applyI18n();

$("#staleRetry").onclick = () => renderLibrary();
// 版本紀錄: the update pill's notes vanish once the reload lands (a reader is
// never told about what they are already running), so the shelf keeps a door
// to the same ledger. Refetched on every open — the tap IS the refresh.
$("#relnotesBtn").onclick = () => {
  const panel = $("#relnotesPanel");
  panel.hidden = !panel.hidden;
  if (!panel.hidden) paintRelnotes(panel);
};
async function paintRelnotes(panel) {
  panel.replaceChildren(el("p", {}, t("lib.loading")));
  let releases = [];
  try {
    const res = await fetch("/releases.json", {
      cache: "no-store", signal: AbortSignal.timeout(4000),
    });
    if (res.ok) releases = (await res.json()).releases ?? [];
  } catch { /* offline or slow: the empty line below is the honest answer */ }
  // releases.json already holds only note-bearing releases, newest first —
  // one line per note, the (repeating) date kept quiet at the front
  panel.replaceChildren(releases.length
    ? el("ul", { class: "notelist" }, releases.flatMap((r) =>
        (r.notes ?? []).map((n) => el("li", {},
          el("span", { class: "muted" }, `${r.date ?? ""} `), n))))
    : el("p", {}, t("lib.relnotesNone")));
}
$("#changeKeyBtn").onclick = async () => {
  // switching identities means presenting a different KEY — an id is no
  // longer taken at a device's word. adoptKey does the settings-timestamp
  // handoff the old id prompt did here.
  const v = prompt(t("auth.changePrompt"));
  if (!v || !v.trim()) return;
  try {
    await adoptKey(extractKey(v));
    renderLibrary();
  } catch {
    alert(t("auth.bad"));
  }
};
$("#pushBtn").onclick = () => togglePush();
$("#pushTestBtn").onclick = () => testPush();
$("#refreshBtn").onclick = () => forceRefresh();
$("#uploadBtn").onclick = () => openUpload();
// the switch names the language you would GET, which is the one form a
// reader of either language can recognise without reading the other. A
// switch is a re-sweep plus a repaint of the JS-filled strings — never a
// refetch: the list on screen is already the list.
$("#langBtn").onclick = () => {
  setUiLang(otherUiLang());
  applyI18n();
  if (shelfPaint) paintShelf(...shelfPaint);
};
// a browser tab on a phone: the installed app is the product, so the way
// in stays one tap away (the guide auto-offers only once, at enrollment)
$("#installBtn").onclick = () => renderInstallGuide(renderLibrary);

boot();

// The route dispatch, async so enrolling (a /?key=… link) finishes before
// the first render — the very first paint must already belong to the right
// user. A declaration, not a const: this runs during script evaluation.
async function boot() {
  const enrolledNow = await swallowKey();
  const segs = location.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const wantShelf = new URLSearchParams(location.search).has("shelf");
  const dispatch = () => {
    // "/" is the installed app's start_url — what a phone reopens at — so it
    // continues the open book: everything it needs is already on the device,
    // where the shelf would ask the network first. /?shelf (the reader's
    // brand button, 回書架 on /admin) is the explicit way to the library, and
    // enrolling ends there too: a key link is device setup, not reading.
    if (segs.length === 0) {
      const last = enrolledNow || wantShelf ? null : lastBook();
      if (last) initReader(last);
      else renderLibrary();
    }
    else if (segs.length === 1) initReader(segs[0]);
    else renderMessage(t("err.badUrl"), [t("err.expected"), el("code", {}, "/<book>"), " — ", el("a", { href: "/?shelf" }, t("err.toLibrary"))]);
  };
  // Enrolling is the device-setup moment, so it is the one time the install
  // guide offers itself: iOS has no install-prompt API, and a guide shown
  // exactly when someone is setting a phone up is as automatic as 加入主畫面
  // ever gets. Once — the flag, not the guide, is what remembers.
  if (enrolledNow && installGuideDue()) return renderInstallGuide(dispatch);
  dispatch();
}

function isStandalone() {
  return matchMedia("(display-mode: standalone)").matches || Boolean(navigator.standalone);
}

// The screens are static sections in index.html; raising one lowers the
// rest. The reader is not a screen: buildReaderShell renders into
// #readerRoot and lowers them all (id = null). Raising a screen also
// clears the reader's DOM, so a failed initReader cannot leave a
// half-built shell behind the message it fails into.
function showScreen(id) {
  for (const s of document.querySelectorAll("#app > section")) s.hidden = s.id !== id;
  if (id) $("#readerRoot").replaceChildren();
}

// ---------- new-version notice ----------

// One build per session gets offered; dismissing it is answered, and a
// foreground flip must not re-raise the same note.
let versionNoticed = "";
let versionDismissed = "";
async function checkVersion() {
  try {
    const res = await fetch("/api/version", {
      cache: "no-store", signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return;
    const { build } = await res.json();
    // "dev" on either side means an unstamped local run — nothing to announce
    if (!build || build === "dev" || build === BUILD) return;
    // a pending update keeps a dot on the app icon: clearBadge just wiped
    // the icon on this same open/foreground event, and re-asserting here is
    // what lets the dot outlive a session that closed without reloading.
    // A dismissed note stays dismissed — ✕ means "seen it, not now" — and a
    // reload clears naturally: the fresh shell's build matches, so this
    // line is never reached again.
    if (build !== versionDismissed) navigator.setAppBadge?.(1).catch(() => {});
    if (build === versionNoticed) return;
    versionNoticed = build;
    showUpdateNotice(build, await releaseNotes());
  } catch { /* offline or slow: the next foreground flip asks again */ }
}

// What the releases since THIS shell say to a reader. Fetched only once an
// update is known to exist — which is rare — so it costs nothing on the
// foreground flips that find nothing.
//
// Every release the device skipped is included, not just the newest: a phone
// left alone for a month should hear about the whole month. Walking stops at
// this shell's own build, so a reader is never told about what they are
// already running. releases.json is a deploy product (gitignored, written by
// gen-release-notes.mjs) — a dev run has none, and a 404 means "no notes",
// which is also the honest answer for a release that said nothing.
async function releaseNotes() {
  try {
    const res = await fetch("/releases.json", {
      cache: "no-store", signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return [];
    const { releases } = await res.json();
    if (!Array.isArray(releases)) return [];
    const mine = BUILD.split(" ")[0]; // the stamp is "<short sha> · <when>"
    const out = [];
    for (const r of releases) {
      // the ledger keys on a longer sha than the build stamp carries
      if (mine && typeof r.build === "string" && r.build.startsWith(mine)) break;
      out.push(...(r.notes ?? []));
    }
    return out;
  } catch {
    return []; // slow or offline: the pill still works, it just says less
  }
}

function showUpdateNotice(build, notes = []) {
  document.querySelector(".updatenote")?.remove();
  // The pill is one nowrap row and the notes are prose, so the list rides a
  // line of its own (.notelist takes the full basis of a wrapping flex row) —
  // no second layout, no restructuring of the row. It starts collapsed because
  // "a new version is live" is the message; the notes are the follow-up.
  const list = notes.length
    ? el("ul", { class: "notelist", hidden: true }, notes.map((n) => el("li", {}, n)))
    : null;
  const note = el("div", { class: "jumpnote updatenote" },
    el("span", { class: "jumpnote-text" }, t("update.available", build)),
    list
      ? el("button", {
          id: "whatsNewBtn", // an id, not the label: the label is translated
          class: "linklike",
          onclick: (e) => {
            list.hidden = !list.hidden;
            e.target.textContent = list.hidden ? t("update.whatsNew") : t("update.hideNew");
          },
        }, t("update.whatsNew"))
      : null,
    el("button", {
      id: "updateReloadBtn",
      class: "linklike",
      // a plain reload is the whole upgrade: the service worker fetches the
      // shell network-first, so fresh bytes win whenever the network answers
      onclick: () => location.reload(),
    }, t("update.reload")),
    el("button", {
      class: "iconbtn", title: t("ui.close"),
      onclick: () => {
        // an answered note takes its badge with it, and stays answered for
        // this session's foreground flips
        versionDismissed = versionNoticed;
        navigator.clearAppBadge?.().catch(() => {});
        note.remove();
      },
    }, "✕"),
    list);
  document.body.append(note);
}

function installGuideDue() {
  try {
    return !isStandalone() && localStorage.getItem("dogear_install_seen") !== "1";
  } catch {
    return false; // private mode: a guide that would nag every open stays away
  }
}

// The way into the installed app, spelled out for the platform at hand.
// Also reachable any time from the library footer — isStandalone() cannot
// tell "not installed" from "installed but opened in a Safari tab", so the
// one-time auto-offer errs quiet and the footer link stays.
function renderInstallGuide(next) {
  try { localStorage.setItem("dogear_install_seen", "1"); } catch { /* private mode */ }
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.userAgent));
  $("#guideIos").hidden = !ios;
  $("#guideOther").hidden = ios;
  $("#guideContinue").onclick = next;
  showScreen("guideScreen");
}

// ---------- the reader key (the door) ----------
//
// Possession of a key is the identity: the server maps it to the reader id
// whose bookmarks and settings this device then lives under. The key rides
// as a server-set cookie (POST /api/auth), which is what lets <audio src>,
// sendBeacon and the service worker's fetches authenticate untouched; the
// copy in localStorage exists to re-earn that cookie when the browser
// evicts it, and to survive Safari's 7-day cookie caps.

// A /?key=… link is how a device is enrolled: trade the key for an
// identity, keep both, and scrub the key out of the address bar — it must
// not sit where a screenshot or a share sheet would leak it. A key that
// fails here (offline, revoked) is simply dropped: the 401 path asks again.
async function swallowKey() {
  const q = new URLSearchParams(location.search);
  const key = q.get("key");
  if (!key) return false;
  let adopted = false;
  try { await adoptKey(key); adopted = true; } catch { /* the gate will ask */ }
  q.delete("key");
  history.replaceState(null, "",
    location.pathname + (q.size ? "?" + q : "") + location.hash);
  return adopted;
}

// Validate a key against the server and become its user: the response sets
// the cookie, we keep the key and the id. A DIFFERENT id also orphans the
// local settings timestamp — zero it so this device adopts the new
// identity's synced settings instead of clobbering them (same rule the old
// URL-claiming flow had).
async function adoptKey(key) {
  const res = await fetch("/api/auth", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const { user } = await res.json();
  try {
    if (localStorage.getItem("dogear_uid") !== user)
      localStorage.setItem("dogear_settings_ts", "0");
    localStorage.setItem("dogear_key", key);
    localStorage.setItem("dogear_uid", user);
  } catch { /* private mode: this session only */ }
  reauthTried = false; // a fresh success re-arms the self-heal
  return user;
}

// People paste whatever they have — the full enroll link, its query, or the
// bare key — and an iPhone paste of a link (iMessage, Notes) can smuggle in
// invisible characters: bidi isolate marks, non-breaking spaces, a trailing
// 。 from the sentence around it. Those survive URL parsing and end up
// INSIDE the extracted key, which then 401s while looking perfectly right.
// The key and its link are plain visible ASCII, so keep only that, then
// hunt for key= rather than trusting the paste to parse as a URL.
function extractKey(s) {
  const raw = String(s).replace(/[^\x21-\x7E]/g, "");
  const m = raw.match(/key=([^&#?]+)/);
  const key = m ? m[1] : raw;
  try { return decodeURIComponent(key); } catch { return key; }
}

function getKey() {
  try { return localStorage.getItem("dogear_key"); } catch { return null; }
}

// A 401 with a stored key means the cookie is missing or evicted — re-post
// the key to repair it silently. Only one attempt until something succeeds
// again: a revoked key must fail into the gate, not into a request loop.
let reauthTried = false;
async function reauth() {
  const key = getKey();
  if (!key || reauthTried) return false;
  reauthTried = true;
  try { await adoptKey(key); return true; } catch { return false; }
}

// GET /api/auth: the cookie survived but localStorage did not — ask the
// server who this device is and re-seed the local id.
async function whoami() {
  try {
    const res = await fetch("/api/auth");
    if (!res.ok) return null;
    const { user } = await res.json();
    if (user) { try { localStorage.setItem("dogear_uid", user); } catch { /* private mode */ } }
    return user;
  } catch { return null; }
}

// The locked door: no valid key reached the server, so nothing beyond the
// shell can load. Reached only after reauth() failed — by then the stored
// key (if any) is genuinely dead, not merely a lost cookie.
function renderKeyGate(retry, failed = false) {
  document.title = "dogear";
  $("#gateLead").textContent = t(failed ? "auth.bad" : "auth.need");
  $("#keyInput").placeholder = t("auth.placeholder");
  $("#keyMsg").textContent = "";
  $("#keyForm").onsubmit = async (e) => {
    e.preventDefault();
    const raw = $("#keyInput").value;
    if (!raw.trim()) return;
    try {
      await adoptKey(extractKey(raw));
      retry();
    } catch {
      $("#keyMsg").textContent = t("auth.bad");
    }
  };
  showScreen("gateScreen");
}

function renderMessage(title, children = []) {
  $("#msgTitle").replaceChildren(title);
  // filter, because replaceChildren stringifies a bare null into "null"
  $("#msgBody").replaceChildren(...[children].flat().filter((c) => c != null));
  showScreen("msgScreen");
}

// The wordmark: .brand carries the app icon as a ::before (see app.css). It
// goes on the title passed IN rather than on renderMessage's own h1, because
// the same h1 also carries "chapter loading", "not found" and "offline" —
// headings that should not be branded.
//
// A declaration, not a const: the route dispatch at the top of this file runs
// during evaluation and reaches renderLibrary before this point, so an arrow
// bound to a const is still in its temporal dead zone when the first call
// lands.
function brand() {
  return el("span", { class: "brand" }, "dogear");
}

// ---------- library ----------

// The reader id is whatever /api/auth said this device's key maps to
// (adoptKey stores it). It used to be minted here and claimed off shared
// URLs — with keys there is nothing to mint: a device with no id simply is
// not enrolled yet, and callers treat null as exactly that.
function getUid() {
  try { return localStorage.getItem("dogear_uid"); } catch { return null; }
}

async function renderLibrary() {
  document.title = "dogear";
  let uid = getUid();
  // fire-and-forget: no settings UI here, so a late server-wins repaint is
  // purely cosmetic (paper color / theme vars on the library chrome)
  if (uid) resolveSettings(uid);
  // The last shelf this device saw paints NOW — device-first, the same rule
  // positions and settings follow — and the capped fetch below can only
  // improve on it: a fresh list, or a stale mark when nothing answers.
  // With nothing local to show, the network is the only answer: uncapped,
  // behind a loading line.
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem("dogear_books")); } catch { /* ignore */ }
  const haveCached = Array.isArray(cached);
  if (haveCached) paintShelf(cached, { uid, stale: false });
  else renderMessage(brand(), t("lib.loading"));
  let books;
  try {
    // the key cookie says who is asking; the server adds that reader's
    // per-book progress (the same chars-based pct as the reader's line).
    // 2.5 s, not NET_MS: this call costs sequential D1 round trips on the
    // server, and at the default cap a well-connected shelf lost the race
    // often enough to sit permanently marked 離線. The cached list is
    // already painted — the longer leash only delays the (cosmetic) stale
    // mark, never the shelf.
    // 20 s: a cold shelf costs several WebDAV round trips (~6 s on Koofr), and
    // a shorter cap marked a perfectly online device 離線. The cached shelf is
    // already on screen, so waiting longer costs nothing; only a real failure
    // or a very long hang shows the stale note.
    const res = await fetch("/api/books", haveCached ? capped(20_000) : undefined);
    if (res.status === 401) {
      if (await reauth()) return renderLibrary();
      return renderKeyGate(renderLibrary, !!getKey());
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    books = withRecentUploads((await res.json()).books);
    // the cookie knows who we are but localStorage forgot (a cleared site,
    // a new browser profile with the key re-entered elsewhere): recover it
    if (!uid) uid = await whoami();
    try {
      localStorage.setItem("dogear_books", JSON.stringify(books));
      // seed the slug → id map from the shelf, so opening a book for the
      // first time on an underground train still knows where to look
      for (const b of books) if (b.id) localStorage.setItem(`dogear_book_${b.slug}`, b.id);
    } catch { /* full */ }
  } catch (err) {
    // offline, capped, or a dead API: the painted cache stands, marked
    if (!haveCached) {
      return renderMessage(brand(), [
        t("lib.loadFail", err.message),
        el("button", { class: "linklike", onclick: renderLibrary }, t("lib.retry")),
      ]);
    }
    return paintShelf(cached, { uid, stale: true });
  }
  paintShelf(books, { uid, stale: false });
}

// ---------- upload a book ----------
//
// The browser does the slow parts: it reads the file, splits it into chapters,
// and PUTs them one request each (4 at a time) to /api/upload, the manifest
// LAST — until the manifest is there the shelf cannot see the book. A WebDAV
// write takes seconds, so a long book takes minutes and the page must stay
// open; that is said on screen and the browser asks before closing it.
// An interrupted upload leaves a folder with no manifest. The next upload
// first asks the server to clear such leftovers, and a failed run drops its
// own folder before starting over — clearing is simpler than resuming.

let uploading = false;
let pendingBook = null; // parsed, waiting for the reader to press start
let failedUploadId = null;

function openUpload() {
  showScreen("uploadScreen");
  pendingBook = null;
  $("#upFile").value = "";
  $("#upFile").disabled = false;
  $("#upForm").hidden = true;
  $("#upRun").hidden = true;
  $("#upMsg").textContent = "";
  $("#upBack").hidden = false;
  $("#upStart").textContent = t("up.start");
  $("#upReplaceRow").hidden = true;
  renderUpBooks();
}

// The books on the shelf, with a delete button each (from the shelf this device
// last saw). Deleting is two presses: the first asks, the second does it.
const knownBooks = () => {
  try { return JSON.parse(localStorage.getItem("dogear_books")) ?? []; } catch { return []; }
};

function renderUpBooks() {
  const books = knownBooks();
  $("#upBooks").replaceChildren(...books.map((b) => {
    const btn = el("button", { class: "linklike" }, t("up.delete"));
    let armed = 0;
    btn.onclick = async () => {
      if (!armed) {
        armed = setTimeout(() => { armed = 0; btn.textContent = t("up.delete"); }, 4000);
        btn.textContent = t("up.confirmDelete");
        return;
      }
      clearTimeout(armed);
      btn.disabled = true;
      btn.textContent = t("up.deleting");
      try {
        await deleteBookOnServer(b.id);
        $("#upMsg").textContent = "";
      } catch (err) {
        $("#upMsg").textContent = t("up.deleteFail", err.message);
      }
      renderUpBooks();
    };
    return el("li", {}, el("span", {}, `${b.title}　`), el("span", { class: "muted" }, t("up.chapters", b.chapters)), " ", btn);
  }));
}

async function deleteBookOnServer(id) {
  const res = await fetch(`/api/books/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  try {
    localStorage.setItem("dogear_books", JSON.stringify(knownBooks().filter((b) => b.id !== id)));
    localStorage.removeItem(`dogear_prog_${id}`);
    const recent = JSON.parse(localStorage.getItem("dogear_uploaded")) ?? [];
    localStorage.setItem("dogear_uploaded", JSON.stringify(recent.filter((b) => b.id !== id)));
  } catch { /* private mode or full: the next shelf load corrects it */ }
}

// "Replace which book?": the reader picks from the shelf, so a title that differs
// a little (a file renamed, a "(精校版)" suffix) can still replace its old
// version. The list starts on the book whose title matches best, so the usual
// case needs no choice; touching the list stops it following the title field.
let replaceTouched = false;

function fillReplaceOptions(title) {
  const books = knownBooks();
  const sel = $("#upReplace");
  sel.replaceChildren(
    el("option", { value: "" }, t("up.replaceNone")),
    ...books.map((b) => el("option", { value: b.id }, t("up.replaceOption", b.title, b.chapters))));
  const norm = (s) => s.replace(/[\s（）()【】[\]《》]/g, "").toLowerCase();
  const want = norm(title);
  const similar = (b) => {
    const have = norm(b.title);
    return want.length >= 2 && have.length >= 2 && (have.includes(want) || want.includes(have));
  };
  sel.value = (books.find((b) => norm(b.title) === want) ?? books.find(similar))?.id ?? "";
  $("#upReplaceRow").hidden = !books.length;
}

async function onUploadFile(e) {
  const file = e.target.files[0];
  if (!file || uploading) return;
  $("#upForm").hidden = true;
  $("#upMsg").textContent = t("up.parsing");
  try {
    const [{ parseBook }, { unzipSync }] = await Promise.all([
      import("/import-core.mjs"), import("/vendor/fflate.js"),
    ]);
    const book = parseBook({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()), unzipSync });
    if (!book.pieces.length) throw new Error(t("up.noChapters"));
    pendingBook = book;
    failedUploadId = null;
    $("#upTitle").value = book.title;
    $("#upAuthor").value = book.author ?? "";
    const chars = book.pieces.reduce((n, p) => n + p.body.length, 0);
    $("#upSummary").textContent = [
      t("up.summary", book.pieces.length, chars),
      book.headingCount < 3 ? t("up.noHeadings") : "",
    ].filter(Boolean).join(" ");
    replaceTouched = false;
    fillReplaceOptions(book.title);
    $("#upMsg").textContent = "";
    $("#upForm").hidden = false;
  } catch (err) {
    $("#upMsg").textContent = t("up.parseFail", err.message);
  }
}

// A server on another isolate may still serve a shelf from before the upload
// (a 20 s cache), which would make a just-finished book vanish. Keep it for 2 minutes.
function withRecentUploads(books) {
  let recent = [];
  try { recent = JSON.parse(localStorage.getItem("dogear_uploaded")) ?? []; } catch { /* ignore */ }
  recent = recent.filter((b) => Date.now() - b.at < 120_000);
  try { localStorage.setItem("dogear_uploaded", JSON.stringify(recent)); } catch { /* full */ }
  return [...books, ...recent.filter((r) => !books.some((b) => b.id === r.id)).map(({ at, ...b }) => b)];
}

// one PUT, retried on a network error, 429 or 5xx
async function upPut(url, body, type) {
  let lastErr = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
    try {
      const res = await fetch(url, { method: "PUT", headers: { "content-type": type }, body });
      if (res.ok) return;
      lastErr = `HTTP ${res.status}`;
      if (res.status < 500 && res.status !== 429) break; // a client error will not fix itself
    } catch (err) {
      lastErr = err?.message ?? String(err);
    }
  }
  throw new Error(lastErr);
}

const warnLeave = (e) => { e.preventDefault(); e.returnValue = ""; };

async function startUpload() {
  if (uploading || !pendingBook) return;
  uploading = true;
  const book = pendingBook;
  const title = $("#upTitle").value.trim() || book.title;
  const author = $("#upAuthor").value.trim();
  $("#upFile").disabled = true;
  $("#upForm").hidden = true;
  $("#upBack").hidden = true;
  $("#upMsg").textContent = "";
  $("#upMsg").classList.remove("updone");
  $("#upRun").hidden = false;
  $("#upFill").style.width = "0%";
  $("#upStatus").textContent = t("up.preparing");
  addEventListener("beforeunload", warnLeave);
  let wake = null;
  try { wake = await navigator.wakeLock?.request("screen"); } catch { /* denied: the warning still stands */ }
  try {
    if (failedUploadId) {
      await fetch(`/api/upload/${failedUploadId}`, { method: "DELETE" }).catch(() => {});
      failedUploadId = null;
    }
    await fetch("/api/upload-cleanup", { method: "POST" }).catch(() => {}); // best effort
    const { piecesToEntries, buildManifest, newBookId, shortSlug } = await import("/split-core.mjs");
    const entries = piecesToEntries(book.pieces);
    const known = knownBooks();
    // Replacing: the old versions go only AFTER the new one is complete, and the
    // new one takes over their address (slug), so a link to the book keeps working.
    const replaceIds = !$("#upReplaceRow").hidden && $("#upReplace").value ? [$("#upReplace").value] : [];
    const id = newBookId();
    failedUploadId = id; // cleared again on success
    const manifest = {
      ...buildManifest({
        id, title, entries,
        slug: shortSlug(title, known.filter((b) => !replaceIds.includes(b.id)).map((b) => b.slug)),
      }),
      ...(author ? { author } : {}),
    };
    const put = (file, body, type) => upPut(`/api/upload/${id}/${encodeURIComponent(file)}`, body, type);

    const t0 = Date.now();
    let done = 0;
    const report = () => {
      $("#upFill").style.width = `${(done / entries.length) * 100}%`;
      const mins = done >= 5 ? Math.ceil(((entries.length - done) * (Date.now() - t0)) / done / 60000) : null;
      $("#upStatus").textContent =
        t("up.progress", done, entries.length) + (mins === null ? "" : ` · ${t("up.eta", mins)}`);
    };
    // the first file alone: it creates the folders, which parallel requests would race to create
    await put(entries[0].file, entries[0].body, "text/plain; charset=utf-8");
    done = 1;
    report();
    let next = 1;
    let error = null;
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (!error && next < entries.length) {
        const e = entries[next++];
        try {
          await put(e.file, e.body, "text/plain; charset=utf-8");
          done++;
          report();
        } catch (err) {
          error ??= err;
        }
      }
    }));
    if (error) throw error;
    await put("manifest.json", JSON.stringify(manifest), "application/json");

    // show the book on the shelf at once instead of waiting for the next list
    const added = {
      id, slug: manifest.slug, title, ...(author ? { author } : {}),
      chapters: entries.length, totalChars: manifest.totalChars,
    };
    let replaceError = "";
    for (const oldId of replaceIds) {
      try { await deleteBookOnServer(oldId); } catch (err) { replaceError = err.message; }
    }
    try {
      localStorage.setItem("dogear_books", JSON.stringify([...knownBooks(), added]));
      localStorage.setItem(`dogear_book_${manifest.slug}`, id);
      localStorage.setItem("dogear_uploaded", JSON.stringify([{ ...added, at: Date.now() }]));
    } catch { /* full */ }
    failedUploadId = null;
    pendingBook = null;
    // finished: the "do not leave" warning and the bar go away, so the only
    // thing left on screen says it is done
    $("#upRun").hidden = true;
    $("#upMsg").classList.add("updone");
    $("#upMsg").textContent = t("up.done", title) + (replaceError ? ` ${t("up.replaceFail", replaceError)}` : "");
    renderUpBooks();
  } catch (err) {
    $("#upRun").hidden = true;
    $("#upForm").hidden = false;
    $("#upStart").textContent = t("up.retry");
    $("#upMsg").textContent = t("up.fail", err.message);
  } finally {
    uploading = false;
    removeEventListener("beforeunload", warnLeave);
    wake?.release().catch(() => {});
    $("#upBack").hidden = false;
    $("#upFile").disabled = false;
  }
}

$("#upFile").onchange = onUploadFile;
$("#upReplace").onchange = () => { replaceTouched = true; };
$("#upTitle").oninput = () => { if (!replaceTouched) fillReplaceOptions($("#upTitle").value); };
$("#upStart").onclick = () => startUpload();
$("#upBack").onclick = () => { if (!uploading) renderLibrary(); };

// What paintShelf last drew, so the language switch can re-render the
// JS-filled strings without asking the network for the same list again.
let shelfPaint = null;

// The server's progress lags what this device just read by the sync delay (a
// 10 s timer plus a slow WebDAV write), so for each book the newer of the two
// wins. Another device's later reading still beats ours: its updatedAt is newer.
function overlayLocalProgress(books) {
  return books.map((b) => {
    let local = null;
    try { local = JSON.parse(localStorage.getItem(`dogear_prog_${b.id}`)); } catch { /* ignore */ }
    if (!local || !(local.at > (b.progress?.updatedAt ?? 0))) return b;
    return { ...b, progress: { chapter: local.chapter, pct: local.pct, updatedAt: local.at } };
  });
}

function paintShelf(books, opts) {
  books = overlayLocalProgress(books);
  shelfPaint = [books, opts];
  showScreen("shelfScreen");
  $("#staleNote").hidden = !opts.stale;
  $("#emptyNote").hidden = books.length > 0;
  // 續讀: the device's open book leads — the same book bare "/" resumes
  const heroBook = books.find((b) => b.slug === lastBook()) ?? null;
  paintHero(heroBook);
  $("#bookList").replaceChildren(...books.filter((b) => b !== heroBook).map(shelfRow));
  $("#uidCode").textContent = opts.uid ?? "—";
  $("#buildLine").textContent = t("lib.build", BUILD);
  // the push row exists only where the platform can deliver — on iPhone
  // that means the installed PWA; a Safari tab has no PushManager
  $("#pushRow").hidden = !("PushManager" in window && "Notification" in window);
  $("#installWrap").hidden = isStandalone();
  refreshPushBtn();
  applyWakeLock(); // leaving the reader releases the screen hold
}

function paintHero(b) {
  const row = $("#heroRow");
  row.hidden = !b;
  if (!b) return;
  row.dataset.slug = b.slug;
  $("#heroLink").href = `/${encodeURIComponent(b.slug)}`;
  coverInto($("#heroCover"), b, false);
  $("#heroTitle").textContent = b.title;
  $("#heroWhere").textContent =
    b.progress ? t("lib.chapterN", b.progress.chapter + 1) : t("lib.notStarted");
  const pct = b.progress ? Math.round(b.progress.pct) : 0;
  $("#heroFill").style.width = `${pct}%`;
  $("#heroPct").textContent = `${pct}%`;
  const dl = $("#heroOffline");
  dl.hidden = !("caches" in window);
  dl.onclick = () => toggleShelfOffline(dl, b);
  paintShelfOffline(dl, b);
}

// 書衣: the cloth tone is keyed on the permanent id, so a re-slug keeps its
// cover; a real cover image (books/<id>/cover.jpg — the agent-enrichment
// slot, see DESIGN.md) paints over the cloth when the book has one, and the
// <img>'s error handler removes it, so the cloth is also what offline and
// cover-less books wear.
function clothTone(id) {
  let h = 0;
  for (const c of String(id)) h = (h + c.charCodeAt(0)) % 4;
  return h;
}

function coverInto(node, b, withTab) {
  const id = b.id ?? b.slug;
  node.className = `cover cloth-${clothTone(id)}`;
  // filter, because replaceChildren stringifies a bare null into "null"
  node.replaceChildren(...[
    // the 題簽 carries the title and, when the enrichment sidecar named one,
    // the author in smaller 落款 characters on their own column
    el("span", { class: "slip" }, b.title,
      b.author ? el("span", { class: "slip-author" }, b.author) : null),
    withTab && b.progress ? el("span", { class: "tab" }) : null,
    el("img", {
      class: "coverimg", alt: "", loading: "lazy",
      src: assetUrl(id, "cover.jpg"),
      onerror: (e) => e.target.remove(),
    }),
  ].filter(Boolean));
  return node;
}

function shelfRow(b) {
  const pct = b.progress ? Math.round(b.progress.pct) : null;
  // the ⇣ is a sibling of the card, not a child: a <button> inside an <a>
  // is invalid HTML, and tapping it would open the book
  return el("div", { class: "book-row", "data-slug": b.slug },
    el("a", { class: "book-card", href: `/${encodeURIComponent(b.slug)}` },
      coverInto(el("div"), b, true),
      el("div", { class: "grid-meta" },
        t("lib.meta", b.chapters, b.totalChars), " · ",
        pct === null ? t("lib.notStarted") : el("span", { class: "acc" }, t("lib.readPct", pct)),
        // an online book reads from its site: chapter and 字數 are the site's
        // list and an estimate until the chapters have been opened
        b.source ? [" · ", el("span", { class: "muted" }, t("lib.online"))] : null)),
    "caches" in window ? shelfOfflineBtn(b) : null);
}

// ---------- the ⇣ on a book card ----------

// The ring lights when the book was explicitly saved AND this device actually
// holds chapters — the flag alone would claim "saved" over an empty cache
// (say, a fill that failed offline), and held-but-implicit is just the
// reader's safety net, not something the user asked for. A tap on an unlit
// ring saves the full window; on a lit one, removes the book. Same rule as
// the reader's ⇣.
function shelfOfflineBtn(book) {
  const btn = el("button", {
    class: "iconbtn shelf-offline",
    onclick: () => toggleShelfOffline(btn, book),
  }, "⇣");
  paintShelfOffline(btn, book);
  return btn;
}

// Saving from the shelf fills the same ±window the reader keeps, centred on
// wherever the server says this reader is: what you want on the way into the
// tunnel is the chapters you are about to read, not chapter one.
async function toggleShelfOffline(btn, book) {
  const id = book.id ?? book.slug;
  if (btn.classList.contains("busy")) return;
  if (offlineExplicit(id) && await cachedChapters(id) > 0) {
    setOffline(id, false);
    await caches.delete(bookCacheName(id));
    return paintShelfOffline(btn, book);
  }
  setOffline(id, true);
  persistStorage();
  btn.classList.add("busy");
  try {
    const res = await fetch(assetUrl(id, "manifest.json"));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await fillOfflineWindow(id, await res.json(), book.progress?.chapter ?? 0);
  } catch {
    // The flag stays on, so opening the book online later still fills it.
    // Said out loud rather than left in a title: this is a phone, and nothing
    // there ever hovers.
    alert(t("lib.offlineFail"));
  } finally {
    btn.classList.remove("busy");
  }
  return paintShelfOffline(btn, book);
}

async function paintShelfOffline(btn, book) {
  const id = book.id ?? book.slug;
  const n = await cachedChapters(id);
  const saved = offlineExplicit(id) && n > 0;
  btn.classList.toggle("active", saved);
  btn.title = saved ? t("lib.offlineSaved", n) : t("lib.offlineSave");
}

// ---------- 新書通知 (Web Push) ----------

async function refreshPushBtn() {
  const btn = $("#pushBtn");
  if (!btn) return;
  if (Notification.permission === "denied") {
    btn.textContent = t("push.blocked");
    btn.disabled = true;
    return;
  }
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    btn.textContent = t(sub ? "push.subscribed" : "push.subscribe");
    $("#pushTestWrap")?.toggleAttribute("hidden", !sub);
  } catch {
    btn.textContent = t("push.subscribe");
  }
}

// 測試: push one notification to THIS device and say what the push service
// answered. "已訂閱" is only the phone's own opinion — it stays true even if
// the row never reached the server, and it says nothing about whether Apple
// accepted the message. Three outcomes, three different fixes:
//   伺服器沒有這個訂閱 → the subscribe POST never landed; re-subscribe
//   已送出 201 but no banner → iOS side (通知設定 / 專注模式), not the app
//   其他狀態 → the push service rejected us; the detail says why
async function testPush() {
  const btn = $("#pushTestBtn");
  if (!btn) return;
  btn.textContent = t("push.sending");
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    // the phone's own account of itself goes to the log FIRST: if the push
    // never lands, this is the half of the story the server cannot see.
    // The testlog stays zh-TW whatever the UI language — it is an operator
    // channel, read next to the worker's own 中文 lines.
    pageLog("測試前 " + await phoneState());
    if (!sub) { btn.textContent = t("push.notSubscribed"); return refreshPushBtn(); }
    const res = await fetch("/api/push/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    });
    const j = await res.json().catch(() => ({}));
    btn.textContent = res.status === 404
      ? t("push.noRow")
      : j.ok
        ? t("push.sent", j.status)
        : t("push.rejected", j.status ?? res.status, j.detail ?? "");
  } catch (err) {
    btn.textContent = t("push.fail", err?.message ?? err);
  }
}

async function togglePush() {
  const btn = $("#pushBtn");
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) throw new Error(t("push.noSW"));
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await sub.unsubscribe().catch(() => {});
      fetch("/api/push/unsubscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ endpoint: sub.endpoint }),
      }).catch(() => {});
    } else {
      // permission must be requested inside the tap gesture (iOS)
      if (await Notification.requestPermission() !== "granted") return refreshPushBtn();
      const { key } = await (await fetch("/api/push/vapid")).json();
      if (!key) throw new Error(t("push.noVapid"));
      const ns = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: b64uDecode(key),
      });
      const j = ns.toJSON();
      const res = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          user: getUid() ?? "", endpoint: j.endpoint,
          p256dh: j.keys.p256dh, auth: j.keys.auth,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    }
  } catch (err) {
    if (btn) btn.textContent = t("push.fail", err?.message ?? err);
    return;
  }
  refreshPushBtn();
}

// Re-register this device's subscription on every app open. Two things
// silently break the pairing between phone and server, and neither is
// visible from either side:
//   · unregistering the service worker (the refresh button!) destroys the
//     push subscription — the server row survives and the push service can
//     keep answering 201 for a dead endpoint
//   · a reinstalled PWA, or an iOS-rotated subscription, changes the
//     endpoint and leaves the old row behind
// getSubscription() is authoritative for the device, and /subscribe is an
// upsert, so re-POSTing it makes the row true again for free. Stale rows
// age out the moment the push service reports them gone.
async function healPush() {
  if (!("PushManager" in window) || !("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    const revived = !sub;
    if (!sub) {
      const { key } = await (await fetch("/api/push/vapid")).json();
      if (!key) return;
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true, applicationServerKey: b64uDecode(key),
      });
    }
    const j = sub.toJSON();
    await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        user: getUid() ?? "", endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth,
      }),
    });
    if (revived) pageLog("訂閱已失效，已重新建立 …" + j.endpoint.slice(-12));
    refreshPushBtn();
  } catch (err) {
    pageLog("healPush 失敗：" + (err?.message ?? err));
  }
}

// A line in the same testlog the worker and the service worker write to, so
// one /api/testlog?page=push read shows the whole chain: worker → push
// service status → service worker → notification shown. Only writes when
// something push-related actually happens (a 測試 tap, a repaired
// subscription) — no per-launch noise. This is why the testlog table
// outlives the temporary diagnostic pages that introduced it.
function pageLog(data) {
  fetch("/api/testlog", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ page: "push", device: "page", data: String(data).slice(0, 4000) }),
  }).catch(() => {});
}

// what the phone believes, in one line: which service worker is in charge
// (no answer = a stale one without the message handler), permission, and
// whether this is the installed app — the facts that decide where a 201
// with no banner went
async function phoneState() {
  const bits = [];
  bits.push(matchMedia("(display-mode: standalone)").matches || navigator.standalone
    ? "standalone" : "browser 分頁");
  bits.push("permission " + Notification.permission);
  const ctrl = navigator.serviceWorker?.controller;
  bits.push("controller " + (ctrl ? new URL(ctrl.scriptURL).pathname : "無"));
  const v = await new Promise((resolve) => {
    if (!ctrl) return resolve("無");
    const ch = new MessageChannel();
    ch.port1.onmessage = (e) => resolve(e.data?.sw ?? "?");
    setTimeout(() => resolve("沒回應（舊版 sw）"), 1500);
    try { ctrl.postMessage("version", [ch.port2]); } catch { resolve("postMessage 失敗"); }
  });
  bits.push("sw " + v);
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    bits.push("subscription " + (sub ? "…" + sub.endpoint.slice(-12) : "無"));
  } catch (err) { bits.push("subscription 讀取失敗 " + (err?.message ?? err)); }
  return bits.join("；");
}

function b64uDecode(s) {
  return Uint8Array.from(
    atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")),
    (c) => c.charCodeAt(0));
}

// Force-refresh: drop the app-shell caches and the service worker, then
// reload from the network — the iPhone-friendly hard reload. Per-book
// offline chapter caches (dogear-book-*) are deliberately kept.
async function forceRefresh() {
  if (navigator.onLine === false && !confirm(t("lib.refreshOffline"))) return;
  try {
    // unregistering the service worker DESTROYS this device's push
    // subscription, and the push service can go on accepting messages for
    // the dead endpoint — so retire the row on the way out. healPush()
    // creates a fresh one on the next load.
    const reg0 = await navigator.serviceWorker?.getRegistration();
    const sub = await reg0?.pushManager.getSubscription();
    if (sub) {
      await fetch("/api/push/unsubscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ endpoint: sub.endpoint }),
      }).catch(() => {});
      await sub.unsubscribe().catch(() => {});
    }
  } catch { /* refreshing matters more */ }
  try {
    const regs = await navigator.serviceWorker?.getRegistrations() ?? [];
    await Promise.all(regs.map((r) => r.unregister()));
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith("dogear-shell-")).map((k) => caches.delete(k)));
    }
  } catch { /* reload anyway */ }
  // back to the shelf (the refresh lives there); r= busts intermediary HTML caches
  location.replace("/?shelf&r=" + Date.now());
}

// ---------- reader ----------

function bookUrl(file) {
  return assetUrl(state.id, file, state.manifest?.generatedAt);
}

// The same URL for a book that is NOT the one open in the reader — the shelf
// caches books it has never opened, so the id and the manifest generation
// have to be passed in rather than read off `state`.
function assetUrl(id, file, v) {
  const url = `/books/${encodeURIComponent(id)}/${encodeURIComponent(file)}`;
  // version chapter URLs by manifest generation: chapters get a month-long
  // immutable cache-control, and this busts them when a book is republished
  return file.endsWith(".txt") && v ? `${url}?v=${encodeURIComponent(v)}` : url;
}

function posKey() {
  return `dogear_pos_${state.id}_${state.uid}`;
}

// slug (from the URL) → the id the book is stored under. Books published
// before ids existed have id === their original slug, which is also the
// fallback here: it is what makes an offline first open, a server that has
// not been reindexed, and a stale link all degrade to "try the obvious key"
// instead of an error page.
async function resolveBookId(slug, mustAnswer = false) {
  try {
    // capped: the fallback below is a pure guess the device can make on its
    // own, so a hung lookup is never worth waiting for — unless the server has
    // just said the remembered book is gone, when it is the only way to find
    // the book that took its place (mustAnswer)
    const res = await fetch(`/api/books/${encodeURIComponent(slug)}`, mustAnswer ? undefined : capped());
    if (res.ok) {
      const book = (await res.json()).book;
      if (book?.id) {
        try { localStorage.setItem(`dogear_book_${slug}`, book.id); } catch { /* full */ }
        return book.id;
      }
    }
  } catch { /* offline */ }
  return cachedBookId(slug) ?? slug;
}

// Everything this device keeps for a book that no longer exists on the server.
function forgetBook(id) {
  caches?.delete?.(`dogear-book-${id}`);
  try {
    localStorage.removeItem(`dogear_prog_${id}`);
    // the position is kept per book and per reader: dogear_pos_<id>_<reader>
    for (const key of Object.keys(localStorage))
      if (key.startsWith(`dogear_pos_${id}_`)) localStorage.removeItem(key);
  } catch { /* private mode */ }
}

// The book was opened from this device's copy because the server did not answer
// in time (it is slow to wake, and a copy is what makes opening instant). Ask
// again without a cap, past the service worker's own cached answer: if the
// server says the book is gone — deleted, or replaced by a new upload with the
// same address — drop what is remembered and reopen, which finds the new one.
function checkBookStillThere() {
  const id = state.id;
  fetch(`/books/${encodeURIComponent(id)}/manifest.json?live=1`)
    .then((res) => {
      if (res.status !== 404 || state.id !== id) return;
      forgetBook(id);
      try { localStorage.removeItem(`dogear_book_${state.slug}`); } catch { /* private mode */ }
      location.reload();
    })
    .catch(() => { /* offline, or unreachable: keep reading the copy */ });
}

// What this device last knew this slug to mean. renderLibrary seeds it for
// every book on the shelf, so opening one costs no extra round trip.
function cachedBookId(slug) {
  try {
    return localStorage.getItem(`dogear_book_${slug}`);
  } catch {
    return null; // private mode
  }
}

// The slug the reader last actually showed — what "/" resumes. Written only
// after a manifest loads, so a typo'd URL can never become the book every
// reopen runs into. The slug→id map (dogear_book_<slug>) survives alongside it,
// which is what keeps the resume working offline and across a rename.
function lastBook() {
  try { return localStorage.getItem("dogear_last_book"); } catch { return null; }
}

async function initReader(slug) {
  state.slug = slug;
  state.uid = getUid() ?? "";
  renderMessage(t("reader.loading"));
  // 401 and "not there" must part ways: the first is a dead cookie or a
  // revoked key (the gate's business), the second a bad slug
  let denied = false;
  let gone = false; // the server said this id is not a book (deleted, or replaced)
  let fromCopy = false; // the manifest came from this device's copy, not the server
  const loadManifest = async () => {
    // what the device already holds decides how long the server gets: with a
    // copy in hand a hung connection costs a second, without one the network
    // is the only way to open this book at all and must be given its time.
    // (The service worker caps the same request when it is in charge; the
    // page's own cap is what covers a first open, before it has claimed.)
    const hit = "caches" in window
      ? await caches.match(bookUrl("manifest.json"))
      : null;
    let m = null;
    try {
      const res = await fetch(bookUrl("manifest.json"), hit ? capped() : undefined);
      if (res.status === 401) denied = true;
      else if (res.status === 404) gone = true;
      else if (res.ok) m = await res.json();
    } catch { /* offline, or capped — the cached copy below */ }
    // the offline copy also serves a revoked device that still holds the
    // book: revocation fences the server, not what a phone already has. A 404 is
    // different — the book was deleted or replaced, and its copy must not bring
    // it back (its audio and every later request would 404 too)
    fromCopy = false;
    if (!m && hit && !gone) { m = await hit.json(); fromCopy = true; }
    return m;
  };
  // A remembered mapping is taken as-is: ids never change, so this saves a
  // round trip on every open and works with no network at all. Only when the
  // book turns out not to be there do we ask the server again — that is a
  // slug re-used by a different book, or a device back after a long absence.
  const remembered = cachedBookId(slug);
  state.id = remembered ?? await resolveBookId(slug);
  let manifest = await loadManifest();
  if (!manifest && remembered) {
    const old = state.id;
    const fresh = await resolveBookId(slug, gone);
    if (fresh && fresh !== old) {
      state.id = fresh;
      if (gone) forgetBook(old);
      gone = false;
      manifest = await loadManifest();
    }
  }
  if (!manifest) {
    if (denied) {
      if (await reauth()) return initReader(slug);
      return renderKeyGate(() => initReader(slug), !!getKey());
    }
    // distinguish "no such book" from "offline and never cached" — the
    // latter needs the ⇣ toggle enabled while online, not a different URL
    if (navigator.onLine === false)
      return renderMessage(t("err.offlineTitle"), [
        t("err.offlineBody", slug),
        el("code", {}, "⇣"), t("err.offlineBodyTail"),
        el("button", { class: "linklike", onclick: () => location.reload() }, t("lib.retry")),
      ]);
    // a resumed slug the server disowns (deleted, renamed away) must not
    // wedge every "/" open into this page — forget it and offer the shelf
    try {
      if (lastBook() === slug) localStorage.removeItem("dogear_last_book");
    } catch { /* private mode */ }
    return renderMessage(t("err.notFoundTitle"), [
      t("err.notFoundBody", slug),
      el("a", { href: "/?shelf" }, t("err.backToLibrary")),
    ]);
  }
  state.manifest = manifest;
  // a book from a Simplified site reads as Traditional: the converter is
  // loaded once here, and every title and chapter passes through it (the
  // chapter text in fetchChapter). Without it — first open offline, before
  // the service worker has the dictionary — the book reads as the site
  // wrote it, which beats not reading at all.
  state.hant = manifest.script === "hans" ? await hantConverter() : null;
  if (state.hant) {
    manifest.title = state.hant(manifest.title);
    for (const c of manifest.chapters) c.title = state.hant(c.title);
  }
  try { localStorage.setItem("dogear_last_book", slug); } catch { /* private mode */ }
  if (fromCopy && navigator.onLine !== false) checkBookStillThere();
  state.cum = manifest.chapters.reduce((acc, c) => {
    acc.push((acc[acc.length - 1] ?? 0) + c.chars);
    return acc;
  }, []);
  document.title = `${manifest.title} · dogear`;

  if (offlineEnabled()) persistStorage();
  // settings reconcile rides along with the position fetch — both must land
  // before the shell builds, so the server-synced paper colour and spacing apply pre-paint
  const [pos] = await Promise.all([resolvePosition(), resolveSettings(state.uid)]);
  buildReaderShell();
  syncMarks(); // background; the panel renders from the local copy either way
  await openChapter(pos.chapter, pos.offset);
  if (pos.pulled) syncFlash();
  if (pos.back) showJumpNotice(pos.back);
  if (state.dirty) flush(); // local progress the server hasn't seen — push it now

  wireReaderEvents();
  applyWakeLock(); // the reader is where 恆亮 applies
  showTapZones();
}

// Once per page load, not once per initReader. initReader RE-ENTERS today —
// a 401 that reauth repaired, the key gate's retry — and both of those turn
// back before this point, so nothing doubles as the code stands. The guard is
// what keeps that from being load-bearing: window listeners cannot be
// un-registered from here, so a re-entry that ever reached the tail would
// leave a second live copy of every one of them, doubling each flush and
// fighting itself over the re-anchor. Every handler reads module state
// (state, settings) rather than anything captured here, so one registration
// serves every later open.
let readerWired = false;

function wireReaderEvents() {
  if (readerWired) return;
  readerWired = true;
  addEventListener("scroll", onScroll, { passive: true });
  addEventListener("keydown", onKey);
  addEventListener("click", onTap);
  // not passive: onTouchStart cancels touches that start in the edge band,
  // and only a cancelled touchstart stops the engine's pan (the handler is
  // a few comparisons, so the scroll it holds up does not notice)
  addEventListener("touchstart", onTouchStart, { passive: false });
  // not passive: onTouchEnd cancels the touchend of a tap on the text
  addEventListener("touchend", onTouchEnd, { passive: false });
  // deliberate scrolling pauses the player's auto-follow for a few seconds
  addEventListener("wheel", () => (lastUserScroll = Date.now()), { passive: true });
  addEventListener("touchmove", () => (lastUserScroll = Date.now()), { passive: true });
  // preload the player module so tapping 🔊 can call audio.play() inside
  // the gesture (iOS blocks playback started after an await)
  loadPlayer().catch(() => {});
  // the network coming back: push first, then ask what the row holds — the
  // answer is only another device's if our own writes are already in it
  addEventListener("online", () => {
    flushSettings();
    updateOfflineWindow();
    flush().then(checkRemotePosition);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") { flushSettings(true); return flush(true); }
    // narration crossed chapters while the screen was off — show it now
    playerMod?.visibleCatchup();
    // the foreground flip is how an installed PWA "reopens": the moment to
    // find out that the phone read three chapters on while this sat idle
    checkRemotePosition();
  });
  addEventListener("pagehide", () => { flushSettings(true); flush(true); });
  // rotation / window resize re-derives the grid, which MOVES every page
  // boundary — so re-anchor on the tracked offset instead of keeping a
  // scroll position that now means a different place in the text
  addEventListener("resize", () => {
    clearTimeout(resizeTick);
    resizeTick = setTimeout(() => {
      applyGrid();
      plog(`resize ${where()}`);
      if ($("#content p[data-off]")) restoreScroll(state.off);
    }, 200);
  });
}

let resizeTick = 0;

// This reader's row for this book, or null for anything that went wrong
// (offline, timed out, a dead API, a revoked key) — every caller's answer to
// "no remote" is the same: keep what the device holds.
async function fetchRemotePosition(opts) {
  try {
    const res = await fetch(
      `/api/position?book=${encodeURIComponent(state.id)}&user=${encodeURIComponent(state.uid)}`,
      opts,
    );
    const data = await res.json();
    if (!data.position) return null;
    return {
      chapter: data.position.chapter,
      offset: data.position.char_off,
      updatedAt: data.position.updated_at,
    };
  } catch {
    return null;
  }
}

async function resolvePosition() {
  let local = null;
  try { local = JSON.parse(localStorage.getItem(posKey())); } catch { /* ignore */ }
  // capped: resuming must not wait on a bookmark the device already holds.
  // Losing this race cannot lose progress — the server takes a position
  // write only when its updated_at is newer (LWW), so the local-wins flush
  // that follows a timeout can never clobber a fresher remote bookmark.
  const remote = await fetchRemotePosition(capped());

  const pick =
    [local, remote].filter(Boolean).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0] ??
    { chapter: 0, offset: 0, updatedAt: 0 };
  if (local && (!remote || (local.updatedAt || 0) > (remote.updatedAt || 0))) {
    state.dirty = true; // local progress the server hasn't seen yet
    state.lastSaved = local;
  }
  // a synced bookmark that lands far from where THIS device last was gets a
  // one-tap way back (a runaway bookmark — narration left playing, a TOC
  // mis-tap on another device — must never cost the reader their position)
  if (pick === remote && local && Math.abs(remote.chapter - local.chapter) >= 2)
    pick.back = { chapter: local.chapter, offset: local.offset };
  // another device's bookmark won over this one's: worth the corner blink
  if (pick === remote && (!local || (remote.updatedAt || 0) > (local.updatedAt || 0)))
    pick.pulled = true;
  pick.chapter = Math.min(Math.max(pick.chapter ?? 0, 0), state.manifest.chapters.length - 1);
  pick.offset = Math.max(pick.offset ?? 0, 0);
  // the resume baseline: savePos treats an unchanged position as already
  // synced — merely opening a link must never re-write the bookmark or
  // bump its timestamp (位置變動才觸發同步)
  state.lastSaved = { chapter: pick.chapter, offset: pick.offset, updatedAt: pick.updatedAt || 0 };
  plog(`open 取${pick === remote ? "遠端" : pick === local ? "本機" : "零"}`
    + ` 本機${fmtPos(local)} 遠端${fmtPos(remote)}${pick.back ? " 跳章pill" : ""}`);
  return pick;
}

const chapterTitle = (i) => state.manifest.chapters[i]?.title ?? t("lib.chapterN", i + 1);

function showJumpNotice(back) {
  back.chapter = Math.min(Math.max(back.chapter, 0), state.manifest.chapters.length - 1);
  const note = el("div", { class: "jumpnote" },
    el("span", { class: "jumpnote-text" },
      t("jump.synced", chapterTitle(state.idx), chapterTitle(back.chapter))),
    el("button", {
      class: "linklike",
      onclick: () => { note.remove(); openChapter(back.chapter, back.offset).then(() => flush()); },
    }, t("jump.back")),
    el("button", { class: "iconbtn", title: t("ui.close"), onclick: () => note.remove() }, "✕"));
  document.body.append(note);
}

// ---------- the bookmark another device moved (background pull) ----------
//
// resolvePosition runs once, when the book opens — and an installed PWA is
// reopened, not reloaded, so that one open can stand for days. A device that
// opened offline, or opened before the phone read on ahead, would otherwise
// hold a stale bookmark with no way to ask again that does not involve
// telling the reader to pull-to-refresh a PWA. This is the missing pull: the
// same reconcile, re-run in the background when the app comes back to the
// foreground and when the network returns.
//
// It never moves the page — a pill offers the jump, the mirror of the
// runaway-bookmark pill that offers the way back. Text must not move under
// someone who is reading it, and "the other device is ahead" is a weaker
// claim than "this reader asked to go there".
let posNoticed = 0; // the remote updated_at already offered or ruled out

async function checkRemotePosition() {
  if (!state.manifest || !state.id || !state.uid) return;
  // local progress the server has not taken yet: whatever the row holds is
  // older than what this device is about to push, so there is nothing to
  // learn from it. The flush that clears this re-invites the check.
  if (state.dirty) return;
  // 4 s, not NET_MS: this blocks nothing (checkVersion's reasoning), and a
  // 1 s cap on a slow link would mean the notice simply never arrives.
  const remote = await fetchRemotePosition(capped(4000));
  if (!remote) return;
  const seen = Math.max(state.lastSaved?.updatedAt ?? 0, posNoticed);
  const verdict = remote.updatedAt <= seen ? "不新" : remote.chapter === state.idx ? "同章靜默" : "pill";
  plog(`remote ${fmtPos(remote)} 本機@${seen} → ${verdict} ${where()}`);
  if (remote.updatedAt <= seen) return;
  posNoticed = remote.updatedAt; // asked and answered, including a dismissal
  // Same chapter is not worth a pill: it would name the chapter the reader is
  // already in, and two devices a few paragraphs apart resolve themselves —
  // whichever one moves next wins the LWW.
  if (remote.chapter === state.idx) return;
  showRemoteNotice(remote);
}

function showRemoteNotice(remote) {
  // one pill at a time — they are all parked on the same fixed corner. The
  // update note is spared: it is about the app, not about a position, and it
  // has its own answered/dismissed bookkeeping.
  document.querySelector(".jumpnote:not(.updatenote)")?.remove();
  const note = el("div", { class: "jumpnote syncnote" },
    el("span", { class: "jumpnote-text" }, t("jump.remote", chapterTitle(remote.chapter))),
    el("button", {
      class: "linklike",
      // arriving there IS this device moving, so it takes a fresh timestamp
      // through savePos — the row keeps meaning "last place anyone read".
      onclick: () => { note.remove(); openChapter(remote.chapter, remote.offset).then(() => flush()); },
    }, t("jump.go")),
    el("button", { class: "iconbtn", title: t("ui.close"), onclick: () => note.remove() }, "✕"));
  document.body.append(note);
}

// Back to the shelf leaves the reader, so the position, settings and bookmarks
// are pushed to the server NOW (the corner chip shows it) instead of waiting
// for the 10 s timer or a beacon. Capped: an unreachable server must not trap
// the reader — local progress is already saved and the shelf shows it.
async function leaveReader() {
  trackScroll(); // the 400 ms scroll throttle may not have caught the last move
  if (state.dirty || settingsDirty || readMarks(state.id).dirty) {
    const cap = new Promise((resolve) => setTimeout(resolve, 6000));
    await Promise.race([Promise.allSettled([flush(), flushSettings(), pushMarks(state.id)]), cap]);
  }
  location.href = "/?shelf";
}

// the shelf button: a plain click leaves through leaveReader, a modified one
// (new tab, new window) is left to the browser
function leaveToShelf(e) {
  if (e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  return leaveReader();
}

function buildReaderShell() {
  const m = state.manifest;
  showScreen(null); // the reader lowers every screen and owns #readerRoot
  $("#readerRoot").replaceChildren(
    el("header", { class: "topbar" },
      el("a", { class: "iconbtn brand", href: "/?shelf", title: t("ui.library"), onclick: leaveToShelf }),
      el("div", { class: "titles" },
        el("div", { class: "btitle" }, m.title),
        el("div", { class: "ctitle", id: "ctitle" }, "")),
      el("button", { id: "audioBtn", class: "iconbtn", title: t("ui.listen"), onclick: toggleAudio }, "🔊"),
      el("button", { id: "offlineBtn", class: "iconbtn" + (offlineExplicit() ? " active" : ""), title: t("ui.offlineCache"), onclick: toggleOffline }, "⇣"),
      "wakeLock" in navigator
        ? el("button", { id: "wakeBtn", class: "iconbtn" + (wakeOn() ? " active" : ""), title: t("ui.wake"), onclick: toggleWake }, "☀")
        : null,
      // ids, not titles, are what the e2e suites click: the titles move with
      // the interface language now
      el("button", { id: "settingsBtn", class: "iconbtn", title: t("ui.settings"), onclick: toggleSettings }, "Aa"),
      // the two lists of places in the book sit side by side, at the right edge,
      // and their panels open on that edge too
      el("button", { id: "tocBtn", class: "iconbtn", title: t("ui.contents"), onclick: toggleToc }, "☰"),
      el("button", { id: "marksBtn", class: "iconbtn", title: t("ui.marks"), onclick: toggleMarks }, "🔖")),
    el("main", { id: "content" }),
    // previous on the left, next on the right, as in any left-to-right UI
    el("footer", { class: "botnav" },
      el("button", { id: "prevBtn", onclick: () => nav(-1) }, t("ui.prev")),
      el("div", { class: "progress", id: "progress", title: t("ui.fullscreen"), onclick: toggleFullscreen }),
      el("button", { id: "nextBtn", onclick: () => nav(1) }, t("ui.next"))),
    el("div", { id: "toc", class: "toc", hidden: true }),
    el("div", { id: "marks", class: "toc", hidden: true }),
  );
  applyGrid(); // #content exists now — derive the line size before any text lands
}

// OpenCC cn→tw, the module /admin runs on an upload, loaded the first time
// a hans book opens and kept for the session (1.1 MB, ~1 s on a phone; the
// service worker caches it after that). Every one of its 53,060 cn→tw
// entries maps to a string of the same length, so a converted chapter has
// the same offsets as the file in R2: bookmarks, the sentence highlight and
// the TTS chunk maps keep working in raw-text coordinates. Conversion costs
// ~2 ms a chapter.
let hantLoad = null;
function hantConverter() {
  hantLoad ??= import("/vendor/opencc-cn2t.js")
    .then((m) => m.Converter({ from: "cn", to: "tw" }))
    .catch(() => { hantLoad = null; return null; });
  return hantLoad;
}

async function fetchChapter(i) {
  const file = state.manifest.chapters[i].file;
  if (state.cache.has(file)) return state.cache.get(file);
  let text;
  try {
    const res = await fetch(bookUrl(file));
    // the worker says why in the body (an online book's site down, say), and
    // that is the line worth showing over a bare status
    if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `HTTP ${res.status}`);
    text = await res.text();
  } catch (err) {
    // offline before the service worker took over — try the offline cache
    const hit = "caches" in window ? await caches.match(bookUrl(file)) : null;
    if (!hit) throw err;
    text = await hit.text();
  }
  // the cache holds what the reader shows: a hans chapter converted once,
  // for the page, the player and the offline copy alike
  if (state.hant) text = state.hant(text);
  state.cache.set(file, text);
  while (state.cache.size > 8) state.cache.delete(state.cache.keys().next().value);
  return text;
}

async function openChapter(i, offset = 0) {
  const ch = state.manifest.chapters[i];
  if (!ch) return;
  state.idx = i;
  state.loading = true;
  const content = $("#content");
  content.replaceChildren(el("p", { class: "muted" }, t("reader.loading")));
  let text;
  try {
    text = await fetchChapter(i);
  } catch (err) {
    // loading stays true: the error screen has no chapter edges, so a tap
    // must not chain into nav — 重試 / the bars are the way out
    content.replaceChildren(
      el("p", {}, t("err.chapterFail", err.message),
        el("button", { class: "linklike", onclick: () => openChapter(i, offset) }, t("lib.retry"))),
    );
    return;
  }

  $("#ctitle").textContent = ch.title;
  const frag = document.createDocumentFragment();
  frag.append(el("h2", { class: "chapter-head" }, ch.title));
  let off = 0;
  let headingSkipped = false;
  for (const line of text.split("\n")) {
    const s = line.trim(); // not `t` — that name is the translator now
    // the heading line itself is rendered as the <h2>, skip its paragraph
    if (s && !(s === ch.title.trim() && !headingSkipped && (headingSkipped = true))) {
      // data-off names the trimmed line's FIRST char in raw-text coords, not
      // the raw line start: the node holds the trimmed line, so offset maths
      // over it (the sentence wash, per-char rects) only lines up when the
      // 段首 indent the trim removed is skipped here too.
      frag.append(el("p", { "data-off": off + (line.length - line.trimStart().length) }, s));
    }
    off += line.length + 1;
  }
  content.replaceChildren(frag);
  applyGrid();
  state.loading = false;

  $("#prevBtn").disabled = i === 0;
  $("#nextBtn").disabled = i === state.manifest.chapters.length - 1;

  // offset "end" = land on the chapter's last screen (paging backward);
  // the tracked offset becomes the last paragraph's, refined by trackScroll
  const atEnd = offset === "end";
  if (atEnd) {
    const ps = content.querySelectorAll("p[data-off]");
    offset = ps.length ? Number(ps[ps.length - 1].dataset.off) : 0;
  }
  state.off = offset;
  restoreScroll(atEnd ? "end" : offset);
  updateProgress();
  savePos("open");

  if (i + 1 < state.manifest.chapters.length) fetchChapter(i + 1).catch(() => {});
  updateOfflineWindow();

  // navigating while listening moves the narration too (the player ignores
  // chapter opens it initiated itself)
  playerMod?.chapterOpened(i, offset);
}

// ---------- offline chapter cache (service worker serves it; we fill it) ----------
//
// Per book, three states in one localStorage key:
//
//   absent — the default: a small safety net. Reading a book quietly keeps
//            [idx−5, idx+5] on the device, so a tunnel or a dead spot never
//            strands the chapter someone is in the middle of — without
//            pulling a whole reading window over cellular uninvited.
//   "1"    — explicit, armed by tapping ⇣ (in the reader or on the shelf):
//            the full window [idx−5, idx+50] — enough book for a flight.
//   "0"    — off: nothing cached, the book's cache deleted.
//
// A tap on an unlit ⇣ always arms, a tap on a lit one always turns off — the
// safety net is only ever the pristine state, never returned to. "Off" is a
// stored value rather than a removed key so a device that deliberately turned
// the cache off stays off; the old opt-in scheme stored nothing for off,
// which made it indistinguishable from never-touched.

const OFFLINE_BEHIND = 5;
const OFFLINE_AHEAD = 50;
const OFFLINE_AHEAD_IMPLICIT = 5;
// an online book's chapters are fetched from its site the first time anyone
// asks (DESIGN.md → Online books): the 50-ahead window would be 50 chapters
// pulled off a stranger's server in one burst, so the ⇣ keeps fewer
const OFFLINE_AHEAD_ONLINE = 10;

const offlineKey = (id) => `dogear_offline_${id}`;
const offlineEnabled = (id = state.id) => localStorage.getItem(offlineKey(id)) !== "0";
const offlineExplicit = (id = state.id) => localStorage.getItem(offlineKey(id)) === "1";
const bookCacheName = (id = state.id) => `dogear-book-${id}`;

function setOffline(id, on) {
  try { localStorage.setItem(offlineKey(id), on ? "1" : "0"); } catch { /* private mode */ }
}

async function toggleOffline() {
  if (!("caches" in window)) return;
  if (offlineExplicit()) {
    setOffline(state.id, false);
    await caches.delete(bookCacheName());
    updateOfflineBtn();
  } else {
    setOffline(state.id, true);
    persistStorage();
    updateOfflineBtn();
    updateOfflineWindow();
  }
}

// Ask the browser not to evict our storage: without this, iOS Safari drops
// the Cache API contents AND the service worker registration after ~7 days
// of not visiting the site — which presents as "offline stopped working".
function persistStorage() {
  navigator.storage?.persist?.().catch(() => {});
}

// Runs after every chapter open; a newer run cancels the fetch loop of an
// older one.
let offlineRun = 0;
async function updateOfflineWindow() {
  if (!offlineEnabled() || !("caches" in window)) return;
  // offline: can't refill, so don't evict either — keep what we have
  if (navigator.onLine === false) return;
  const run = ++offlineRun;
  await fillOfflineWindow(state.id, state.manifest, state.idx, () => run === offlineRun);
  updateOfflineBtn();
}

// Keep chapters [idx-5, idx+50] of one book cached, evict the rest. Takes the
// book explicitly instead of reading `state`, because the shelf fills books
// that are not open — `alive` is how the reader cancels a superseded run.
async function fillOfflineWindow(id, manifest, idx, alive = () => true) {
  const chs = manifest.chapters;
  const lo = Math.max(0, idx - OFFLINE_BEHIND);
  let ahead = offlineExplicit(id) ? OFFLINE_AHEAD : OFFLINE_AHEAD_IMPLICIT;
  if (manifest.source) ahead = Math.min(ahead, OFFLINE_AHEAD_ONLINE);
  const hi = Math.min(chs.length - 1, idx + ahead);
  const want = new Set();
  for (let i = lo; i <= hi; i++) want.add(assetUrl(id, chs[i].file, manifest.generatedAt));

  const cache = await caches.open(bookCacheName(id));
  await cache.put(
    assetUrl(id, "manifest.json"),
    new Response(JSON.stringify(manifest), { headers: { "content-type": "application/json" } }),
  );
  for (const req of await cache.keys()) {
    const u = new URL(req.url);
    // compare path+query: a republished book's old ?v= entries evict too
    if (u.pathname.endsWith(".txt") && !want.has(u.pathname + u.search))
      await cache.delete(req);
  }
  const missing = [];
  for (const p of want) if (!(await cache.match(p))) missing.push(p);
  for (let i = 0; i < missing.length && alive(); i += 3) {
    await Promise.all(missing.slice(i, i + 3).map((p) => cache.add(p).catch(() => {})));
  }
}

// How many chapters of a book this device actually holds. caches.open() would
// CREATE the cache, and an empty dogear-book-<id> is not harmless: the service
// worker takes its existence as "this book is kept offline" and starts
// stashing manifests for it. So ask caches.has() first.
async function cachedChapters(id) {
  if (!("caches" in window) || !(await caches.has(bookCacheName(id)))) return 0;
  const keys = await (await caches.open(bookCacheName(id))).keys();
  return keys.filter((r) => new URL(r.url).pathname.endsWith(".txt")).length;
}

// lit = explicit only: with the safety net always on, "lit because caching"
// would light for every book and mean nothing. Lit means "you asked to keep
// this book here", the same thing the shelf's ring means.
async function updateOfflineBtn() {
  const btn = $("#offlineBtn");
  if (!btn) return;
  btn.classList.toggle("active", offlineExplicit());
  if (!offlineEnabled() || !("caches" in window)) {
    btn.title = t("ui.offlineOff");
    return;
  }
  const n = await cachedChapters(state.id);
  btn.title = offlineExplicit() ? t("ui.offlineOn", n) : t("ui.offlineAuto", n);
}

// ---------- TTS audiobook player (lives in /player.mjs) ----------
//
// Preloaded at reader init so the 🔊 tap can start playback synchronously
// inside the gesture (iOS requirement). If a cold-cache tap beats the
// preload, playback starts gesture-less once the import lands — iOS may
// then need one ▶ tap on the player bar.

let playerMod = null;
let lastUserScroll = 0;

function loadPlayer() {
  return import("/player.mjs").then((m) => {
    m.init({
      $, el, state, fetchChapter, openChapter, savePos, flush,
      updateProgress, followScroll, pageStartOffset, highlightSentence,
      lastUserScroll: () => lastUserScroll,
    });
    playerMod = m;
    return m;
  });
}

function toggleAudio() {
  if (playerMod) return playerMod.togglePlayer();
  loadPlayer().then((m) => m.togglePlayer()).catch(() => {});
}

// Space: start the narration, or pause / resume it while it is on
function togglePlayPause() {
  if (playerMod) return playerMod.playPause();
  loadPlayer().then((m) => m.playPause()).catch(() => {});
}

// Reading distance of an on-screen rect's top edge: its document y, measured
// from the first line's position at scroll 0.
const rectDist = (r) => r.top + scrollY - GRID.band;

// The on-screen rect of the CHARACTER at char offset `offset` — page maths
// must work on the character, not the paragraph: a novel paragraph spans
// pages, and the paragraph's start edge would pin every offset inside it to
// the paragraph's first page. Falls back to the paragraph rect at its start
// (or when the Range yields nothing). data-off counts from the trimmed
// line's first char, so in-paragraph offsets map onto the node exactly; an
// offset inside a 段首 indent lands on the previous paragraph's tail rect,
// adjacent at page granularity.
function offsetRect(offset) {
  const ps = $("#content")?.querySelectorAll("p[data-off]");
  if (!ps?.length) return null;
  let target = null;
  for (const p of ps) {
    if (Number(p.dataset.off) <= offset) target = p;
    else break;
  }
  if (!target) return null;
  const node = target.firstChild;
  const i = offset - Number(target.dataset.off);
  if (node?.nodeType === 3 && i > 0 && node.length) {
    const range = document.createRange();
    const j = Math.min(i, node.length - 1);
    range.setStart(node, j);
    range.setEnd(node, j + 1);
    const r = range.getBoundingClientRect();
    if (r.width || r.height) return r;
  }
  return target.getBoundingClientRect();
}

function followScroll(offset) {
  const c = $("#content");
  if (!c) return;
  const r = offsetRect(offset);
  if (!r) return;
  // The page scrolls freely, so what matters is whether the spoken character
  // is in the part of the window the overlays leave clear. If not, put it one
  // line below the top of that part, no animation. Absolute target, never
  // scrollBy: on-device tests showed iOS applies relative scrolls twice.
  const { top, bottom } = overlayInsets();
  if (r.top >= top && r.bottom <= innerHeight - bottom) return;
  scrollTo(0, Math.min(scrollEnd(), Math.max(0, scrollY + r.top - top - GRID.pitch)));
}

// Paint the sentence the voice is on. NOT the CSS Custom Highlight API: on
// the phone its paint never invalidates — replaced and deleted highlights
// stay washed until something else repaints (WebKit bugs 266250, 259897;
// on-device screenshot 2026-08-08 showed a whole page of stale washes). So
// the wash is self-painted: one absolutely-positioned rect per line
// fragment of the sentence's Range, inside #content so the rects ride page
// glides natively, replaced wholesale each call — ordinary DOM painting,
// which WebKit always invalidates. A sentence never crosses a paragraph
// (\n is an ender), so one Range in one text node, clamped to the trimmed
// line the node holds — the caller hands in a span that starts on ink
// (markSpoken skips the 段首 indent), so the raw→node mapping is exact.
// null removes the wash. The heading renders as <h2>, not p[data-off], so
// the title announcement has nothing to paint.
function highlightSentence(start, end) {
  if (start == null) return void $("#ttsHl")?.remove();
  const c = $("#content");
  const ps = c?.querySelectorAll("p[data-off]");
  if (!ps?.length) return;
  let p = null;
  for (const q of ps) {
    if (Number(q.dataset.off) <= start) p = q;
    else break;
  }
  const node = p?.firstChild;
  if (node?.nodeType !== 3 || !node.length) return;
  const off = Number(p.dataset.off);
  const a = Math.max(0, Math.min(start - off, node.length - 1));
  const b = Math.max(a + 1, Math.min(end - off, node.length));
  const range = document.createRange();
  range.setStart(node, a);
  range.setEnd(node, b);
  const w = $("#ttsHl") ?? c.appendChild(el("div", { id: "ttsHl", "aria-hidden": "true" }));
  w.dataset.start = start;
  w.dataset.end = end;
  const cr = c.getBoundingClientRect();
  w.replaceChildren(...[...range.getClientRects()].map((r) => {
    const d = el("div");
    d.style.cssText = `left:${r.left - cr.left - c.clientLeft + c.scrollLeft}px;` +
      `top:${r.top - cr.top - c.clientTop + c.scrollTop}px;` +
      `width:${r.width}px;height:${r.height}px`;
    return d;
  }));
}

// Char offset of the first character on the page now on screen — where a
// NEW listening session starts. The tracked state.off is deliberately
// paragraph-grained and sticky (see trackScroll), so after paging it
// routinely points a page or more behind what the eye is on; the reading
// must open with the visible page instead. Page 0 answers 0 so the heading
// chunk still announces the chapter. Binary search inside the straddling
// paragraph: reading order is monotone in rect distance.
function pageStartOffset() {
  const c = $("#content");
  const ps = c?.querySelectorAll("p[data-off]");
  if (!c || !ps?.length || !GRID.pitch) return null;
  if (scrollY <= 1) return 0; // the top of the chapter: start with its heading
  // the visible window's top edge, minus 1 px of rounding grace; lines under
  // the top bar are not on screen, so start below it
  const lead = scrollY - 1 + overlayInsets().top;
  let prev = null, next = null;
  for (const p of ps) {
    if (rectDist(p.getBoundingClientRect()) <= lead) prev = p;
    else { next = p; break; }
  }
  const nextOff = () => (next ? Number(next.dataset.off) : null);
  const node = prev?.firstChild;
  if (node?.nodeType !== 3 || !node.length) return nextOff();
  // first char of `prev` sitting past the window's start edge, if any —
  // otherwise the page opens on the next paragraph
  const range = document.createRange();
  const at = (i) => {
    range.setStart(node, i);
    range.setEnd(node, i + 1);
    return rectDist(range.getBoundingClientRect());
  };
  let lo = 0, hi = node.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (at(mid) > lead) { ans = mid; hi = mid - 1; }
    else lo = mid + 1;
  }
  if (ans < 0) return nextOff();
  return Number(prev.dataset.off) + ans;
}

// Put the text at char offset `offset` (or the chapter's "end", or its top when
// there is none) back at the top of the window — after a chapter opens, and
// after a size or spacing change reflowed the text. Absolute scrollTo, never
// scrollBy: on-device tests showed iOS applies relative scrolls twice, which
// doubled every restore, and a restore that lands long is saved as the new
// position, so the bookmark walked forward on each open.
function restoreScroll(offset) {
  requestAnimationFrame(() => {
    if (offset === "end") {
      scrollTo(0, document.documentElement.scrollHeight);
      plog(`restore 末頁 ${where()}`);
      return;
    }
    if (!offset) {
      scrollTo(0, 0);
      plog(`restore 首頁 ${where()}`);
      return;
    }
    const r = offsetRect(offset);
    if (r) {
      // the character's own line goes to the top of the reading band, so
      // restore → track → save → restore is a fixed point: the tracker reads
      // the paragraph at that line back as the same offset
      const dist = Math.max(0, rectDist(r));
      scrollTo(0, dist);
      plog(`restore off${offset} dist${Math.round(dist)} → ${where()}`);
    } else plog(`restore off${offset} 無rect ${where()}`);
  });
}

// ---------- position tracking / sync ----------

// The bookmark's flight recorder (testlog page=pos, quota in the worker).
//
// Two phones, one bookmark, and a report (2026-08-28) that the second phone
// reopened several pages PAST where the first one stopped — which no sync
// rule can produce: the reconcile either stands still (same chapter) or
// lands on exactly the offset the other device wrote. So either the offset
// was wrong when written, or it was mapped to the wrong page when read, and
// from the laptop the code cannot say which. This is the witness: every
// place the bookmark is written, read or re-aimed logs one line — chapter,
// offset, the page now on screen, the scroll position, the grid, the
// viewport — the same recorder shape as the player's wlog. The device column
// is the PLATFORM, not the reader id: both phones share the id, and telling
// them apart is the whole question. Silent until something is logged, and
// it honours the /admin 裝置診斷 switch (testlog.js) like every other page.
const plog = (() => {
  let buf = [], timer = 0, t0 = 0;
  const ua = navigator.userAgent;
  const device = (/iPhone|iPad|iPod/.test(ua) ? "ios" : /Android/.test(ua) ? "android" : "desktop")
    + (matchMedia("(display-mode: standalone)").matches || navigator.standalone ? "-pwa" : "");
  const on = () => { try { return localStorage.getItem("dogear_testlog") !== "0"; } catch { return true; } };
  const flush = () => {
    timer = 0;
    if (!buf.length) return;
    const body = JSON.stringify({ page: "pos", device, data: buf.join("\n") });
    buf = [];
    try {
      if (!navigator.sendBeacon?.("/api/testlog", new Blob([body], { type: "application/json" })))
        fetch("/api/testlog", { method: "POST", headers: { "content-type": "application/json" }, body }).catch(() => {});
    } catch { /* offline is fine */ }
  };
  document.addEventListener("visibilitychange", () => {
    if (!t0) return;
    line("vis=" + document.visibilityState);
    if (document.visibilityState === "hidden") { clearTimeout(timer); flush(); }
  });
  addEventListener("pagehide", () => { if (t0) { clearTimeout(timer); flush(); } });
  function line(s) {
    if (!on()) return;
    if (!t0) t0 = performance.now();
    buf.push(((performance.now() - t0) / 1000).toFixed(1) + "s " + s);
    if (!timer) timer = setTimeout(flush, 1500);
  }
  return line;
})();
// the bookmark and the screen it sits on, in one token: chapter, offset, raw
// scroll, line pitch, viewport
function where() {
  return `ci${state.idx} off${state.off} sl${Math.round(scrollY)} p${GRID.pitch} ${innerWidth}×${innerHeight}`;
}
const fmtPos = (p) => (p ? `ci${p.chapter} off${p.offset} @${p.updatedAt || 0}` : "無");

let scrollTick = 0;
let lastScrollEvent = 0;
function onScroll() {
  lastScrollEvent = Date.now();
  if (scrollTick) return;
  scrollTick = setTimeout(() => { scrollTick = 0; updateChapterPct(); trackScroll(); }, 400);
}

function trackScroll() {
  if (playerMod?.player.playing) return; // audio owns the position while narrating
  const c = $("#content");
  const ps = c?.querySelectorAll("p[data-off]");
  if (!ps || !ps.length) return;
  // binary search: the first paragraph not yet scrolled past the reading edge,
  // the top of the reading band
  const edge = GRID.band + 4;
  let lo = 0, hi = ps.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ps[mid].getBoundingClientRect().bottom >= edge) { ans = mid; hi = mid - 1; }
    else lo = mid + 1;
  }
  const cur = Number(ps[ans].dataset.off);
  // still the same top paragraph: not a move — keeps the finer resumed/spoken
  // offset, and the settling scroll after a restore never re-syncs (位置變動
  // 才觸發同步)
  const next = ans + 1 < ps.length ? Number(ps[ans + 1].dataset.off) : Infinity;
  if (cur <= state.off && state.off < next) return;
  if (cur !== state.off) {
    const was = state.off;
    state.off = cur;
    updateProgress();
    savePos(`track ${was}→${cur} 段${ans}`);
  }
}

// `src` names the caller for the recorder — who moved the bookmark is the
// first question every runaway asks
function savePos(src = "?") {
  const last = state.lastSaved;
  if (last && last.chapter === state.idx && last.offset === state.off) return; // nothing moved
  const rec = { chapter: state.idx, offset: state.off, updatedAt: Date.now() };
  plog(`save[${src}] @${rec.updatedAt} ${where()}`);
  state.lastSaved = rec;
  try { localStorage.setItem(posKey(), JSON.stringify(rec)); } catch { /* full/blocked */ }
  state.dirty = true;
  setSyncDot("pending");
  if (!state.syncTimer) state.syncTimer = setTimeout(() => flush(), 10_000);
}

let posInFlight = null;
async function flush(useBeacon = false) {
  if (state.syncTimer) { clearTimeout(state.syncTimer); state.syncTimer = 0; }
  if (useBeacon) return sendPosition(true); // pagehide: no time to wait for anyone
  // One position write at a time. WebDAV (Koofr) locks a file while a PUT to
  // it runs, so overlapping writes answer 423 and each waits for the slowest;
  // a write that finds one in flight waits, then sends only if something
  // newer is still unsent (sendPosition clears `dirty` before its first await).
  while (posInFlight) await posInFlight;
  if (!state.dirty || !state.lastSaved) return;
  posInFlight = sendPosition(false).finally(() => { posInFlight = null; });
  return posInFlight;
}

async function sendPosition(useBeacon) {
  if (!state.dirty || !state.lastSaved) return;
  const body = JSON.stringify({
    book: state.id,
    user: state.uid,
    chapter: state.lastSaved.chapter,
    offset: state.lastSaved.offset,
    updatedAt: state.lastSaved.updatedAt,
  });
  state.dirty = false;
  if (useBeacon && navigator.sendBeacon) {
    navigator.sendBeacon("/api/position", new Blob([body], { type: "application/json" }));
    plog(`flush beacon ${fmtPos(state.lastSaved)}`);
    return;
  }
  setSyncDot("sending");
  try {
    const res = await fetch("/api/position", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true, // outlives the page if leaveToShelf's cap lets go first
    });
    // an evicted cookie: repair it for the retry the timer already owns
    if (res.status === 401) reauth();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setSyncDot("ok"); // also replaces the corner blink for this case
    plog(`flush ok ${fmtPos(state.lastSaved)}`);
  } catch (err) {
    plog(`flush 錯 ${err?.message} ${fmtPos(state.lastSaved)}`);
    state.dirty = true;
    setSyncDot("err");
    if (!state.syncTimer) state.syncTimer = setTimeout(() => flush(), 15_000);
  }
}

// One indicator, two places, the same states and colours: the dot in the
// footer bar, and a copy in the screen corner for when that bar is hidden
// while reading. pending (amber) = changed, waiting to upload; sending (ring)
// = the upload is out; ok (green) = the server has it, the corner copy fades
// after a moment; err (red) = failed, stays until a retry succeeds. No words —
// they live in title/aria-label.
let syncChipTimer = 0;
function setSyncDot(s) {
  syncState = s;
  const label = t("sync." + s);
  const dot = $("#syncdot");
  if (dot) {
    dot.className = "syncdot " + s;
    dot.title = label;
  }
  const chip = $("#syncchip")
    ?? document.body.appendChild(el("div", { id: "syncchip", role: "status" }));
  clearTimeout(syncChipTimer);
  chip.className = "syncdot " + s;
  chip.title = label;
  chip.setAttribute("aria-label", label);
  chip.hidden = false;
  if (s === "ok") syncChipTimer = setTimeout(() => { chip.hidden = true; }, 1500);
}

// 同步成功的一閃 (user 08-28): the footer dot is inside a bar that is hidden
// while reading, so "did it sync" had no answer on the page itself. A fixed
// corner dot blinks once per CONFIRMED exchange — a flush the server took,
// or a bookmark pulled from another device at open — then leaves (app.css).
// Beacon flushes are fire-and-forget and get no blink: nothing confirms them.
let syncFlashTimer = 0;
function syncFlash() {
  const d = $("#syncflash")
    ?? document.body.appendChild(el("div", { id: "syncflash", "aria-hidden": "true" }));
  d.classList.remove("on");
  void d.offsetWidth; // restart the animation when two confirmations overlap
  d.classList.add("on");
  clearTimeout(syncFlashTimer);
  syncFlashTimer = setTimeout(() => d.classList.remove("on"), 1800);
}

// ---------- settings sync (mirrors the position sync above) ----------
// dogear_settings_ts = ms epoch of the last local change (or the server
// updatedAt after a server-wins reconcile); LWW arbitrates across devices.

let settingsDirty = false;
let settingsTimer = 0;

function settingsChanged() {
  try { localStorage.setItem("dogear_settings_ts", String(Date.now())); } catch { /* private mode */ }
  settingsDirty = true;
  if (!settingsTimer) settingsTimer = setTimeout(() => flushSettings(), 2000);
}

async function flushSettings(useBeacon = false) {
  if (settingsTimer) { clearTimeout(settingsTimer); settingsTimer = 0; }
  if (!settingsDirty) return;
  const uid = state.uid ?? localStorage.getItem("dogear_uid");
  if (!uid) return;
  const body = JSON.stringify({
    user: uid,
    settings: { bg: settings.bg, leading: Number(settings.leading.toFixed(3)) },
    updatedAt: Number(localStorage.getItem("dogear_settings_ts")) || Date.now(),
  });
  settingsDirty = false;
  if (useBeacon && navigator.sendBeacon) {
    navigator.sendBeacon("/api/settings", new Blob([body], { type: "application/json" }));
    return;
  }
  try {
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    // an evicted cookie: repair it for the retry the timer already owns
    if (res.status === 401) reauth();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch {
    // a push lost here self-heals: next boot's resolveSettings sees the
    // local ts still ahead of the server row and re-pushes
    settingsDirty = true;
    if (!settingsTimer) settingsTimer = setTimeout(() => flushSettings(), 15_000);
  }
}

// Boot-time reconcile against the server row for this reader id. Called
// BEFORE the reader shell is built (in parallel with resolvePosition), so a
// server-wins apply never reflows a rendered chapter — if this ever moves
// after openChapter, a paper-colour or spacing change must call reanchor().
async function resolveSettings(uid) {
  const localTs = Number(localStorage.getItem("dogear_settings_ts")) || 0;
  let remote = null;
  try {
    // capped for the same reason as the position, and safe for the same
    // reason: settings are LWW by updated_at too, so a timed-out reconcile
    // re-pushes local rather than losing a newer server row
    const res = await fetch(`/api/settings?user=${encodeURIComponent(uid)}`, capped());
    if (!res.ok) return;
    const data = await res.json();
    if (data.settings) remote = data;
  } catch { return; } // offline/slow: keep local, retry next boot
  if (remote && remote.updatedAt > localTs) {
    // server wins — write the mirrors directly, NOT via the setters (a
    // setter would bump the ts and re-push what we just received)
    try {
      localStorage.setItem("dogear_bg", remote.settings.bg); // "" = explicit default
      if (typeof remote.settings.leading === "number")
        localStorage.setItem("dogear_leading", String(remote.settings.leading));
      localStorage.setItem("dogear_settings_ts", String(remote.updatedAt));
    } catch { /* private mode: applied for this session only */ }
    applySettings();
    return;
  }
  const hasLocal = ["dogear_bg", "dogear_leading"].some((k) => localStorage.getItem(k) !== null);
  if (hasLocal && (!remote || localTs > remote.updatedAt)) {
    // local newer, or the server has no row yet and this device has explicit
    // values — push up. Legacy devices (settings pre-date the sync feature,
    // no ts) claim now as their baseline.
    if (!localTs) {
      try { localStorage.setItem("dogear_settings_ts", String(Date.now())); } catch { /* ok */ }
    }
    settingsDirty = true;
    flushSettings();
  }
}

function updateProgress() {
  const before = state.idx > 0 ? state.cum[state.idx - 1] : 0;
  const total = state.manifest.totalChars || 1;
  const pct = Math.min(100, ((before + state.off) / total) * 100);
  // the shelf reads this back, so it shows where you stopped without waiting
  // for the server copy (see overlayLocalProgress)
  try {
    localStorage.setItem(`dogear_prog_${state.id}`, JSON.stringify({ chapter: state.idx, pct, at: Date.now() }));
  } catch { /* full or private mode */ }
  // two lines, so both percentages fit between the chapter buttons on a phone
  $("#progress")?.replaceChildren(
    el("span", { class: "progress-line" },
      el("span", { id: "syncdot", class: "syncdot " + syncState, title: t("sync." + syncState) }),
      ` ${state.idx + 1}/${state.manifest.chapters.length} · ${t("ui.bookPct", pct.toFixed(1))}`),
    el("span", { id: "chpct" }),
  );
  updateChapterPct();
}

// How far down this chapter the window is. The scroll position itself, not the
// paragraph the tracker has settled on, so it moves with every scroll tick and
// reads exactly 100% at the bottom (a chapter that fits on one screen is 100%).
function updateChapterPct() {
  const span = $("#chpct");
  if (!span) return;
  const end = scrollEnd();
  const pct = end <= 1 ? 100 : Math.min(100, Math.max(0, Math.round((scrollY / end) * 100)));
  span.textContent = t("ui.chapterPct", pct);
}

// ---------- navigation ----------

function nav(d, to = 0) {
  const i = state.idx + d;
  if (i < 0 || i >= state.manifest.chapters.length) return;
  openChapter(i, to).then(() => flush());
}

// Keyboard, on a desk. One table drives both the key handler and the help
// panel (? or the Aa panel), so what is listed is what works. `keys` are the
// names a key event resolves to (see keyName); `show` is how they are drawn.
// The keys listed here are cancelled, because the browser would otherwise act
// on them too (↓ scrolls a few lines, Space a page, with its own animation).
// Keys that are not listed — Home/End (top and bottom of the chapter),
// PageUp/PageDown, Shift+Space — keep the browser's own scrolling.
const SHORTCUTS = [
  { keys: ["ArrowDown", "d", "."], show: ["↓", "D", "."], label: "kbd.nextPage", run: () => pageScroll(1) },
  { keys: ["ArrowUp", "u", ","], show: ["↑", "U", ","], label: "kbd.prevPage", run: () => pageScroll(-1) },
  { keys: ["Space"], show: ["Space"], label: "kbd.playPause", run: () => togglePlayPause() },
  { keys: ["ArrowRight", ">"], show: ["→", ">"], label: "kbd.nextChapter", run: () => nav(1) },
  { keys: ["ArrowLeft", "<"], show: ["←", "<"], label: "kbd.prevChapter", run: () => nav(-1) },
  { keys: ["t"], show: ["T"], label: "kbd.toc", run: () => toggleToc() },
  { keys: ["c"], show: ["C"], label: "kbd.leave", run: () => leaveReader() },
  { keys: ["b"], show: ["B"], label: "kbd.marks", run: () => toggleMarks() },
  { keys: ["s"], show: ["S"], label: "kbd.settings", run: () => toggleSettings() },
  { keys: ["l"], show: ["L"], label: "kbd.listen", run: () => toggleAudio() },
  { keys: ["f"], show: ["F"], label: "kbd.fullscreen", run: () => toggleFullscreen() },
  { keys: ["h"], show: ["H"], label: "kbd.bars", run: () => document.documentElement.toggleAttribute("data-bars") },
  { keys: ["?"], show: ["?"], label: "kbd.help", run: () => toggleHelp() },
  { keys: ["Escape"], show: ["Esc"], label: "kbd.close", run: () => closePanels() },
];

// "d" for d and D, "Shift+Space" for shift and space, otherwise the key's own name
const keyName = (e) =>
  e.key === " " ? (e.shiftKey ? "Shift+Space" : "Space")
  : e.key.length === 1 ? e.key.toLowerCase() : e.key;

function onKey(e) {
  if (e.metaKey || e.ctrlKey || e.altKey) return; // leave browser shortcuts alone
  if (!$("#content")) return;
  if (e.target instanceof Element) {
    // typing owns the keys; a focused button or link keeps Space and Enter to
    // press itself, but the page keys still work after a click on a toolbar button
    if (e.target.closest("input, textarea, select")) return;
    if (e.target.closest("button, a") && (e.key === " " || e.key === "Enter")) return;
  }
  const name = keyName(e);
  const shortcut = SHORTCUTS.find((s) => s.keys.includes(name));
  if (!shortcut) return;
  e.preventDefault();
  shortcut.run();
}

function closePanels() {
  for (const id of ["toc", "marks"]) { const p = $("#" + id); if (p) p.hidden = true; }
  $("#settingsPanel")?.remove();
  $("#kbdHelp")?.remove();
}

function toggleHelp() {
  if ($("#kbdHelp")) return void $("#kbdHelp").remove();
  closePanels();
  document.body.append(el("div", { id: "kbdHelp", role: "dialog" },
    el("div", { class: "toc-head" },
      el("strong", {}, t("kbd.title")),
      el("button", { class: "iconbtn", title: t("ui.close"), onclick: () => $("#kbdHelp").remove() }, "✕")),
    ...SHORTCUTS.map((s) => el("div", { class: "kbd-row" },
      el("span", {}, t(s.label)),
      el("span", {}, ...s.show.map((k) => el("kbd", {}, k)))))));
}

// Tap zones over the text — see tapZone. The bars start hidden (nothing sets
// data-bars on load) so the whole screen is reading area.
//
// Taps are detected from touch events, not click: iOS Safari only
// synthesizes click for taps on "clickable" elements, so a click listener
// never hears taps on plain text. click stays as the mouse path.

let touchStart = null;
let lastTouchTap = 0;

// 邊緣不感應 (owner, 2026-09-17): a touch that STARTS within ~5 mm of a
// screen edge is not input on the reading surface — no page turn, no pan.
// The pos recorder caught the page dragged in the last seconds before a
// lock, three times in one morning — positions between grid points every
// 400 ms, a hand on the glass while the other one pressed the side button
// — and twice the snap rounded the drag up to two and three whole pages. Nothing on the reading surface needs its edges. The bars
// and every control keep theirs (owner: 工具列不修改), and outside the
// reader nothing changes. CSS px are not physical: 30 px is 5 mm on the
// owner's 402×874 @3x phone (460 ppi ÷ 3 ≈ 153 px per inch), and iPhones
// span 153–163 px per inch, so the band is 5.0–5.3 mm on any of them.
const EDGE_BAND_PX = 30;
const TOUCH_CONTROLS = "a, button, input, select, textarea, label, .topbar, .botnav, .playerbar, .toc, .jumpnote, #settingsPanel";
function inEdgeBand(e) {
  const p = e.changedTouches[0];
  if (!p || !$("#content") || document.querySelector("#app > section:not([hidden])")) return false;
  if (e.target instanceof Element && e.target.closest(TOUCH_CONTROLS)) return false;
  return p.clientX < EDGE_BAND_PX || p.clientY < EDGE_BAND_PX
    || p.clientX > innerWidth - EDGE_BAND_PX || p.clientY > innerHeight - EDGE_BAND_PX;
}

function onTouchStart(e) {
  if (inEdgeBand(e)) {
    // cancelling touchstart stops the pan and the synthesized click
    // together; the tap path in onTouchEnd never arms
    e.preventDefault();
    touchStart = null;
    const p = e.changedTouches[0];
    plog(`觸邊 ${Math.round(p.clientX)},${Math.round(p.clientY)} ${where()}`);
    return;
  }
  touchStart = e.touches.length === 1
    ? { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now(),
        // a tap that stops momentum scrolling is a brake, not a page turn
        still: Date.now() - lastScrollEvent > 100 }
    : null;
}

function onTouchEnd(e) {
  const s = touchStart;
  touchStart = null;
  if (!s || !s.still) return;
  const end = e.changedTouches[0];
  if (Math.hypot(end.clientX - s.x, end.clientY - s.y) > 12 || Date.now() - s.t > 350) return;
  lastTouchTap = Date.now();
  // A quick tap on the text is ours alone. Cancelling its touchend stops the
  // browser from also treating it as a tap on a word, which on Android Chrome
  // pops up "Touch to search" for the word under the finger (and on some
  // browsers selects it). A long press is not a tap (it is over 350 ms), so
  // selecting text still works; taps on controls keep their click.
  if (e.cancelable && e.target instanceof Element && !e.target.closest(TOUCH_CONTROLS)) e.preventDefault();
  handleTap(end.clientX, end.clientY, e.target, true);
}

function onTap(e) {
  if (Date.now() - lastTouchTap < 500) return; // synthesized after a touch tap
  handleTap(e.clientX, e.clientY, e.target);
}

// The screen is a 3×3 grid. The centre cell shows/hides the bars, the cell
// under it goes back a page, and every other cell goes forward — going back is
// rare, so it gets the small target. The hint showTapZones draws uses the same
// geometry in CSS (#tapzones .tz-*); change both together.
function tapZone(x, y) {
  const col = Math.min(2, Math.floor(x * 3));
  const row = Math.min(2, Math.floor(y * 3));
  if (col === 1 && row === 1) return "menu";
  if (col === 1 && row === 2) return "prev";
  return "next";
}

// A tap must never leave text selected. Two defences, for what a phone browser
// does with a quick tap (a double tap selects a word on some of them): a tap that
// finds a selection only clears it — like tapping away from a selection anywhere
// else — and a selection that appears right after a tap is cleared too. A
// deliberate selection (long-press) is not a tap, so neither rule touches it.
let lastTapAt = 0;
document.addEventListener("selectionchange", () => {
  if (Date.now() - lastTapAt < 700 && getSelection()?.toString()) getSelection().removeAllRanges();
});

function handleTap(cx, cy, target, touch = false) {
  if (!(target instanceof Element) || target.closest("a, button, label, .topbar, .botnav, .playerbar, .toc, #settingsPanel")) return;
  if (touch) lastTapAt = Date.now();
  if (getSelection()?.toString()) {
    // mouse: the click that ends a drag-selection; touch: a tap away from one
    if (touch) getSelection().removeAllRanges();
    return;
  }
  const zone = tapZone(cx / innerWidth, cy / innerHeight);
  if (zone === "menu") document.documentElement.toggleAttribute("data-bars");
  else pageScroll(zone === "next" ? 1 : -1);
}

// On a touch screen, show where the tap zones are for a moment when a book
// opens (and drop the hint at the first touch). A pointer:coarse device has no
// hover to discover them with, and nothing on the page says the screen is
// divided at all.
function showTapZones() {
  if (!matchMedia("(pointer: coarse)").matches) return;
  $("#tapzones")?.remove();
  const zone = (cls, key) => el("div", { class: `tz ${cls}` }, el("span", {}, t(key)));
  // "next" is every cell but two, so one green wash with the label repeated
  const box = el("div", { id: "tapzones", "aria-hidden": "true" },
    el("div", { class: "tz tz-next" }),
    zone("tz-top", "zones.next"), zone("tz-left", "zones.next"), zone("tz-right", "zones.next"),
    zone("tz-prev", "zones.prev"), zone("tz-menu", "zones.menu"));
  document.body.append(box);
  const hide = () => {
    box.classList.add("off");
    setTimeout(() => box.remove(), 400);
  };
  addEventListener("touchstart", hide, { capture: true, once: true, passive: true });
  setTimeout(hide, 2500);
}


// One-screen page turn; at the chapter's edge it crosses into the adjacent
// chapter — forward to the next one's beginning, backward to the previous
// one's END (so paging back reads naturally across the boundary).
let lastPageTurn = 0;
// Where a page turn lands. The text sits on a line grid (every line is GRID.pitch
// tall, from GRID.band down), and the bars and the player pill are overlays that
// cover text while they show, so the window that counts is the CLEAR part
// between them. Going forward, the new page starts on the last
// PAGE_OVERLAP_LINES lines that were fully visible, with the first of them at
// the very top of the clear part (not half under the top bar); going back, it
// ends on the first PAGE_OVERLAP_LINES lines that were fully visible.
const PAGE_OVERLAP_LINES = 2;
function pageTarget(d) {
  const { top, bottom } = overlayInsets();
  const p = GRID.pitch;
  const n = Math.max(1, Math.floor((innerHeight - top - bottom) / p)); // lines that fit in the clear part
  const lineAt = (y) => (y - GRID.band) / p; // fractional index of the line at document y
  const first = Math.ceil(lineAt(scrollY + top) - 1e-6); // first line fully in the clear part
  const last = Math.floor(lineAt(scrollY + innerHeight - bottom) + 1e-6) - 1; // last one
  const keep = Math.min(PAGE_OVERLAP_LINES, Math.max(0, n - 1));
  const start = d > 0
    ? Math.max(first + 1, last - keep + 1) // always at least one line further
    : Math.min(first - 1, first + keep - n);
  return GRID.band + start * p - top;
}

// Is the last line of the chapter fully in the clear part of the window?
function chapterEndVisible() {
  const ps = $("#content")?.querySelectorAll("p[data-off]");
  const lastLine = ps?.[ps.length - 1];
  return !lastLine || lastLine.getBoundingClientRect().bottom <= innerHeight - overlayInsets().bottom + 2;
}

// How much of the viewport the overlays cover right now: the top bar from
// above, the bottom bar and the player pill from below. Measured by position,
// not height, so the pill's margin from the edge counts.
function overlayInsets() {
  const shown = (sel) => {
    const e = $(sel);
    return e && getComputedStyle(e).display !== "none" ? e.getBoundingClientRect() : null;
  };
  const top = shown(".topbar");
  const bottoms = [shown(".botnav"), shown(".playerbar")].filter(Boolean);
  return {
    top: top ? top.bottom : 0,
    bottom: bottoms.length ? Math.max(...bottoms.map((r) => innerHeight - r.top)) : 0,
  };
}

function pageScroll(d) {
  // mid-open the placeholder has no size, which reads as "at the chapter
  // edge" — without this, every tap during a slow load chained another nav
  if (state.loading) return;
  // de-bounce: at most one turn per 150 ms — a second delivery of the same
  // gesture (a re-fired tap, a synthesized click that slipped a guard) is
  // absorbed instead of turning twice.
  const now = Date.now();
  if (now - lastPageTurn < 150) return;
  lastPageTurn = now;
  lastUserScroll = now; // pause the player's auto-follow, like a swipe
  if (d > 0 && chapterEndVisible()) return nav(1);
  if (d < 0 && scrollY <= 2) return nav(-1, "end");
  // Jumped to with no animation, so nothing glides to collide with the next input.
  scrollTo(0, Math.min(scrollEnd(), Math.max(0, pageTarget(d))));
}

function toggleToc() {
  const toc = $("#toc");
  if (!toc.hidden) { toc.hidden = true; return; }
  const items = state.manifest.chapters.map((c, i) =>
    el("button", {
      class: "toc-item" + (i === state.idx ? " current" : ""),
      onclick: () => { toc.hidden = true; openChapter(i, 0).then(() => flush()); },
    }, c.title));
  const filter = el("input", {
    type: "search", class: "toc-filter", placeholder: t("toc.filter"), autocomplete: "off",
    oninput: () => {
      const q = filter.value.trim().toLowerCase();
      items.forEach((b, i) => { b.hidden = !!q && !b.textContent.toLowerCase().includes(q); });
    },
  });
  toc.replaceChildren(
    el("div", { class: "toc-head" },
      el("strong", {}, t("ui.contents")),
      el("button", { class: "iconbtn", onclick: () => (toc.hidden = true) }, "✕")),
    el("div", { class: "toc-search" }, filter),
    el("div", { class: "toc-list" }, items),
  );
  toc.hidden = false;
  toc.querySelector(".current")?.scrollIntoView({ block: "center" });
  // a phone would pop the keyboard over the list
  if (matchMedia("(pointer: fine)").matches) filter.focus();
}

// ---------- bookmarks: several named places per book ----------
//
// The whole list is one LWW unit (same rule as settings): kept locally as
// {marks, ts, dirty} and pushed after each edit; syncMarks() reconciles once
// when a book opens. A mark is a chapter + char offset, so it survives any
// change of text size or line spacing.

const readMarks = (book) => {
  try {
    return JSON.parse(localStorage.getItem(`dogear_marks_${book}`)) ?? { marks: [], ts: 0, dirty: false };
  } catch {
    return { marks: [], ts: 0, dirty: false };
  }
};
const saveMarks = (book, rec) => {
  try { localStorage.setItem(`dogear_marks_${book}`, JSON.stringify(rec)); } catch { /* private mode */ }
};

let marksTimer = 0;

async function pushMarks(book) {
  clearTimeout(marksTimer);
  marksTimer = 0;
  const rec = readMarks(book);
  if (!rec.dirty) return;
  try {
    const res = await fetch("/api/bookmarks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ book, marks: rec.marks, updatedAt: rec.ts }),
    });
    if (res.status === 401) reauth();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // an edit made while the request was in flight stays dirty
    const now = readMarks(book);
    if (now.ts === rec.ts) saveMarks(book, { ...now, dirty: false });
  } catch {
    marksTimer = setTimeout(() => pushMarks(book), 15_000);
  }
}

async function syncMarks() {
  const book = state.id;
  let remote;
  try {
    const res = await fetch(`/api/bookmarks?book=${encodeURIComponent(book)}`, capped(4000));
    if (!res.ok) return;
    remote = await res.json();
  } catch { return; } // offline: keep the local list, reconcile next open
  const local = readMarks(book);
  if (remote.updatedAt > local.ts) saveMarks(book, { marks: remote.marks, ts: remote.updatedAt, dirty: false });
  else if (local.dirty) pushMarks(book);
}

function editMarks(fn) {
  const book = state.id;
  saveMarks(book, { marks: fn(readMarks(book).marks), ts: Date.now(), dirty: true });
  clearTimeout(marksTimer);
  marksTimer = setTimeout(() => pushMarks(book), 1500);
}

function addMark() {
  const file = state.manifest.chapters[state.idx].file;
  const label = (state.cache.get(file) ?? "").slice(state.off, state.off + 24).replace(/\s+/g, "");
  editMarks((marks) => [...marks, {
    id: crypto.randomUUID().slice(0, 8), chapter: state.idx, offset: state.off, label, createdAt: Date.now(),
  }]);
  renderMarks();
}

function renderMarks() {
  const panel = $("#marks");
  const marks = [...readMarks(state.id).marks].sort((a, b) => a.chapter - b.chapter || a.offset - b.offset);
  panel.replaceChildren(
    el("div", { class: "toc-head" },
      el("strong", {}, t("ui.marks")),
      el("button", { class: "iconbtn", onclick: () => (panel.hidden = true) }, "✕")),
    el("div", { class: "toc-list" },
      el("button", { class: "toc-item", onclick: addMark }, t("marks.add")),
      marks.map((m) => el("div", { class: "mark-row" },
        el("button", {
          class: "toc-item",
          onclick: () => { panel.hidden = true; openChapter(m.chapter, m.offset).then(() => flush()); },
        }, `${chapterTitle(m.chapter)} · ${m.label}`),
        el("button", {
          class: "iconbtn", title: t("marks.delete"),
          onclick: () => { editMarks((all) => all.filter((x) => x.id !== m.id)); renderMarks(); },
        }, "✕")))));
}

function toggleMarks() {
  const panel = $("#marks");
  if (!panel.hidden) { panel.hidden = true; return; }
  renderMarks();
  panel.hidden = false;
}
