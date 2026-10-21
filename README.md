# Maia 教练（离线国际象棋 PWA）

- **对手**：Maia-3（官方权重导出为 ONNX，可选 5M / 23M / 79M，等级分 0–2600，Maia 与玩家共用同一分数，低于 600 为模型外推），用 `onnxruntime-web` 在浏览器中推理。
- **教练**：Stockfish 19 完整 NNUE 版（WASM，支持跨源隔离时多线程）。
- **功能**：
  - 对弈：拟人化走子与思考时间、悔棋、提示（Stockfish 最佳着法 + 同等级人类常见着法）、教练模式（坏棋暂停讲解，可重走）。
  - 棋钟：不限时或 3+2 / 5+3 / 10+5 / 15+10 / 30+20，含加秒、超时判负（对方子力不足以将杀时判和）、低时间提醒；Maia 会按剩余时间分配思考时间。
  - 规则：将死、逼和、三次重复、子力不足、50 回合，认输、提和（Maia 依据胜和负概率决定是否接受）。
  - 预走、走子 / 吃子 / 将军 / 易位 / 升变音效与震动反馈（可在设置中关闭）。
  - 复盘：胜率曲线、准确率、不精确 / 错误 / 漏着标注、更好的变化，以及“同水平棋手常走什么”；在棋盘上走子即可添加变着，可设为主线或删除。
  - PGN：导入 / 导出完整变着树、注释、NAG、`[%clk]` 用时和 `[%eval]` 评估；可从任意 PGN / FEN 局面或当前复盘局面开始与 Maia 对弈。
  - 历史与统计：已结束的对局自动保存（最多 300 局），可重新打开复盘；按执色、对手等级分统计胜和负与得分率。
  - 进入复盘自动分析整局，并对当前局面实时多线分析。
- 首次加载后可**完全离线**使用：Service Worker 会缓存全部文件；每次构建会给 `sw.js` 注入新版本号，部署后自动清理旧文件，并在页面上提示“有新版本”。

## 目录

| 路径 | 说明 |
|---|---|
| `tools/export_onnx.py` | 把官方 PyTorch 权重导出为 ONNX，与原版逐一对比后切分到 `web/public/models/` |
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
.venv\Scripts\python.exe tools\export_onnx.py
.venv\Scripts\python.exe tools\make_golden.py
```

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

- 静态托管通常不能设置 COOP/COEP 头。`sw.js` 会在响应中注入这两个头，首次访问时页面会自动刷新一次，以启用多线程。
- iPhone 首次启动时默认使用 **5M 模型 + 省内存模式**：切换对弈/复盘时会卸载另一个引擎。
- 79M 模型（312MB）在 iPhone 上可能因内存不足被系统终止，请谨慎使用。
- iOS 可能清理长期未使用的 PWA 缓存，清理后联网打开一次即可恢复。

## 许可证

本项目仅供个人使用，包含以下组件：

- Maia-3（CSSLab/maia3）：AGPL-3.0
- Stockfish 19 / stockfish.js：GPL-3.0
- chessground：GPL-3.0
- chess.js：BSD-2-Clause
- onnxruntime-web：MIT

如果要公开分发，需要遵守 AGPL/GPL：提供完整源码，并保留许可证声明。Maia-3 权重的许可证请以 Hugging Face 模型卡和官方仓库为准。
