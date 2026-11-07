"use strict";

// UI strings for dogear, in Simplified Chinese (default) and English.
//
// Loaded as a classic script before app.js; player.mjs reads the same
// globals. Values are plain strings, or functions when a number or a name
// lands in the middle of the sentence — the two languages put them in
// different places, so the whole sentence is the unit of translation.
// The language is remembered per device (bw_lang) and does not sync.

const BW_DEFAULT_LANG = "zh";

// Gaps in the current language are filled from en, so a missing zh string
// shows up as an English phrase in the Chinese toolbar instead of a raw key.
const BW_FALLBACK_LANG = "en";

// KB/MB reads the same in both languages.
const bwBytes = (n) =>
  n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB`
    : n >= 1024 ? `${(n / 1024).toFixed(1)} KB`
      : `${n} bytes`;

const BW_STRINGS = {
  zh: {
    "lib.loading": "加载书目…",
    "lib.loadFail": (msg) => `无法加载书目（${msg}）。 `,
    "lib.retry": "重试",
    "lib.offlineList": "离线 — 显示上次看到的书目。 ",
    "lib.meta": (chapters, chars) =>
      `${chapters} 章 · ` + (chars >= 10000 ? `${Math.round(chars / 10000)} 万字` : `${chars} 字`),
    "lib.chapterN": (n) => `第 ${n} 章`,
    "lib.online": "在线",
    "lib.empty": "书架还是空的 — 用 node scripts/publish-book.mjs 书名.txt 上传。",
    "lib.offlineSave": "存到这台设备，没有网络也读得到",
    "lib.offlineSaved": (n) => `已存 ${n} 章 · 点按删除`,
    "lib.offlineFail": "下载失败 — 存离线内容需要网络连接。",
    "lib.continue": "续读",
    "lib.notStarted": "未开始",
    "lib.readPct": (pct) => `读到 ${pct}%`,
    "lib.readingAs": "当前身份 ",
    "lib.change": "更换密码",
    "lib.bookmarkHint": "进度、书签和设置保存在 WebDAV 上，所有设备自动同步。",
    "auth.need": "这是私人书房，输入访问密码才能开书。",
    "auth.bad": "密码不对。",
    "auth.placeholder": "访问密码",
    "auth.submit": "开门",
    "auth.hint": "访问密码就是部署时设置的 READER_KEY，每台设备输入一次。",
    "auth.changePrompt": "输入新的访问密码",
    "lib.installHint": "加入主屏幕",
    "guide.h": "加入主屏幕",
    "guide.why": "安装成 App 之后全屏打开、离线阅读更可靠，也才能收到新书通知。",
    "guide.ios1": "在 Safari 点底部的分享按钮（方框加向上箭头）。",
    "guide.ios2": "往下滑，选「加入主屏幕」，再按「加入」。",
    "guide.other1": "打开浏览器菜单（⋮）。",
    "guide.other2": "选「安装应用程序」或「加入主屏幕」。",
    "guide.done": "之后就从主屏幕打开 dogear。",
    "guide.continue": "先继续阅读",
    "update.available": (b) => `新版本已上线（${b}）。`,
    "update.reload": "立即更新",
    "update.whatsNew": "有什么新的",
    "update.hideNew": "收起来",
    "lib.build": (b) => `版本 ${b}`,
    "lib.relnotes": "版本记录",
    "lib.relnotesTitle": "历来更新对读者说了什么",
    "lib.relnotesNone": "没有可显示的版本记录。",
    "lib.refresh": "刷新",
    "lib.refreshTitle": "从服务器重新下载程序（保留离线章节）",
    "lib.refreshOffline": "目前看起来是离线 — 仍要刷新吗？",
    "lib.langSwitch": "English",
    "lib.langTitle": "切换界面语言",
    "push.label": "新书与更新通知：",
    "push.blocked": "通知已被封锁（在系统设置解除）",
    "push.subscribed": "已订阅 · 点按取消",
    "push.subscribe": "点按订阅",
    "push.test": "测试",
    "push.sending": "发送中…",
    "push.notSubscribed": "尚未订阅",
    "push.noRow": "服务器没有这个订阅，请重新订阅",
    "push.sent": (status) => `已送出 ${status}，通知应该几秒内出现`,
    "push.rejected": (status, detail) => `推播服务回 ${status} ${detail}`.trim(),
    "push.fail": (msg) => `失败：${msg}`,
    "push.noSW": "service worker 未注册",
    "push.noVapid": "服务器未设置推播",
    "err.badUrl": "网址不正确",
    "err.expected": "网址格式应为 /",
    "err.toLibrary": "回到书架",
    "err.backToLibrary": "← 回到书架",
    "reader.loading": "加载中…",
    "err.offlineTitle": "离线",
    "err.offlineBody": (slug) => `这台设备没有《${slug}》的离线内容。连着网络打开一次，或在书架上按 `,
    "err.offlineBodyTail": " 先存起来，之后没有网络也读得到。 ",
    "err.notFoundTitle": "找不到这本书",
    "err.notFoundBody": (slug) => `没有名为《${slug}》的书。 `,
    "err.chapterFail": (msg) => `章节加载失败（${msg}）。 `,
    "ui.library": "书架",
    "ui.contents": "目录",
    "ui.listen": "朗读",
    "ui.offlineCache": "离线缓存",
    "ui.smaller": "缩小字级",
    "ui.larger": "放大字级",
    "ui.wake": "保持屏幕恒亮",
    "ui.theme": "主题（自动／亮／暗）",
    "ui.bg": (name) => `背景颜色：${name}`,
    "ui.leading": (v) => `行距：${v} 倍`,
    "ui.marks": "书签",
    "marks.add": "＋ 在目前位置加书签",
    "marks.delete": "删除书签",
    "ui.next": "‹ 下一章",
    "ui.prev": "上一章 ›",
    "ui.close": "关闭",
    "sync.pending": "有改动待同步",
    "sync.sending": "同步中",
    "sync.ok": "已同步",
    "sync.err": "同步失败，稍后重试（进度已存在本机）",
    "ui.offlineOff": "离线缓存：关",
    "ui.offlineOn": (n) => `离线缓存：已存 ${n} 章`,
    "ui.offlineAuto": (n) => `自动缓存附近章节（已存 ${n} 章）· 点按保存完整范围`,
    "jump.synced": (here, there) => `已同步到「${here}」；此设备上次读到「${there}」`,
    "jump.back": "回到上次位置",
    "jump.remote": (there) => `另一台设备读到「${there}」`,
    "jump.go": "跳过去",
    "bg.default": "默认",
    "bg.light-brown": "浅褐",
    "bg.mid-brown": "中褐",
    "bg.gold-brown": "金褐",
    "bg.dark-brown": "深褐",
    "bg.snow-white": "雪白",
    "bg.pink": "粉红",
    "bg.light-orange": "淡橙",
    "bg.light-yellow": "淡黄",
    "bg.light-green": "淡绿",
    "bg.light-cyan": "浅青",
    "bg.light-blue": "浅蓝",
    "bg.light-purple": "浅紫",
    "bg.magenta": "紫红",
    "player.playPause": "播放／暂停",
    "player.back": "倒回一段",
    "player.forward": "快进一段",
    "player.stop": "结束朗读",
    "player.generating": "语音产生中…",
    "player.error": "语音失败 — 按 ▶ 重试",
    "player.chunk": (i, n) => `语音 ${i}/${n}`,
    "player.packStale": "离线语音包需要更新，暂时改用在线语音。",
    "player.packGo": (mb) => `重新下载（${mb}MB）`,
    "player.packOffer": "下载离线语音包，朗读就不需要网络。",
    "player.packGet": (mb) => `下载（${mb}MB）`,
    "player.packBusy": (pct) => `下载中 ${pct}%`,
    "player.packDone": "语音包已就绪，下次播放改用离线语音。",
    "player.packFail": "下载失败，可重试；已完成的部分不会重抓。",
    "player.engine": (pref) => `默认${pref}语音，另一个为备用；点按切换`,
    "player.rate": (r) => `朗读速度：${r} 倍（点按切换）`,
    "player.engGet": "⇣ 离线",
    "player.engGetTitle": "下载离线语音包后，朗读不需要网络",
    "player.engOnline": "在线",
    "player.engOffline": "离线",
    "player.fellBack": (to) => `改用${to}语音`,
  },
  en: {
    "lib.loading": "Loading books…",
    "lib.loadFail": (msg) => `Could not load the book list (${msg}). `,
    "lib.retry": "Retry",
    "lib.offlineList": "Offline — showing the last book list. ",
    "lib.meta": (chapters, chars) => `${chapters} chapters · ${Math.round(chars / 1000)}k chars`,
    "lib.chapterN": (n) => `Chapter ${n}`,
    "lib.online": "online",
    "lib.empty": "No books yet — upload one with node scripts/publish-book.mjs book.txt.",
    "lib.offlineSave": "Save on this device — reads without a connection",
    "lib.offlineSaved": (n) => `${n} chapters saved — tap to remove`,
    "lib.offlineFail": "Download failed — saving for offline needs a connection.",
    "lib.continue": "Continue",
    "lib.notStarted": "not started",
    "lib.readPct": (pct) => `${pct}% read`,
    "lib.readingAs": "Signed in as ",
    "lib.change": "Change password",
    "lib.bookmarkHint": "Positions, bookmarks and settings live on WebDAV and sync across all devices.",
    "auth.need": "This is a private library. Enter the access password to open books.",
    "auth.bad": "Wrong password.",
    "auth.placeholder": "Access password",
    "auth.submit": "Unlock",
    "auth.hint": "The password is the READER_KEY set at deploy time. Enter it once per device.",
    "auth.changePrompt": "Enter the new access password",
    "lib.installHint": "Add to Home Screen",
    "guide.h": "Add to Home Screen",
    "guide.why": "Installed as an app, dogear opens full-screen, keeps offline reading reliable, and can receive new-book alerts.",
    "guide.ios1": "In Safari, tap the Share button at the bottom (the square with an upward arrow).",
    "guide.ios2": "Scroll down, choose “Add to Home Screen”, then tap “Add”.",
    "guide.other1": "Open the browser menu (⋮).",
    "guide.other2": "Choose “Install app” or “Add to Home Screen”.",
    "guide.done": "From then on, open dogear from your Home Screen.",
    "guide.continue": "Keep reading for now",
    "update.available": (b) => `A new version is live (${b}).`,
    "update.reload": "Update now",
    "update.whatsNew": "What's new",
    "update.hideNew": "Hide",
    "lib.build": (b) => `build ${b}`,
    "lib.relnotes": "release notes",
    "lib.relnotesTitle": "What past updates said to readers",
    "lib.relnotesNone": "No release notes to show.",
    "lib.refresh": "refresh",
    "lib.refreshTitle": "Re-download the app from the server (keeps offline chapters)",
    "lib.refreshOffline": "You look offline — refresh anyway?",
    "lib.langSwitch": "中文",
    "lib.langTitle": "Switch interface language",
    "push.label": "New-book & update alerts: ",
    "push.blocked": "Blocked — allow notifications in system settings",
    "push.subscribed": "Subscribed · tap to stop",
    "push.subscribe": "Tap to subscribe",
    "push.test": "Test",
    "push.sending": "Sending…",
    "push.notSubscribed": "Not subscribed yet",
    "push.noRow": "The server has no such subscription — subscribe again",
    "push.sent": (status) => `Sent ${status} — the notification should arrive within seconds`,
    "push.rejected": (status, detail) => `Push service replied ${status} ${detail}`.trim(),
    "push.fail": (msg) => `Failed: ${msg}`,
    "push.noSW": "service worker not registered",
    "push.noVapid": "the server has no push key configured",
    "err.badUrl": "Invalid URL",
    "err.expected": "Expected /",
    "err.toLibrary": "go to the library",
    "err.backToLibrary": "← back to the library",
    "reader.loading": "Loading…",
    "err.offlineTitle": "Offline",
    "err.offlineBody": (slug) => `“${slug}” isn't cached on this device. Open it online once, or tap `,
    "err.offlineBodyTail": " on the shelf to save it first, and it will read without a connection. ",
    "err.notFoundTitle": "Book not found",
    "err.notFoundBody": (slug) => `There is no book called “${slug}”. `,
    "err.chapterFail": (msg) => `Failed to load chapter (${msg}). `,
    "ui.library": "Library",
    "ui.contents": "Contents",
    "ui.listen": "Listen",
    "ui.offlineCache": "Offline cache",
    "ui.smaller": "Smaller text",
    "ui.larger": "Larger text",
    "ui.wake": "Keep the screen awake",
    "ui.theme": "Theme (auto/light/dark)",
    "ui.bg": (name) => `Paper colour: ${name}`,
    "ui.leading": (v) => `Line spacing: ${v}×`,
    "ui.marks": "Bookmarks",
    "marks.add": "+ Bookmark this spot",
    "marks.delete": "Delete bookmark",
    "ui.next": "‹ Next",
    "ui.prev": "Prev ›",
    "ui.close": "Close",
    "sync.pending": "Changes waiting to sync",
    "sync.sending": "Syncing",
    "sync.ok": "Synced",
    "sync.err": "Sync failed, retrying (progress is saved on this device)",
    "ui.offlineOff": "Offline cache off",
    "ui.offlineOn": (n) => `Offline cache on — ${n} chapters stored`,
    "ui.offlineAuto": (n) => `Auto-caching nearby chapters (${n} stored) — tap to keep the full window`,
    "jump.synced": (here, there) => `Synced to “${here}”; this device last read “${there}”`,
    "jump.back": "Back to where I was",
    "jump.remote": (there) => `Another device is reading “${there}”`,
    "jump.go": "Go there",
    "bg.default": "Default",
    "bg.light-brown": "Light brown",
    "bg.mid-brown": "Mid brown",
    "bg.gold-brown": "Gold brown",
    "bg.dark-brown": "Dark brown",
    "bg.snow-white": "Snow white",
    "bg.pink": "Pink",
    "bg.light-orange": "Light orange",
    "bg.light-yellow": "Light yellow",
    "bg.light-green": "Light green",
    "bg.light-cyan": "Light cyan",
    "bg.light-blue": "Light blue",
    "bg.light-purple": "Light purple",
    "bg.magenta": "Magenta",
    "player.playPause": "Play / pause",
    "player.back": "Back one chunk",
    "player.forward": "Forward one chunk",
    "player.stop": "Stop listening",
    "player.generating": "Generating audio…",
    "player.error": "Audio failed — ▶ retries",
    "player.chunk": (i, n) => `audio ${i}/${n}`,
    "player.packStale": "The offline voice pack needs an update; using the online voice for now.",
    "player.packGo": (mb) => `Re-download (${mb} MB)`,
    "player.packOffer": "Download the offline voice pack to listen without the network.",
    "player.packGet": (mb) => `Download (${mb} MB)`,
    "player.packBusy": (pct) => `Downloading ${pct}%`,
    "player.packDone": "Voice pack ready; the next playback uses the offline voice.",
    "player.packFail": "Download failed — a retry keeps what already landed.",
    "player.engine": (pref) => `Default voice: ${pref}; the other is the fallback. Tap to switch`,
    "player.rate": (r) => `Speaking speed: ${r}× (tap to change)`,
    "player.engGet": "⇣ Offline",
    "player.engGetTitle": "Download the offline voice pack to listen without the network",
    "player.engOnline": "online",
    "player.engOffline": "offline",
    "player.fellBack": (to) => `Switched to the ${to} voice`,
  },
};

function bwLang() {
  const v = localStorage.getItem("bw_lang");
  return v && BW_STRINGS[v] ? v : BW_DEFAULT_LANG;
}

function bwOtherLang() {
  return bwLang() === "zh" ? "en" : "zh";
}

// The document language is not cosmetic: it picks the CJK font fallback when
// the web font misses a glyph, and on iOS it decides which dictionary a
// long-press lookup opens.
function bwApplyLang() {
  document.documentElement.lang = bwLang() === "zh" ? "zh-Hans" : "en";
}

function bwSetLang(v) {
  try { localStorage.setItem("bw_lang", v); } catch { /* private mode: this session only */ }
  bwApplyLang();
}

// Missing key → the en string → the key itself, so a half-finished
// translation degrades to something readable instead of blank chrome, and
// stays visible while it does (see BW_FALLBACK_LANG).
function t(key, ...args) {
  const v = BW_STRINGS[bwLang()]?.[key] ?? BW_STRINGS[BW_FALLBACK_LANG][key] ?? key;
  return typeof v === "function" ? v(...args) : v;
}

// One pass over static markup: every [data-i18n] node takes its text from
// the table, [data-i18n-title] its tooltip — so a page ships readable zh
// in its HTML and a language switch re-sweeps in place instead of
// re-rendering (or, on the shelf, re-fetching). Strings with arguments
// stay JS-filled; textContent assignment is also why decorated nodes keep
// their decoration in CSS (see .brand::before), never in child elements.
function applyI18n() {
  for (const node of document.querySelectorAll("[data-i18n]"))
    node.textContent = t(node.dataset.i18n);
  for (const node of document.querySelectorAll("[data-i18n-title]"))
    node.title = t(node.dataset.i18nTitle);
}

bwApplyLang();
