# Maia 拟人行为评测（离线小样本）

这个入口同时测量两个不同问题：

1. **真实人类下一着预测**：公开人类实战中，Maia 对实际下一着的 Top1、Top3 和负对数似然（NLL）。
2. **模型开局多样性**：固定 seed 的真实 Maia 推理、自采样开局，比较首着频率、唯一路径、重复率、熵和开局家族。

第二项不能代替第一项；两者都不是 Elo 校准。没有用谜题、golden 测试样例或 self-play 充当人类标签。没有用 Stockfish 坏棋率替代拟人指标。

## 运行

需要 Node **22.18 或更高版本**（原生 TypeScript type stripping），以及工程既有 `npm install` 依赖。没有引入新的 npm 依赖。脚本直接复用 `src/maia/encode.ts` 和 `src/maia/sample.ts`，使用 **onnxruntime-node 的 CPU execution provider**，不是 mock、浏览器 ONNX 或概率缓存替代模型推理。

从 `web/` 运行：

```sh
# 全部三种真实模型的最小端到端：6 个真人局面，三种策略各 2 条开局，每条 4 半回合。
npm run bench:human -- --smoke --out ../tmp/human-bench-smoke

# 默认小样本：全部模型，96 个真人局面；每策略 24 条开局、8 个完整回合。
npm run bench:human -- --out ../tmp/human-bench

# 更大的采样，以及多个未校准等级输入；真人局面仍使用 PGN 各方的原始等级。
npm run bench:human -- --models 5m,23m,79m --positions 256 --rollouts 100 --plies 16 --elos 1100,1500,1900 --seed 20261030 --out ../tmp/human-bench-multi

# 只迭代最小模型，显式覆盖 smoke 规模。
npm run bench:human -- --smoke --models 5m --positions 8 --rollouts 4 --plies 16 --out ../tmp/human-bench-5m

# 显式开启历史输入的研究对照；不是产品默认模式。
npm run bench:human -- --smoke --history --out ../tmp/human-bench-history-smoke

npm run bench:human -- --help
```

结果为 `<out>.json` 和 `<out>.md`。模型默认来自 `public/models/maia3-{5m,23m,79m}/manifest.json`；按清单拼接真实 ONNX 分片，检查总大小与 SHA-256 后才创建推理 session。可用 `--model-root PATH` 指向同样清单格式的目录，例如 `native-models`，但不同精度的结果不可混作相同模型。三个尺寸依次运行并释放 session，不并发加载大模型。默认 CPU 线程为 1，可用 `--threads` 改动。

`--smoke` **只验证真实数据—编码—推理—采样—报告的端到端通路**，不支持拟人表现结论。默认完整小样本也只作描述性对比。脚本不自动联网，所有输入固定离线存储。

默认 **history off**，与产品 `main.ts` 的 `maiaFens`、`useHistory=false` 一致：只将当前 FEN 交给现有编码器，由编码器按原有规则填充输入。只有显式传入 `--history` 才启用最多八局面的历史研究模式。真人预测与开局采样均使用所选模式；JSON `options.history` 和 Markdown 明确记录，两个模式的结果不能混作同一配置。

## 人类数据、许可与固定哈希

- 文件：`scripts/data/human-games.pgn`，**12 局完整公开实战**，保留原始玩家、双方等级、站点 URL、时间控制、UTC 日期与着法。
- SHA-256：`141d94ece0d161e480955b9abda54042a963e62944d307a5f18efca9f27dab4c`。
- 固定来源与逐局清单：`scripts/data/human-games.manifest.json`。
- 原始来源：[Lichess 2013-01 rated standard 数据库](https://database.lichess.org/standard/lichess_db_standard_rated_2013-01.pgn.zst)。该月文件的开头含 UTC 2012-12-31 记录，这是源文件原样内容，不是重新标注日期。
- 许可：[Lichess 开放数据库声明](https://database.lichess.org/)明确以 **CC0** 发布，允许下载、修改和再分发。
- 获取时间：2026-10-30。
- 下载压缩文件前 **1,048,576 bytes**，该前缀 SHA-256：`88a76da9e86d1e23cf90e681fc40b580ee06896d1dcca84b3709b6c3d3e1975e`。从其流式 zstd 解压的前 140,000 bytes，按源顺序选择前 12 个完整、`Event` 为 `Rated Classical game` 或 `Rated Blitz game`、`Termination` 为 `Normal`、双方等级为数值、无 BOT title 的记录。条目原文保留，仅统一文件记录间的 LF 分隔。

CLI 每次检查固定 PGN 哈希，再用 `chess.js` 兼容解析全部棋谱、核对来源清单和双方等级，并逐步合法回放。解析允许源 PGN 中合法但过度消歧的 SAN（如 `Rd1d2`），不是禁用走子合法性验证；每个 token 仍必须解析成合法走法，后续再按 from/to/promotion 回放。开局命名表采用相同 SAN 兼容规则。源数据与固定哈希不改动。随后用固定 seed 的 Mulberry32/Fisher–Yates 对所有真实下一着局面不放回抽样，实际样本数取 `--positions` 与全部可用局面数中的较小者。完整回放历史保留作证据和可选研究输入，但默认推理只使用当前 FEN。

这里的“人类”指 Lichess 公开 rated 标准玩家实战来源，与生成样本明确分开；没有独立身份或反作弊审计。

### 为什么不能宣称普适拟人准确率

- 12 局是早期数据库按时间顺序取得的**便利样本**，不是等级均衡随机人群；不覆盖现代各时间控制、地区或棋风。
- 同局多个下一着相关，局面样本数不是独立对局数。报告同时给出原始棋谱数和实际覆盖棋谱数。
- 数据很早，**可能与 Maia 训练数据重叠，不能宣称 held-out 测试集**。
- 原 PGN `WhiteElo` / `BlackElo` 是当时的 **Lichess Glicko2**，不是 FIDE Elo；作为条件输入传入不意味着 Maia 的等级已校准。
- 较低温度可能提高某些 Top1/棋力指标，同时使真实人类的非热门着法完全失去支持。不能只挑有利指标。

## 指标与策略

固定比较以下三种策略，JSON 写出完整参数：

| 名称 | Temperature | Top-P |
| --- | ---: | ---: |
| baseline（默认） | 1 | 1 |
| nucleus95 | 1 | 0.95 |
| sharp | 0.5 | 0.9 |

采样实现与应用相同：先对**合法着法 logits**作温度 softmax，按概率排序，保留使累计概率达到 Top-P 的最短前缀，**包括跨阈值那一步**，最后重新归一化。没有开局阶段特殊放宽、引擎改选或开局库驱动落子。

### 真人下一着

每个局面按当前执棋方传入自己的原始等级 `self_elo` 和对手原始等级 `oppo_elo`，黑白轮换时一起交换。指标包括：

- Top1 / Top3：实际人类下一着是否进入该策略的前 1 / 3 名。
- NLL：`−ln P(人类实际下一着)`，单位 nats；baseline 直接用稳定 log-softmax，避免极小概率下溢造成虚假的无穷值。
- 支持覆盖率和零支持计数：截断策略会把真实人类某些实走概率变成 0。此时**真正的平均 NLL 是无穷**，JSON 用 `meanNllNats: null` 与 `meanNllIsInfinite: true` 表达，Markdown 明写 ∞；不加 epsilon 掩盖。另报 `meanNllOnSupportedOnly`，它不是总体 NLL。
- 按当前执棋者等级 `<1200`、`1200–1599`、`1600–1999`、`>=2000` 分组，避免只报一项总体值。小组可能极小，不做显著性声称。

JSON 留下逐局面 site、ply、FEN、双方等级、人类 UCI、策略概率、排名、NLL 和支持大小，可以检查聚合结果。

### 真实 Maia 采样开局

每模型、每个 `--elos` 等级、每策略生成多条路径，默认 16 半回合（8 个完整回合）。双方等级输入相同。每条路径有独立 uint32 seed；不同模型/策略的同序号路径采用相同随机流，便于条件对比。遇正常终局提前停止并记录，不补造着法。

- 首着频率与经验 Shannon 熵（bits）。
- 完整 UCI 序列的唯一路径数、经验路径熵。
- 重复路径率 = `1 − 唯一路径数 / 路径数`。
- 无放回路径对碰撞率 = `Σ cᵢ(cᵢ−1) / [N(N−1)]`；只有一条时为 null。
- 前四半回合唯一路径数。
- 开局家族频率和识别覆盖率。

命名数据来自 [lichess-org/chess-openings](https://github.com/lichess-org/chess-openings)，固定 commit **`712a58be746c143f4ab935b68acc50f4bac813eb`**，原始 `a.tsv` 至 `e.tsv` 和 CC0 `COPYING.txt` 离线保留在 `scripts/data/openings/`，每个文件有 SHA-256 清单。每条路径取沿途最后匹配的命名局面，家族为名称冒号前部分；同局面多个名称按固定数据顺序取首个，未命中标为“未识别”。这些标签**只事后分类，绝不决定落子**，也不能当作对所有开局家族的完全覆盖。

实现缓存相同模型、相同等级与**实际传给编码器的 FEN 输入**下的真实推理分布：默认按当前 FEN，`--history` 时按最近八个 FEN，不缓存替代随机抽样的预制路径。输出保留每条完整 UCI 路径、最终 FEN、seed 和命名匹配位置。

## 报告可追溯性

JSON / Markdown 均包含：模型 SHA-256、人类数据 SHA-256、数据清单 SHA-256、开局清单 SHA-256、seed、等级、历史输入模式、策略参数和真实样本数。JSON 还包含 Node / ONNX Runtime 版本、平台、CPU 线程、完整命令选项，以及 CLI、数据工具、应用编码器和采样器的实现 SHA-256。

固定 seed 保证随机流，不保证跨 ONNX Runtime / CPU 架构的最后一位浮点完全一致；概率边界处的微小差异可能改变路径。

## 研究参考与归属

方法参考 Dash1971 的 [Mobile Maia sampling report](https://github.com/Dash1971/mobile-maia-research/blob/a2d90a94aac930fe17109f5e7e1b2e351c18b4fd/studies/maia3-sampling/REPORT.md)（研究仓库 commit `a2d90a94aac930fe17109f5e7e1b2e351c18b4fd`、报告 blob `dded15fe3e5f26bb48ce9516d581a8a2bf38c839`）：比较 1/1、1/.95、.5/.9，区分人类参考、8 回合采样多样性与棋力，明确 Top-P 跨阈值保留语义。

该研究原始代码/文档采用 **AGPL-3.0-only**。本工具是依据其公开方法自行实现，**未复制或移植其 Dart/Python 代码、处理后数据、图表或文字**；不能因“借鉴方法”就把它的代码说成无许可负担。人类 PGN 直接取自 Lichess CC0 数据库，开局命名直接取自 Lichess CC0 仓库并保留原始许可；项目既有 Maia 模型和编码器的上游条款不因本评测改变。
