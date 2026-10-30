# Maia 真实人类下一着与开局采样评测

模式：小样本描述性评测，非普适拟人/棋力结论。

Seed：20261030；人类局面：96/739；原始棋谱：12。
人类 PGN SHA-256：`141d94ece0d161e480955b9abda54042a963e62944d307a5f18efca9f27dab4c`
人类清单 SHA-256：`5539e24fdb23143d66d5a3aba89756b8ab7ebdf5ea5aaea0cfd6a350259fb050`
开局清单 SHA-256：`9e0c982049e5702536530039d11328d077989f1bb016578458ed3c133a3e5712`；固定 commit：`712a58be746c143f4ab935b68acc50f4bac813eb`
来源：[Lichess CC0 数据库](https://database.lichess.org/standard/lichess_db_standard_rated_2013-01.pgn.zst)；固定 PGN 数据在 scripts/data/human-games.pgn。
运行时：Node v22.19.0，onnxruntime-node 1.30.0，CPU threads=1。
历史输入：off（默认，仅当前 FEN，与产品一致）。
开局：每模型/等级/策略 24 条，最多 16 半回合；等级 1500。
策略：baseline=1/1；nucleus95=1/0.95；sharp=0.5/0.9。Top-P 保留跨阈值那步。

## 人类下一着

合法着法归一化；Top1/Top3 为人类实走是否在策略前 1/3 名；NLL 使用自然对数。baseline 是原始 Maia policy。截断后零支持使平均 NLL 为无穷，绝不加 epsilon 隐藏。

| 模型 | 模型 SHA-256 | 策略 | 局面/棋谱 | Top1 | Top3 | NLL (nats) | 支持覆盖 |
| --- | --- | --- | ---: | ---: | ---: | --- | ---: |
| 5m | `080122460a0dcfaff0ba1aa86f3b3360214f74f5458d3d63113c43c6dac1ad36` | baseline | 96/12 | 61.46% | 80.21% | 1.3778 | 100.00% |
| 5m | `080122460a0dcfaff0ba1aa86f3b3360214f74f5458d3d63113c43c6dac1ad36` | nucleus95 | 96/12 | 61.46% | 80.21% | ∞（存在零支持着法） | 93.75% |
| 5m | `080122460a0dcfaff0ba1aa86f3b3360214f74f5458d3d63113c43c6dac1ad36` | sharp | 96/12 | 61.46% | 76.04% | ∞（存在零支持着法） | 77.08% |
| 23m | `87f6d84e7f85d0d055601ed84d1fc96d82226a4f02c5c85efe1b3e7e136be020` | baseline | 96/12 | 63.54% | 80.21% | 1.3388 | 100.00% |
| 23m | `87f6d84e7f85d0d055601ed84d1fc96d82226a4f02c5c85efe1b3e7e136be020` | nucleus95 | 96/12 | 63.54% | 80.21% | ∞（存在零支持着法） | 93.75% |
| 23m | `87f6d84e7f85d0d055601ed84d1fc96d82226a4f02c5c85efe1b3e7e136be020` | sharp | 96/12 | 63.54% | 75.00% | ∞（存在零支持着法） | 79.17% |
| 79m | `d590b064c71d1d25399e01f0293a161684ebd7a50ae128ad199110c8ef06693e` | baseline | 96/12 | 64.58% | 80.21% | 1.3469 | 100.00% |
| 79m | `d590b064c71d1d25399e01f0293a161684ebd7a50ae128ad199110c8ef06693e` | nucleus95 | 96/12 | 64.58% | 80.21% | ∞（存在零支持着法） | 93.75% |
| 79m | `d590b064c71d1d25399e01f0293a161684ebd7a50ae128ad199110c8ef06693e` | sharp | 96/12 | 64.58% | 75.00% | ∞（存在零支持着法） | 78.13% |

### 按实际执棋者 Glicko2 分组

| 模型 | 等级段 | 策略 | 局面 | Top1 | Top3 | NLL |
| --- | --- | --- | ---: | ---: | ---: | --- |
| 5m | 1600-1999 | baseline | 66 | 63.64% | 83.33% | 1.3225 |
| 5m | 1600-1999 | nucleus95 | 66 | 63.64% | 83.33% | ∞（存在零支持着法） |
| 5m | 1600-1999 | sharp | 66 | 63.64% | 77.27% | ∞（存在零支持着法） |
| 5m | 1200-1599 | baseline | 28 | 60.71% | 78.57% | 1.3665 |
| 5m | 1200-1599 | nucleus95 | 28 | 60.71% | 78.57% | ∞（存在零支持着法） |
| 5m | 1200-1599 | sharp | 28 | 60.71% | 78.57% | ∞（存在零支持着法） |
| 5m | <1200 | baseline | 2 | 0.00% | 0.00% | 3.3624 |
| 5m | <1200 | nucleus95 | 2 | 0.00% | 0.00% | 3.3203 |
| 5m | <1200 | sharp | 2 | 0.00% | 0.00% | ∞（存在零支持着法） |
| 23m | 1600-1999 | baseline | 66 | 65.15% | 81.82% | 1.3057 |
| 23m | 1600-1999 | nucleus95 | 66 | 65.15% | 81.82% | ∞（存在零支持着法） |
| 23m | 1600-1999 | sharp | 66 | 65.15% | 75.76% | ∞（存在零支持着法） |
| 23m | 1200-1599 | baseline | 28 | 64.29% | 82.14% | 1.2647 |
| 23m | 1200-1599 | nucleus95 | 28 | 64.29% | 82.14% | ∞（存在零支持着法） |
| 23m | 1200-1599 | sharp | 28 | 64.29% | 78.57% | ∞（存在零支持着法） |
| 23m | <1200 | baseline | 2 | 0.00% | 0.00% | 3.4656 |
| 23m | <1200 | nucleus95 | 2 | 0.00% | 0.00% | 3.4237 |
| 23m | <1200 | sharp | 2 | 0.00% | 0.00% | ∞（存在零支持着法） |
| 79m | 1600-1999 | baseline | 66 | 66.67% | 81.82% | 1.3213 |
| 79m | 1600-1999 | nucleus95 | 66 | 66.67% | 81.82% | ∞（存在零支持着法） |
| 79m | 1600-1999 | sharp | 66 | 66.67% | 75.76% | ∞（存在零支持着法） |
| 79m | 1200-1599 | baseline | 28 | 64.29% | 82.14% | 1.2629 |
| 79m | 1200-1599 | nucleus95 | 28 | 64.29% | 82.14% | ∞（存在零支持着法） |
| 79m | 1200-1599 | sharp | 28 | 64.29% | 78.57% | ∞（存在零支持着法） |
| 79m | <1200 | baseline | 2 | 0.00% | 0.00% | 3.3663 |
| 79m | <1200 | nucleus95 | 2 | 0.00% | 0.00% | 3.3233 |
| 79m | <1200 | sharp | 2 | 0.00% | 0.00% | ∞（存在零支持着法） |

## 固定 seed 的真实 Maia 开局采样

此段是模型自采样多样性诊断，不是真人预测指标。无开局库驱动落子；命名表仅事后分类。唯一路径按完整 UCI 序列区分；重复率=1−唯一路径数/条数，另报无放回路径对碰撞率。熵是经验频率的 Shannon bits，小样本有偏。

| 模型 | 等级 | 策略 | 条数 | 唯一路径 | 重复率 | 路径对碰撞率 | 首着熵 | 路径熵 | 家族数（含未识别） |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 5m | 1500/1500 | 1/1 | 24 | 24 | 0.00% | 0.00% | 1.682 | 4.585 | 16 |
| 5m | 1500/1500 | 1/0.95 | 24 | 24 | 0.00% | 0.00% | 1.637 | 4.585 | 16 |
| 5m | 1500/1500 | 0.5/0.9 | 24 | 24 | 0.00% | 0.00% | 0.738 | 4.585 | 10 |
| 23m | 1500/1500 | 1/1 | 24 | 24 | 0.00% | 0.00% | 1.612 | 4.585 | 15 |
| 23m | 1500/1500 | 1/0.95 | 24 | 24 | 0.00% | 0.00% | 1.439 | 4.585 | 14 |
| 23m | 1500/1500 | 0.5/0.9 | 24 | 24 | 0.00% | 0.00% | 0.738 | 4.585 | 10 |
| 79m | 1500/1500 | 1/1 | 24 | 24 | 0.00% | 0.00% | 1.612 | 4.585 | 15 |
| 79m | 1500/1500 | 1/0.95 | 24 | 24 | 0.00% | 0.00% | 1.439 | 4.585 | 13 |
| 79m | 1500/1500 | 0.5/0.9 | 24 | 22 | 8.33% | 1.09% | 0.738 | 4.387 | 8 |

### 5m · 1500/1500 · 1/1

首着频率：e2e4 14/24 (58.33%)；d2d4 5/24 (20.83%)；e2e3 3/24 (12.50%)；b1c3 1/24 (4.17%)；b2b4 1/24 (4.17%)。

家族频率：Sicilian Defense 4/24；Van't Kruijs Opening 3/24；Pirc Defense 2/24；Queen's Pawn Game 2/24；Scandinavian Defense 2/24；Barnes Defense 1/24；Bishop's Opening 1/24；Center Game 1/24；French Defense 1/24；Horwitz Defense 1/24；Indian Defense 1/24；King's Pawn Game 1/24；Modern Defense 1/24；Owen Defense 1/24；Petrov's Defense 1/24；Polish Opening 1/24。

### 5m · 1500/1500 · 1/0.95

首着频率：e2e4 16/24 (66.67%)；d2d4 3/24 (12.50%)；c2c4 2/24 (8.33%)；e2e3 1/24 (4.17%)；g1f3 1/24 (4.17%)；g2g3 1/24 (4.17%)。

家族频率：Sicilian Defense 5/24；Queen's Pawn Game 3/24；French Defense 2/24；Scandinavian Defense 2/24；Bishop's Opening 1/24；Blackmar-Diemer Gambit 1/24；Caro-Kann Defense 1/24；Center Game 1/24；English Opening 1/24；Horwitz Defense 1/24；Hungarian Opening 1/24；Modern Defense 1/24；Petrov's Defense 1/24；Philidor Defense 1/24；Scotch Game 1/24；Zukertort Opening 1/24。

### 5m · 1500/1500 · 0.5/0.9

首着频率：e2e4 19/24 (79.17%)；d2d4 5/24 (20.83%)。

家族频率：Italian Game 6/24；Philidor Defense 4/24；Bishop's Opening 3/24；Queen's Pawn Game 3/24；Four Knights Game 2/24；Scandinavian Defense 2/24；Queen's Indian Defense 1/24；Ruy Lopez 1/24；Scotch Game 1/24；Tarrasch Defense 1/24。

### 23m · 1500/1500 · 1/1

首着频率：e2e4 15/24 (62.50%)；d2d4 4/24 (16.67%)；e2e3 3/24 (12.50%)；d2d3 1/24 (4.17%)；g2g4 1/24 (4.17%)。

家族频率：Scandinavian Defense 4/24；Van't Kruijs Opening 3/24；Center Game 2/24；French Defense 2/24；Queen's Pawn Game 2/24；Sicilian Defense 2/24；Caro-Kann Defense 1/24；Englund Gambit Declined 1/24；Grob Opening 1/24；Horwitz Defense 1/24；Owen Defense 1/24；Petrov's Defense 1/24；Vienna Game 1/24；Ware Defense 1/24；Zukertort Opening 1/24。

### 23m · 1500/1500 · 1/0.95

首着频率：e2e4 16/24 (66.67%)；c2c4 3/24 (12.50%)；d2d4 3/24 (12.50%)；e2e3 2/24 (8.33%)。

家族频率：Scandinavian Defense 4/24；Sicilian Defense 4/24；Center Game 2/24；English Opening 2/24；French Defense 2/24；Queen's Pawn Game 2/24；Blackmar-Diemer Gambit 1/24；Caro-Kann Defense 1/24；Englund Gambit Declined 1/24；King's Indian Defense 1/24；Modern Defense 1/24；Owen Defense 1/24；Petrov's Defense 1/24；Vienna Game 1/24。

### 23m · 1500/1500 · 0.5/0.9

首着频率：e2e4 19/24 (79.17%)；d2d4 5/24 (20.83%)。

家族频率：Italian Game 10/24；Queen's Pawn Game 3/24；Petrov's Defense 2/24；Scandinavian Defense 2/24；Scotch Game 2/24；Four Knights Game 1/24；King's Indian Defense 1/24；Rapport-Jobava System, with e6 1/24；Ruy Lopez 1/24；Three Knights Opening 1/24。

### 79m · 1500/1500 · 1/1

首着频率：e2e4 15/24 (62.50%)；d2d4 4/24 (16.67%)；e2e3 3/24 (12.50%)；b1c3 1/24 (4.17%)；d2d3 1/24 (4.17%)。

家族频率：Sicilian Defense 4/24；Scandinavian Defense 3/24；Van't Kruijs Opening 3/24；French Defense 2/24；Queen's Pawn Game 2/24；Center Game 1/24；Englund Gambit 1/24；Four Knights Game 1/24；King's Pawn Game 1/24；Owen Defense 1/24；Petrov's Defense 1/24；Van Geet Opening 1/24；Vienna Game 1/24；Ware Defense 1/24；Zukertort Opening 1/24。

### 79m · 1500/1500 · 1/0.95

首着频率：e2e4 16/24 (66.67%)；c2c4 3/24 (12.50%)；d2d4 3/24 (12.50%)；e2e3 2/24 (8.33%)。

家族频率：Scandinavian Defense 4/24；Sicilian Defense 4/24；English Opening 3/24；French Defense 2/24；King's Pawn Game 2/24；Queen's Pawn Game 2/24；Caro-Kann Defense 1/24；Englund Gambit 1/24；Four Knights Game 1/24；Owen Defense 1/24；Philidor Defense 1/24；Pirc Defense 1/24；Vienna Game 1/24。

### 79m · 1500/1500 · 0.5/0.9

首着频率：e2e4 19/24 (79.17%)；d2d4 5/24 (20.83%)。

家族频率：Italian Game 9/24；Queen's Pawn Game 4/24；Four Knights Game 3/24；Ruy Lopez 3/24；Scandinavian Defense 2/24；Bishop's Opening 1/24；King's Indian Defense 1/24；Petrov's Defense 1/24。

## 可复现性和边界

- JSON 包含逐真人局面实走概率、原始双方等级、完整采样路径、每条 seed、模型/数据/实现哈希和完整选项。
- 真人对局来自公开 rated standard 记录，不是谜题或模型自我对弈；未独立审计身份/反作弊。
- 12 局是早期数据库按时间顺序取得的便利样本，不均衡、不同局面不独立，可能与 Maia 训练数据重叠，不能称 held-out。
- PGN 等级是当时的 Lichess Glicko2，不等于 FIDE Elo，也没有标定 Maia 输入等级。
- 采样多样性不等于拟人准确率，更不等于棋力；未运行 Stockfish，不报告坏棋率或 Elo。
- 指标方法参考 [Dash1971/mobile-maia-research](https://github.com/Dash1971/mobile-maia-research/blob/a2d90a94aac930fe17109f5e7e1b2e351c18b4fd/studies/maia3-sampling/REPORT.md)，只借鉴研究设计，未移植其 AGPL-3.0-only 代码/数据/图表。
- 同一环境可复现随机序列；不同 ONNX Runtime/硬件浮点差异可能改变边界着法。

### 实现 SHA-256

- `scripts/human-bench.mjs`：`04e8e123d99096d9e2e2a07842d0bcec90ccaafa1c71064e4e0c791f5d5bd89c`
- `scripts/human-bench-data.mjs`：`6c7468451ec3ff0b604203db72184c03e5fc8b5f123479ab2059b705f635c908`
- `src/maia/encode.ts`：`fd883d5d021a602f4c8960955a14feb736dedad0f7fff55eb3ac802514314196`
- `src/maia/sample.ts`：`c60f96c91ae7dbd425fde4a39c10c73a9a367cdb46b437cfb8a98a151f2be92e`
