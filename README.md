# dogear

私人小说阅读器。一个 Cloudflare Worker 加一个 WebDAV 账号：书、阅读进度、书签和设置都是 WebDAV 上的普通文件，手机和电脑打开同一个网址就能接着读。

支持 TXT 和 EPUB、行距调整、多个书签、在线和离线朗读（TTS）。阅读器前端和 TXT 分章逻辑来自 [enstw/bookworm](https://github.com/enstw/bookworm)（MIT，见 LICENSE）。

## WebDAV 里的目录

```
<DAV_ROOT>/books/<id>/manifest.json
<DAV_ROOT>/books/<id>/0000_<章名>.txt ...
<DAV_ROOT>/state/pos/<id>.json        阅读位置
<DAV_ROOT>/state/marks/<id>.json      书签
<DAV_ROOT>/state/settings.json        设置
```

## 本地开发

```
pnpm install
node scripts/dev-mock.mjs     # 内存 WebDAV + wrangler dev，访问密码 dev-key
node scripts/test-api.mjs     # Worker 测试
node scripts/test-epub.mjs    # EPUB 解析测试
```

用真实 WebDAV 开发：复制 `.dev.vars.example` 为 `.dev.vars` 并填写，`pnpm exec wrangler dev`。`node scripts/check-dav.mjs` 可以先检查 WebDAV 账号是否可用。

## 部署

```
pnpm run deploy
pnpm exec wrangler secret bulk .dev.vars
```

线上的密钥不会随 `deploy` 上传，`.dev.vars` 只给本地用。`secret bulk` 一次把 `.dev.vars` 里的 `READER_KEY`、`DAV_URL`、`DAV_USER`、`DAV_PASS`、`DAV_ROOT` 同步到线上。**换环境、换账号或改了密码后要重新跑这一条**，很容易忘。线上的 `READER_KEY` 请用足够长的随机串（`openssl rand -base64 24`），Worker 没有登录次数限制，它就是唯一的门。

首次在每台设备上打开网址时输入一次 `READER_KEY`。

## 添加书

在书架页脚点「上传书」，选择 TXT 或 EPUB，确认书名和作者后开始。文件在浏览器里解析、分章（Worker 没有这么长的运行时间），再逐章上传，最后写 manifest，所以传到一半的书不会出现在书架上。

- 上传期间不能关闭或离开页面，页面会提示，并尽量保持屏幕常亮。免费 WebDAV 写入慢（Koofr 每个文件 2 到 4 秒），一本近千章的书要约 30 分钟。
- 中断后重新上传即可：没有 manifest 的文件夹视为未完成，下次上传开始时会先清除超过 10 分钟的未完成文件夹；上传失败后点「重新上传」会先删掉自己已传的部分。没有做断点续传，清除重来更简单。

命令行也可以用（同样的解析和分章逻辑）：

```
node scripts/publish-book.mjs 书名.txt --title 书名 --author 作者
node scripts/publish-book.mjs 书名.epub
node scripts/publish-book.mjs --from-dav 书名.epub    # 文件已在 DAV_ROOT 下
```

## 离线朗读语音包

离线朗读用的语音包（约 139MB）由 `.github/workflows/voice-pack.yml` 构建并发布到本仓库的 `voice-pack` release，Worker 通过 `/api/wasmtts/*` 转发。使用前手动运行一次这个 workflow；没有这个 release 时离线朗读不可用，在线朗读不受影响。`wrangler.jsonc` 里 `WASMTTS_RELEASE` 的仓库名要和实际仓库一致。

## 已知限制

- 在线朗读用的是微软 Edge 的非官方接口（`src/edge-tts.js`），微软改过令牌算法，以后可能再失效。
- 书架冷启动要几秒（需要多次访问 WebDAV）。
- `workers.dev` 域名下没有 Cache API，服务端不缓存；章节靠浏览器和 service worker 缓存。
