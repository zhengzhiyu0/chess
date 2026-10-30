# Maia Coach（iOS 原生国际象棋教练 / 离线 PWA）

- **对手**：Maia-3（官方权重导出为 ONNX，可选 5M / 23M / 79M，难度参数 0–2600，与玩家棋力估计分开；低于 600 为模型外推）。无辅助正式局结束后自动匹配下一局难度，辅助对局只计入练习记录。iOS App 使用预编译 CoreML MLProgram 原生推理，网页版使用 `onnxruntime-web`。
- **教练**：Stockfish 19 完整 NNUE 版，iOS App 使用 C++ 原生多线程，网页版使用 WASM（支持跨源隔离时多线程）；可在设置中切换为小网络的轻量版（秒开、省内存）。
- **功能**：
  - 启动 iOS App / PWA 后自动在后台加载当前设置的引擎；进入新对局、继续对局或复盘时，若所需引擎尚未就绪，显示简洁的 SVG 等待动画，加载完成后自动进入。等待期间棋钟暂停，加载失败可重试。
  - 对弈：只保留一种对局，默认纯净，不因坏棋暂停或弹出教学卡片；拟人化走子与思考时间、悔棋和按需提示仍可使用。首页和局中“对局辅助”可独立开关横向评估条、获胜机会百分比、对手威胁、悬子标记和最佳着法；辅助后台分析不等待用户确认讲解，莉亚文字反馈默认关闭。
  - 对局布局：棋盘与开局 / 着法条保留 10px 间隙，走棋提示靠左且垂直居中；棋盘位置由视口和棋盘尺寸决定，气泡出现、换行和消失不会挤动棋盘，长提示在下方区域滚动。吃子图标为 24px。
  - 箭头提示：普通落子不自动播放威胁 / 保护箭头或逐格铺色特效。“对手威胁”红箭头和“最佳着法”绿箭头由独立开关控制，可同时显示；按棋子路径静态绘制，马使用 L 型路径，支持棋盘翻转与缩放。横向评估条在棋盘上方，白方纯白、黑方深灰（避免与纯黑背景融合），两段按比例填满，数字透明叠加，始终按白方视角显示；获胜机会百分比按用户执色显示，为引擎估算而非实战预测。
  - 赛后讲解：识别将杀、双将、捉双、牵制、串击、闪击、吃掉保护者、困子、杀棋威胁、白吃子、以小换大等战术，用静态交换评估（SEE）和引擎变化说明问题及更好的选择；自动回顾每次只讲一个问题，完整变化演示和人类着法比较保留在自由复盘中。
  - 战术识别准确率：`web/test/puzzle-bench.test.ts` 用 3061 道 Lichess 谜题（CC0，`node scripts/build-puzzles.mjs` 生成）统计每类的精确率和召回率，并设置下限防止退化。Lichess 的标签是程序打的、并不完备，所以精确率只是下限。
  - 棋钟：不限时或 3+2 / 5+3 / 10+5 / 15+10 / 30+20，含加秒、超时判负（对方子力不足以将杀时判和）、低时间提醒；Maia 会按剩余时间分配思考时间。
  - 规则：将死、逼和、三次重复、子力不足、50 回合，认输、提和（Maia 依据胜和负概率决定是否接受）。
  - 预走、走子 / 吃子 / 将军 / 易位 / 升变音效与震动反馈（可在设置中关闭）。全部使用成品 MP3：默认“实木棋盘”，另有“轻柔木质 / 柔和落子 / 清脆玻璃”（走子 / 吃子为 [Kenney](https://kenney.nl/assets/impact-sounds) 的 CC0 碰撞录音，其余沿用 Lichess 音效），以及 Lichess 的音效 / 钢琴 / 8 位 / 未来四套（[Enigmahack](https://github.com/Enigmahack) 制作，AGPLv3+，见 [web/public/sounds](web/public/sounds/README.md)）。设置中选择即可试听，旧合成主题自动迁移到对应的录音；对局结束按胜/负/和播放不同音效。
  - 复盘：赛后点击“复盘这局”自动分析整局，从棋局开头按主线播放；普通着法会逐渐加快，所有关键失误在进度条上标记，并在关键着法处停下，直接指出漏掉了什么和更好的选择。点击“查看更好走法”后演示替代着法，再点击“下一个亮点”继续；不要求用户猜答案。可暂停、调速或退出到自由查看；完整报告仍含胜率曲线、准确率、不精确 / 错误 / 漏着标注、更好的变化，以及“同水平棋手常走什么”。
  - PGN：导入 / 导出完整变着树、注释、NAG、`[%clk]` 用时和 `[%eval]` 评估；可从任意 PGN / FEN 局面或当前复盘局面开始与 Maia 对弈。
  - 历史与统计：已结束的对局自动保存（最多 300 局），可重新打开复盘；按执色、对手等级分统计胜和负与得分率。
  - 进入复盘自动分析整局，并对当前局面实时多线分析。
  - 自适应棋力：评级只看胜和负及本局对手分，赛后立即结算，不受准确率、复盘进度或离线分析影响；新玩家快速定位，稳定后降低波动，连续胜负时重新定位。辅助开关、提示、悔棋及局中分析不改变评级；无辅助正式局自己走满 3 步后中途离开按认输计，不额外加罚。
  - 谜题训练：内置 50000 道 [Lichess 谜题](https://database.lichess.org/#puzzles)（CC0，`node scripts/build-puzzle-db.mjs` 生成到 `web/public/puzzles/`），独立的谜题等级分；进入后先到类目页，可选综合练习或按题型（基础战术 / 进阶战术 / 将杀 / 对局阶段）练习，并根据等级分（谜题少于 20 题时用对局等级分）、各题型正确率和错题本里的错误类型推荐优先练的 3 个题型；网页版作为离线包下载，iOS App 内置。
  - 错题本与训练闭环：复盘分析完成后，自己的错误、错失良机和漏着自动收录并按错误类型归类（如“被对方捉双”“错过将杀”），间隔重复重练，连续答对 3 次算掌握；赛后本地总结最多列出 3 个重点问题，关联错误类型、错题重练和对应题型谜题，并给出值得保留的好棋、下一次检查点与近 30 天训练建议。练习结果更新错题掌握度；统计最常犯的错误及趋势。
  - 数据备份：设置、等级分、历史、错题本、谜题进度导出为一个 JSON 文件（iOS 用系统分享面板，网页下载或分享），网页版与 App 互相导入，默认按 ID 合并去重；也可导出全部对局为 PGN。导入 PGN 支持多局文件。
- 首次加载后可**完全离线**使用：Service Worker 会缓存全部文件；每次构建会给 `sw.js` 注入新版本号，部署后自动清理旧文件，并在页面上提示“有新版本”。

## 自适应棋力与对手难度

- **两个数值**：`playerElo` 是玩家的本地棋力估计，`elo` 是下一局 Maia 的难度参数。首页可独立调整对手；设置中修改棋力起点会重新定位，但保留累计计分局数。有未完成对局时也可修改，当前棋局保留原快照，旧局结算不覆盖新起点。训练推荐使用玩家棋力，不再随对手滑块变化。
- **评级模型**：采用单局 Glicko-1 更新的简化模型，将 Maia 参数视为固定对手分（对手 RD 为 0）。预期得分率为 `1 / (1 + 10 ** ((对手分 - 玩家分) / 400))`，用实际结果减去预期得分率更新玩家分；和棋记 0.5。评级不确定度 RD 为 60–350，初始 350，RD 越大定位越快；连续 3 局及以上同向结果时，计算 RD 至少恢复到 180，以适应持续偏离当前估计的表现，和棋或反向结果结束原连胜负。
- **难度控制**：下一局向新玩家分靠拢，连续结果可额外偏移至多 60 分。计算 RD 大于 150 时每局最多移动 160 分，否则最多 80 分；不会输棋后反而升难，也不会赢棋后反而降难。玩家分与对手参数均限制在 0–2600。
- **整局锁定**：开局保存双方分数、RD、连续结果、计分开关、Maia 模型与随机性；局中及返回首页修改这些设置不改变当前局，续局也使用原快照。赛后说明展示玩家变化、本局对手、预期得分率与下一局难度；PGN 分别导出双方分数。
- **辅助练习**：在新局启用辅助，或局中保存任何已开启的辅助开关，本局转为不计分练习；面板会明确说明，关闭辅助也不会恢复本局计分。提示、悔棋及局中分析前另行确认。辅助结果不更新分数、RD、连续结果、累计计分局数或下一局难度；导入棋谱及非标准起始局面同样不计分。这是本地练习工具，不是防刷分的联网竞技系统。
- **旧数据与备份**：旧共用分数迁移为玩家与对手各自的起点，保留累计局数，并据此初始化 RD。旧教练模式的辅助开关迁成独立开关，旧普通局的休眠教练设置不会开启辅助；旧教练局保留辅助资格、重走次数合并到悔棋，暂停教学状态不再恢复。历史已结算的分数变化保留；旧版待分析结算不补算，避免重复计分。备份合并按较多计分局数的一侧整体同步评级状态。
- **参考与边界**：多邻国公开资料确认了[奥斯卡使用可按棋力参数控制的类人模型](https://blog.duolingo.com/engineering-game-review/)及[按结果、相对实力更新 Elo](https://blog.duolingo.com/what-is-an-elo-rating-in-chess/)，未公开完整自动调难公式。上述重定位和难度控制是本项目的设计，不是奥斯卡私有算法的复刻；本地棋力估计也不等同于 FIDE、Lichess 或 Duolingo 等级分，Maia 参数未按这些平台重新标定。

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
3. 首次打开后会自动加载当前设置的模型和 Stockfish，并下载离线包；离线包就绪后即可断网使用。

说明：

- 静态托管通常不能设置 COOP/COEP 头。`sw.js` 会在响应中注入这两个头；首次接管尚未隔离的顶层主页时，页面最多自动刷新一次以启用多线程，不中断已进入的对局。网页版离线包在支持多线程时同时缓存当前 Stockfish 版本的单线程后备，避免多线程启动失败后无法离线使用。
- iPhone 首次启动时默认使用 **5M 模型 + 省内存模式 + Stockfish 轻量版**：轻量版足够小，两个引擎可同时常驻，不必反复重新加载；关闭轻量版后，省内存模式会在切换对弈/复盘时卸载另一个引擎。
- Maia 推理后端可选 WebGPU（模型已针对 WebGPU 导出，结果与 WASM 一致）；若 GPU 推理结果异常会自动回退到 WASM。
- 79M 模型（312MB）在 iPhone 上可能因内存不足被系统终止，请谨慎使用。
- iOS 可能清理长期未使用的 PWA 缓存，清理后联网打开一次即可恢复。

## 打包为 iOS App（iOS 17+，免费 Apple ID 自签）

不需要 Mac 和付费开发者账号：由 GitHub Actions 的 macOS runner 编译未签名 IPA，再在 Windows 上签名安装。

1. 在 GitHub 仓库的 Actions 页面运行 **Build iOS (unsigned IPA)**（[ios.yml](.github/workflows/ios.yml)），也可以推送 `ios-v*` 标签触发。
2. 运行完成后下载 artifact `MaiaCoach-ipa`，解压得到 `MaiaCoach.ipa`。
3. 用 [Sideloadly](https://sideloadly.io/)（或 AltStore）连接 iPhone，使用自己的 Apple ID 签名并安装。
4. iPhone 上打开「设置 → 通用 → VPN 与设备管理」，信任该开发者；iOS 17 及以上还需开启「设置 → 隐私与安全性 → 开发者模式」。

说明：

- 免费 Apple ID 签名的 App **7 天后过期**，需要重新签名（棋局和设置保留）。AltStore 可以在同一 Wi-Fi 下自动续签。
- App 内的引擎**全部原生实现，不使用 WebAssembly**（[native-plugins/maia-native](web/native-plugins/maia-native)）：
  - **Stockfish 19**：C++ 源码直接编进 App（-O3 + ThinLTO），原生多线程 + ARM NEON/dotprod。**满血版**（完整 NNUE）和**轻量版**（小网络）都已预装，在「设置 → Stockfish 版本」中切换。默认 2 线程（性能核数量），避免发热。切换版本时旧实例的 Hash 缩至 1MB，重新启用时恢复设定值；进入后台由原生通知兜底停止搜索。
  - **Maia-3 5M / 23M / 79M**：CoreML 原生推理，预装 INT8 权重量化、fp16 计算的 `.mlmodelc`。CI 从固定 batch 1 的 native ONNX 转换模型：将 Constant 提为 initializer、把 GAB 的 Einsum 等价展开为矩阵乘法，并统一 MIL 编写精度以避免 LayerNorm 类型冲突。编译后的实际模型须通过 7 个现有棋局样本的 ONNX 对照（合法走法概率和胜和负概率最大误差均不超过 0.02），通过后才进入 App bundle；iOS 不再依赖 ONNX Runtime，也不再生成或清理 ORT 模型缓存。
  - **关键事件文字提示**：普通对弈中由莉亚头像显示简短的战术和棋力反馈；其他教练头像资源保留在项目内，当前不参与选择或运行时逻辑。
  - 全部预装，无需下载，完全离线可用；App 内没有下载按钮和离线包管理。「设置 → 环境信息」显示当前引擎的实际运行方式。
- App 的对弈界面与手机网页版一致：菜单在顶部，提示/悔棋/教练在“我”的信息栏里。点自己的头像（或「设置 → 我的头像」）可换成预设头像或相册照片。iOS 音效由 AVAudioPlayer 直接播放内置 MP3，通过应用内音效开关控制，使用媒体音量，允许与其他应用音频混音；每次播放重新激活音频会话，进入后台或被电话中断时停止旧声音，回来后只播放新事件。70 毫秒内的重复落子音效会被过滤。
- 本地准备 iOS 工程：`cd web && npm run build:native`，依次执行构建、生成 `dist-native/`（[prepare-native.mjs](web/scripts/prepare-native.mjs)：去掉所有 wasm，下载并校验 NNUE 网络，拼接 `native-models/` 中的 ONNX 中间文件）、`cap sync ios`；随后在 macOS 按 [ios.yml](.github/workflows/ios.yml) 安装 Python 转换依赖，执行 `python scripts/compile-coreml.py`，完成模型转换、量化、编译和数值对照，再用 Xcode 构建。编译产物按源 ONNX 内容缓存，最终 bundle 不保留 Maia ONNX。Xcode 工程位于 `web/ios/`。
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
