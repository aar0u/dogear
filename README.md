# dogear

A private novel reader on one Cloudflare Worker. Books, reading positions,
settings and bookmarks are plain files on a WebDAV server. No D1, no R2.

The reader front end and the TXT chapter splitter come from
[enstw/bookworm](https://github.com/enstw/bookworm) (MIT, see LICENSE). The
storage layer, auth and the changes below are new.

## What differs from bookworm

- Storage is WebDAV (`src/dav.js`); the worker is `src/worker.js`.
- One shared reader key (`READER_KEY`) instead of per-reader keys.
- Horizontal layout by default; the vertical toggle button is gone.
- Text is shown as stored (no Simplified-to-Traditional conversion).
- Line spacing button (↕) and several named bookmarks per book (🔖), both synced.
- Font: LXGW WenKai, served in unicode-range slices from `public/fonts/wenkai/`.
- Removed: admin page, push notifications, online book sources, updater.

## WebDAV layout

```
<DAV_ROOT>/books/<id>/manifest.json
<DAV_ROOT>/books/<id>/0000_<title>.txt ...
<DAV_ROOT>/state/pos/<id>.json        reading position
<DAV_ROOT>/state/marks/<id>.json      bookmarks
<DAV_ROOT>/state/settings.json
```

## Local development

```
pnpm install
node scripts/dev-mock.mjs        # in-memory WebDAV + wrangler dev, key: dev-key
node scripts/test-api.mjs        # worker tests against the in-memory WebDAV
```

## Deploy

```
cp .dev.vars.example .dev.vars   # fill in the WebDAV account
pnpm run deploy
wrangler secret put READER_KEY
wrangler secret put DAV_URL
wrangler secret put DAV_USER
wrangler secret put DAV_PASS
wrangler secret put DAV_ROOT
node scripts/publish-book.mjs 书名.txt --title 书名 --author 作者
```

Open the site, enter `READER_KEY` once per device.

## Known gaps

- Online TTS uses Microsoft's unofficial Edge read-aloud endpoint
  (`src/edge-tts.js`, Sec-MS-GEC v2 token). Microsoft has changed the token
  before, so expect it to break again; offline TTS is the fallback. The token
  has a golden test in `scripts/test-api.mjs`, but that only proves it still
  matches the Python package, not that the server still accepts it.
- The offline voice pack is proxied from this repo's own `voice-pack` release
  (`WASMTTS_RELEASE` in `wrangler.jsonc`; the owner/repo in that URL is
  assumed to be `aar0u/dogear`). Run the `voice-pack` workflow once before
  using offline TTS. It builds the pack with `scripts/build-pack.mjs`, which
  fetches every file from its upstream source and checks size and SHA-256.
  Without the release, `/api/wasmtts/*` returns 404.
- UI strings are still Traditional Chinese (or English).
- `workers.dev` has no Cache API, so nothing is cached server side; chapter
  files are cached by the browser and the service worker.
