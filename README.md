# Maia Coach（iOS 原生国际象棋教练 / 离线 PWA）

- **对手**：Maia-3（官方权重导出为 ONNX，可选 5M / 23M / 79M，等级分 0–2600，Maia 与玩家共用同一分数，低于 600 为模型外推；默认按胜负自动调整，设置中的分数作为初始分）。iOS App 使用 ONNX Runtime 原生推理与 CoreML 加速，网页版使用 `onnxruntime-web`。
- **教练**：Stockfish 19 完整 NNUE 版，iOS App 使用 C++ 原生多线程，网页版使用 WASM（支持跨源隔离时多线程）；可在设置中切换为小网络的轻量版（秒开、省内存）。
- **功能**：
  - 对弈：拟人化走子与思考时间、悔棋、提示（Stockfish 最佳着法 + 同等级人类常见着法）、教练模式（坏棋暂停讲解，可重走）。
  - 新手讲解：识别将杀、双将、捉双、牵制（含“保护者被牵制、不能回吃”）、串击、闪击、吃掉保护者、困子、杀棋威胁、白吃子、以小换大等战术，说明“问题在哪”和“更好的棋好在哪”；用静态交换评估（SEE）判断子是否真的保不住；只说引擎变化里真正兑现了的战术，弃子之后才出现的组合会讲成“接着 Nd7+：马捉双……”；评估用大白话（如“你大约多一个兵的优势”）；走出好棋会表扬；讲解里的变化可在棋盘上逐步演示（← → 或前进/后退按钮，Esc 结束）。
  - 战术识别准确率：`web/test/puzzle-bench.test.ts` 用 3061 道 Lichess 谜题（CC0，`node scripts/build-puzzles.mjs` 生成）统计每类的精确率和召回率，并设置下限防止退化。Lichess 的标签是程序打的、并不完备，所以精确率只是下限。
  - 棋钟：不限时或 3+2 / 5+3 / 10+5 / 15+10 / 30+20，含加秒、超时判负（对方子力不足以将杀时判和）、低时间提醒；Maia 会按剩余时间分配思考时间。
  - 规则：将死、逼和、三次重复、子力不足、50 回合，认输、提和（Maia 依据胜和负概率决定是否接受）。
  - 预走、走子 / 吃子 / 将军 / 易位 / 升变音效与震动反馈（可在设置中关闭）。默认使用“实木棋盘”音效（走子 / 吃子为 [Kenney](https://kenney.nl/assets/impact-sounds) 的 CC0 木头撞击录音，其余沿用 Lichess 音效），也可选 Lichess 的录制音效（音效 / 钢琴 / 8 位 / 未来四套，[Enigmahack](https://github.com/Enigmahack) 制作，AGPLv3+，见 [web/public/sounds](web/public/sounds/README.md)）或其他合成音色；对局结束按胜/负/和播放不同音效。
  - 复盘：胜率曲线、准确率、不精确 / 错误 / 漏着标注（按 Lichess 的胜率损失 5 / 10 / 15 个百分点分级）、更好的变化，以及“同水平棋手常走什么”；在棋盘上走子即可添加变着，可设为主线或删除。
  - PGN：导入 / 导出完整变着树、注释、NAG、`[%clk]` 用时和 `[%eval]` 评估；可从任意 PGN / FEN 局面或当前复盘局面开始与 Maia 对弈。
  - 历史与统计：已结束的对局自动保存（最多 300 局），可重新打开复盘；按执色、对手等级分统计胜和负与得分率。
  - 进入复盘自动分析整局，并对当前局面实时多线分析。
  - 等级分按表现计算：胜负占 70%，本局准确率（与该分段平均水平相比）占 30%；用了悔棋、提示、教练重走或教练标注时只减少加分、不减少扣分；走满 3 步后中途离开按认输计。
  - 谜题训练：内置 50000 道 [Lichess 谜题](https://database.lichess.org/#puzzles)（CC0，`node scripts/build-puzzle-db.mjs` 生成到 `web/public/puzzles/`），独立的谜题等级分；进入后先到类目页，可选综合练习或按题型（基础战术 / 进阶战术 / 将杀 / 对局阶段）练习，并根据等级分（谜题少于 20 题时用对局等级分）、各题型正确率和错题本里的错误类型推荐优先练的 3 个题型；网页版作为离线包下载，iOS App 内置。
  - 错题本：复盘分析完成后，自己的错误、错失良机和漏着自动收录并按错误类型归类（如“被对方捉双”“错过将杀”），间隔重复重练，连续答对 3 次算掌握；统计最常犯的错误及近 30 天趋势。
  - 数据备份：设置、等级分、历史、错题本、谜题进度导出为一个 JSON 文件（iOS 用系统分享面板，网页下载或分享），网页版与 App 互相导入，默认按 ID 合并去重；也可导出全部对局为 PGN。导入 PGN 支持多局文件。
- 首次加载后可**完全离线**使用：Service Worker 会缓存全部文件；每次构建会给 `sw.js` 注入新版本号，部署后自动清理旧文件，并在页面上提示“有新版本”。

## 目录

| 路径 | 说明 |
|---|---|
| `tools/export_onnx.py` | 把官方 PyTorch 权重导出为 ONNX，与原版逐一对比后切分到 `web/public/models/`（网页，fp32）和 `web/native-models/`（iOS App，fp16 + 固定 batch 1） |
| `tools/make_golden.py` | 用官方 Python 管线生成 `web/test/golden.json`，供 JS 端校验 |
| `web/` | PWA 源码（Vite + TypeScript） |
| `_maia3/`、`_ckpt/`、`_onnx/` | 官方仓库、原始权重、导出的 ONNX（仅用于导出和测试，不参与部署） |

## 本地电脑测试

```powershell
cd web
npm install
npm run dev        # 开发模式 http://localhost:5173
# 或使用生产构建：
npm run build
npm run preview    # http://localhost:4173
npm test           # 编码器 + 5M ONNX 与 PyTorch 一致性测试；设置 $env:ALL_MODELS=1 可测全部模型
```

dev/preview 服务器会发送 COOP/COEP 头，因此 Stockfish 和 ORT 可以使用多线程。设置面板里可以看到当前环境状态。

## 重新导出模型（可选）

```powershell
.venv\Scripts\python.exe tools\export_onnx.py                    # 网页版和 App 版都导出；--targets web / native 只导出其一
.venv\Scripts\python.exe tools\make_golden.py
```

App 版模型（`web/native-models/`）提交在仓库里，因为 CI 构建 iOS 时没有原始权重和 PyTorch。

## 安装到 iPhone（无需开发者账号）

PWA 和 Service Worker 要求 **HTTPS**（localhost 除外），手机访问电脑上的 `http://192.168.x.x` 时无法离线安装。推荐方式：

1. **GitHub Pages**
   - 推送到 GitHub 的 `main` 分支后，[deploy.yml](.github/workflows/deploy.yml) 会自动构建并部署（需在仓库 Settings → Pages → Source 选 **GitHub Actions**）。
   - 也可以手动把 `web/dist/` 的内容推送到 `gh-pages` 分支。
   - 单文件均小于 100MB，模型已分片，Stockfish wasm 约 95MB。
   - 部署后用 iPhone Safari 打开网址，点击“分享 → 添加到主屏幕”。
2. 其他任意 HTTPS 静态托管（Cloudflare Pages、Netlify 等）也可以。
3. 首次打开后，进入设置把需要的模型和 Stockfish 各使用一次，相关文件会被缓存；之后断网也能用。

说明：

- 静态托管通常不能设置 COOP/COEP 头。`sw.js` 会在响应中注入这两个头；首次接管尚未隔离的顶层主页时，页面最多自动刷新一次以启用多线程，不中断已进入的对局。网页版离线包在支持多线程时同时缓存当前 Stockfish 版本的单线程后备，避免多线程启动失败后无法离线使用。
- iPhone 首次启动时默认使用 **5M 模型 + 省内存模式 + Stockfish 轻量版**：轻量版足够小，两个引擎可同时常驻，不必反复重新加载；关闭轻量版后，省内存模式会在切换对弈/复盘时卸载另一个引擎。
- Maia 推理后端可选 WebGPU（模型已针对 WebGPU 导出，结果与 WASM 一致）；若 GPU 推理结果异常会自动回退到 WASM。
- 79M 模型（312MB）在 iPhone 上可能因内存不足被系统终止，请谨慎使用。
- iOS 可能清理长期未使用的 PWA 缓存，清理后联网打开一次即可恢复。

## 打包为 iOS App（免费 Apple ID 自签）

不需要 Mac 和付费开发者账号：由 GitHub Actions 的 macOS runner 编译未签名 IPA，再在 Windows 上签名安装。

1. 在 GitHub 仓库的 Actions 页面运行 **Build iOS (unsigned IPA)**（[ios.yml](.github/workflows/ios.yml)），也可以推送 `ios-v*` 标签触发。
2. 运行完成后下载 artifact `MaiaCoach-ipa`，解压得到 `MaiaCoach.ipa`。
3. 用 [Sideloadly](https://sideloadly.io/)（或 AltStore）连接 iPhone，使用自己的 Apple ID 签名并安装。
4. iPhone 上打开「设置 → 通用 → VPN 与设备管理」，信任该开发者；iOS 16 及以上还需开启「设置 → 隐私与安全性 → 开发者模式」。

说明：

- 免费 Apple ID 签名的 App **7 天后过期**，需要重新签名（棋局和设置保留）。AltStore 可以在同一 Wi-Fi 下自动续签。
- App 内的引擎**全部原生实现，不使用 WebAssembly**（[native-plugins/maia-native](web/native-plugins/maia-native)）：
  - **Stockfish 19**：C++ 源码直接编进 App（-O3 + ThinLTO），原生多线程 + ARM NEON/dotprod。**满血版**（完整 NNUE）和**轻量版**（小网络）都已预装，在「设置 → Stockfish 版本」中切换。默认 2 线程（性能核数量），避免发热。切换版本时旧实例的 Hash 缩至 1MB，重新启用时恢复设定值；进入后台由原生通知兜底停止搜索。
  - **Maia-3 5M / 23M / 79M**：ONNX Runtime iOS 原生推理。App 使用单独导出的 fp16、固定 batch 1 模型（共约 212MB，网页版 fp32 为 424MB），让 CoreML 能把整张图放到神经网络引擎上；不支持时回退到 CPU。首次加载某个模型时 CoreML 要编译一次，编译结果按模型内容缓存，App 更新后仍可复用，旧版本的缓存会自动清理。加载前会检查可用内存，不够时直接提示，而不是被系统强杀。
  - 全部预装，无需下载，完全离线可用；App 内没有下载按钮和离线包管理。「设置 → 环境信息」显示当前引擎的实际运行方式。
- App 的对弈界面与手机网页版一致：菜单在顶部，提示/悔棋/教练在“我”的信息栏里。点自己的头像（或「设置 → 我的头像」）可换成预设头像或相册照片。进入后台或音频中断时丢弃旧音效，恢复后不再集中补播；原生 Maia 推理失败后下一次请求会重建会话。
- 本地准备 iOS 工程：`cd web && npm run build:native`，依次执行构建、生成 `dist-native/`（[prepare-native.mjs](web/scripts/prepare-native.mjs)：去掉所有 wasm，下载并校验 NNUE 网络，拼接 `native-models/` 中的 ONNX 模型）、`cap sync ios`。Xcode 工程位于 `web/ios/`。
- 原生 Stockfish 可以脱离 Xcode 单独测试：`sh web/native-plugins/maia-native/stockfish/test/build_smoke.sh web/.cache/nnue`（CI 也会在 arm64 macOS 上跑这一步）。
- Stockfish 以 GPL-3.0 发布，源码见 [stockfish/](web/native-plugins/maia-native/stockfish)。
- 私有仓库使用 macOS runner 会按 10 倍分钟数计费，公开仓库免费。

## 许可证

本项目仅供个人使用，包含以下组件：

- Maia-3（CSSLab/maia3）：AGPL-3.0
- Stockfish 19 / stockfish.js：GPL-3.0
- chessground：GPL-3.0
- chess.js：BSD-2-Clause
- onnxruntime-web：MIT

如果要公开分发，需要遵守 AGPL/GPL：提供完整源码，并保留许可证声明。Maia-3 权重的许可证请以 Hugging Face 模型卡和官方仓库为准。
