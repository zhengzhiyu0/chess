# chess 项目记忆

- 语言：中文思考、中文回答（继承 `~/.dsh/AGENTS.md`）。
- 2026-11：修复兵升变选择框看不见棋子。原因：`web/src/style.css` 末尾 `@layer button-contract` 对所有 `button` 使用 `background: var(--panel2) !important`，覆盖了 `askPromotion()` 内联设置的 `background-image`，按钮只剩底色。改为在按钮内用 `<img>` 渲染棋子（`web/src/main.ts`），样式见 `.promo button img`；同时 `#dlg-promo` 宽度由 `auto` 改为 `fit-content`，避免弹窗被拉伸到整屏宽。
- 本地验证：`node node_modules/vite/bin/vite.js` 起 dev server，Playwright 走「开始对局 → 菜单 → 导入 FEN `8/P7/8/8/8/8/8/k6K w - - 0 1` → a7-a8」确认四个升变选项图标可见、选后 `a8=Q+` 正常。
- 2026-11：修复浅色模式对局底部工具栏仍是黑色。`.toolbar` 原先硬编码 `background: #000` / 白色边框；改为 `var(--bg)` 与 `var(--line)`，随 `html[data-theme='light']` 切换。浅色模式设为浅色偏好保存在 settings.theme。
- 2026-11：切后台耗电修复。`main.ts` 的棋钟 100ms `setInterval` 改为按需启停（`syncClockTimer`，仅 `!document.hidden && clock.active`）；后台/前台逻辑收敛到 `enterBackground()` / `leaveBackground()`（`bind()` 里的 `visibilitychange`），另绑 `pagehide`/`pageshow` 兜底 WKWebView 不派发 visibilitychange 的情况。要点：
  - 进入后台立即 `gameToken++`、`maiaThinking=false`、`resetAids()`、abort live/batch，但 Maia 只延迟 10s 才 `unloadMaia()`——短暂切后台不重载模型。
  - 回前台若 `gameLoading` 或引擎未就绪则 `resumeGame()` 重试；之前直接卸载会让进行中的加载 superseded，UI 卡在“引擎暂时未能就绪”。
  - `maia.ts` 的 `watch()` 在 hidden 时挂起到可见再检查，不再递归 setTimeout，也不丢检查。
  - `native.ts` 热状态轮询改为可取消的 setTimeout 链 + 5s 超时，避免 bridge 挂死让 `polling` 永久为 true。
  - `hint()` 增加 AbortController（`hintCtrl`，由 `resetAids()` 统一 abort），切后台/走子会中止搜索并清空“思考中…”。
  - 回归：`web/tmp-audit-final.mjs`（临时脚本已删）用 Playwright + 伪造 `document.hidden` 验证了 11 项：加载中切后台自动恢复、时钟暂停/恢复、短暂后台不重载、长后台释放重载、提示取消。以后改动后台逻辑建议复用这套脚本。
- 2026-11：去掉 iOS 上不需要的系统权限。
  - 「照片」权限来自「我的头像 → 从相册选择照片」：`web/index.html` 里的 `#avatar-file`（`<input type=file accept="image/*">`）在 WKWebView 里会申请相册访问。已删除该按钮和 input，`openAvatar()` 只保留预设头像，`avatarFromFile()` 一并删除；`avatarParts()` 仍识别旧的 `data:image/...` 头像，老备份导入后还能正常显示。
  - `web/ios/App/App/Info.plist` 从未声明过 `NSPhotoLibraryUsageDescription` / `NSLocalNetworkUsageDescription` / `NSAppTransportSecurity`，全部 git 历史确认；工程内也没有任何联网代码（无 fetch 外链、无 WebSocket、Capacitor 未启用 CapacitorHttp），所以「网络」权限没有可删的声明。系统设置里的权限残留需删除 App 后重装才会消失。
  - 验证：`tsc --noEmit`、`vitest run`（274 passed）、`npm run build`、Playwright(WebKit) 打开「设置 → 我的头像」确认 16 个预设、无相册按钮、无 `input[type=file][accept*=image]`。
- 2026-11：对局界面新增“开局：名称（ECO）”显示。
  - 数据：`web/scripts/build-book.mjs` 从 Lichess chess-openings（CC0）生成 `web/src/coach/book-data.ts`，格式 `{ data, ids, names }`；`data` 是升序的 base36 哈希，`ids` 与 `data` 同序、指向 `names` 下标（base36，空串表示无名称），`names` 为 `ECO\t名称`。构建固定 `scripts/data/openings/manifest.json` 的 commit 并校验 SHA-256。**每个局面按“终点线优先、较短线优先”取名**：每条 TSV 行的终点才是名称定义的局面，否则 `1.e4` 会被标成 Tennison Gambit（A06）这类深层变例的中途局面。生成结果约 267 KB / gzip 78 KB（动态 chunk）。
  - 识别：`web/src/coach/book.ts` 的 `openingOf(fen)` / `identifyOpening(fens)`；界面用 `main.ts` 的 `openingAt(node)` 沿当前节点向上找最近命中，因此走出开局库后仍保留最近的开局名。
  - 中文名：`web/src/coach/opening-zh.ts` 按冒号/逗号前的基础名翻译了 150 个 family（`Ruy Lopez` → 西班牙开局），子变例保留英文，避免专名机器直译出错；界面显示 `开局：西班牙开局（C60）`，英文原名与具体变例放在 `title`。
  - 踩坑：`.opening-info` 的 `min-height: 22px` 如果随识别结果显隐，会让棋盘列突然变高——竖屏把两个玩家栏顶上移 22px，宽屏在 1280×800 下直接顶出 appbar。现改为始终占位（不再切 `hidden`），并把 22px 计入 `style.css` 四处 `--board-size`（竖屏 play / review、宽屏 play / review）。
  - 验证：`tsc --noEmit`、`vitest run`（276 passed / 28 skipped）、`npm run build`；Playwright 在 390×844 与 1280×800 下量过 `#opening-info` 写入前后 `.board-col` / `#board` / `#player-top` 的 rect 完全一致。

