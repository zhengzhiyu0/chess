# 新增棋子素材

下载日期：2026-11-04。运行时全部从本地资源加载，可离线使用。
每套包括白黑双方 K、Q、R、B、N、P，共 12 个 SVG。
文件名统一为应用使用的 wK.svg 等形式。
2026-11-05 为小屏显示调整：补齐六套 SVG 的 viewBox，统一导出尺寸；
Eyes、Freak、Prmi 加强描边，Eyes 调整眼白、瞳孔及黑方轮廓对比，Freak、Prmi 提亮黑方渐变；
Papercut 移除柔化阴影并加强轮廓。保留原始矢量路径，不转换为位图。

| 本地目录（pieces/ 下） | 作者 | 许可证 | 固定版本来源 |
| --- | --- | --- | --- |
| freak | Maurizio Monge | MIT | https://github.com/maurimo/chess-art/tree/18baed27e8a2a721f1d60e7e27452166b3e20c1b/fancy/freak |
| eyes | Maurizio Monge | MIT | https://github.com/maurimo/chess-art/tree/18baed27e8a2a721f1d60e7e27452166b3e20c1b/fancy/eyes |
| prmi | Maurizio Monge | MIT | https://github.com/maurimo/chess-art/tree/18baed27e8a2a721f1d60e7e27452166b3e20c1b/fancy/prmi |
| livius | Martin Sedlák | CC0 / 公有领域奉献 | https://github.com/kmar/chess_svg_piece_sets/tree/af40ea51e87eddee1ae7ee35ae312893a1271233/livius |
| meridian | Martin Sedlák；据作者说明设计取自 1952 年德国报纸 | CC0 / 公有领域奉献 | https://github.com/kmar/chess_svg_piece_sets/tree/af40ea51e87eddee1ae7ee35ae312893a1271233/meridian |
| meridian-shaded | Martin Sedlák；Meridian 渐变版 | CC0 / 公有领域奉献 | https://github.com/kmar/chess_svg_piece_sets/tree/af40ea51e87eddee1ae7ee35ae312893a1271233/meridian_shaded |
| papercut | Nikolay Anzarov (nikoichu) | CC BY 4.0 | https://github.com/lichess-org/lila/tree/9e780e9f2ce4b18a1c7991b9fe0b069c001459b8/public/piece/papercut |
| totoy | Kosal Sen | CC BY 4.0 | https://github.com/lichess-org/lila/tree/22df4783c47a5715d40121b7e4641d67a1efffa2/public/piece/totoy |

MIT 全文见 chess-art-MIT.txt；CC0 / 公有领域奉献原文分别见
livius-CC0.txt、meridian-CC0.txt、meridian-shaded-CC0.txt。
Papercut 的作者与授权见 lila-COPYING.md 的对应条目；CC BY 4.0 全文见
CC-BY-4.0.txt，许可链接：https://creativecommons.org/licenses/by/4.0/ 。
Papercut 作者主页：https://nikoichu.itch.io/ 。
Papercut 修改说明：移除原始柔化阴影滤镜，加强原有轮廓不透明度，并规范导出尺寸。
Totoy 于 2026-11-05 导入，共 12 个原版 SVG；保留原有路径、颜色和 viewBox，未修改素材。
作者与授权同见 lila-COPYING.md 的 totoy 条目，CC BY 4.0 全文见 CC-BY-4.0.txt。

## 圆润蓝灰棋子（2026-11-05）

pieces/rounded/ 为本项目按用户提供的多邻国风格参考图重新绘制的 12 枚 SVG，
采用圆润轮廓、蓝灰配色和分层色块。并非从官方素材提取，也不是官方开源棋子。
生成源文件：web/scripts/build-rounded-pieces.mjs；无外部图像、字体或滤镜依赖。
2026-11-05 根据参考图再次调整皇后：缩短并圆化冠尖、加宽圆底座；国王改为宽肩圆底轮廓，重画十字及高光。
同日重画车、马、象：车改为一体塔冠和圆柱底座，马改为单只短耳与圆弧后脑，象改为宽圆水滴轮廓与较短斜槽。
随后依据用户提供的清晰参考图重新用少量贝塞尔曲线绘制车、马、象，
移除低清截图提取的轮廓数据；重画塔冠凹槽、马耳及高光、象的斜槽切面，
并为黑方这三类棋子加上参考图中的浅色描边。国王、皇后和兵保持此前版本。
后续按手机显示反馈移除车、马、象的外描边，并将白方六类棋子统一调整为暖象牙白配色；保留造型与分层阴影。
随后依据反馈去掉米黄色倾向，白方改为中性柔白与中性灰阴影；保留无外描边版本。
最终按用户要求恢复调暖前的蓝灰白配色，保留移除车、马、象外描边的修改。
随本项目按 AGPL-3.0-or-later 分发。

pieces/rounded-outline/ 是同套造型的独立描边版本，共 12 枚 SVG。
黑白双方的王、后、车、马、象、兵均添加圆角外轮廓；保留原版色彩与内部阴影，
不对内部高光添加描边，不使用滤镜。与 rounded/ 由同一生成脚本维护。

## 参考图棋盘（2026-11-05）

duo-slate.svg 为按用户提供的多邻国棋盘截图重建的 8×8 SVG 棋盘：
浅格 #23343c、深格 #141e24，配 1/320 盘宽的细边缘。
以矢量色块绘制，不包含截图中的棋子或截图像素。

## 新增棋盘素材（2026-11-05）

来源：James Clarke (clarkerubber) 的 Staunton-Pieces，MIT 许可证。
固定版本：https://github.com/clarkerubber/Staunton-Pieces/tree/cef2c79445380c5bffec461a80c7c91caf89b3b2/Boards/Scaled/1024
完整许可证见 Staunton-Pieces-MIT.txt。

导入 Light-Wood、Rosewood、Jade、China-Blue、China-Green、China-Scarlet、
China-Yellow、Brushed-Aluminium、Gold-Silver、Wood-Glass、Wax、Green-Glass 共 12 套。
本地文件为 boards/staunton-*.webp。
从 1024×958 PNG 裁去顶部空隙及前缘（源区域 x=0, y=6, width=1024, height=929），
校正为 1024×1024 正方形，使纹理格与交互格对齐，再以质量 0.95 编码为 WebP。

## 新增绿色棋盘（2026-11-05）

来源：NikAgs 的 ChessSkins，MIT 许可证，Copyright (c) 2026 NikAgs。
固定版本：https://github.com/NikAgs/ChessSkins/tree/04a3a082c3571bdd80d5a9d0506bea401ab908bf/boards
完整许可证见 ChessSkins-MIT.txt。

| 应用名称 | 上游目录（boards/ 下） | 本地文件（boards/ 下） |
| --- | --- | --- |
| 比赛绿 | tournament | chessskins-tournament.svg |
| 苔藓花园 | moss | chessskins-moss.svg |
| 榻榻米绿 | tatami | chessskins-tatami.svg |
| 黑板绿 | chalkboard | chessskins-chalkboard.svg |
| 电路绿 | circuit | chessskins-circuit.svg |
| 像素公园 | pixel-park | chessskins-pixel-park.svg |
| 潮汐青绿 | tidepool | chessskins-tidepool.svg |

每套直接导入上游 board.svg，仅重命名本地文件；保留原版路径、纹理、配色和
800×800 viewBox，无外部资源依赖。浅深格备用色取自同版本 meta.json。
全部随应用打包并加入离线资源清单。

## 经典棋子改版（2026-11-05）

新增六个版本，共 72 枚本地 SVG，均包括黑白 K、Q、R、B、N、P。

| 本地目录（pieces/ 下） | 作者 | 授权 | 来源 |
| --- | --- | --- | --- |
| cburnett-v2 | Colin M. L. Burnett；JohnPablok 改版 | CC BY-SA 3.0 | https://opengameart.org/content/chess-pieces-and-board-squares |
| cburnett-v2-shadow | Colin M. L. Burnett；JohnPablok 改版 | CC BY-SA 3.0 | 同上，作者的有阴影版本 |
| kaneo | Kadagaden | CC BY 4.0 | https://github.com/Kadagaden/chess-pieces/tree/b035b0cc6a68e9fb99c872c8fe073c3ae3eba8a0/chess_kaneo |
| kaneo-midnight | Kadagaden | CC BY 4.0 | https://github.com/Kadagaden/chess-pieces/tree/b035b0cc6a68e9fb99c872c8fe073c3ae3eba8a0/chess_kaneo_midnight |
| sashite | Cyril Kato / Sashité | CC0 1.0 | https://sashite.dev/assets/chess/ ，授权见 https://sashite.dev/assets/ |
| dg-ra | DG-RA | CC0 1.0 / 公有领域 | https://openclipart.org/detail/351115/dg-ra-style-chess-pieces-set-20 ，授权见 https://openclipart.org/share |

JohnPablok 使用原始下载包
https://opengameart.org/sites/default/files/johnpablok_cburnett_chess-v2.zip 。
只调整 viewBox，将各自紧裁的单枚文件放入共同的 450×450 画布并对齐底部；
不修改路径、配色，阴影版保留作者内嵌的 PNG 投影。许可全文见 CC-BY-SA-3.0.txt。

Kaneo 两版只规范 SVG 尺寸（移除毫米宽高，保留 viewBox），不修改路径与配色。
原始授权全文见 Kaneo-CC-BY-4.0.txt。
Sashité 直接导入官方的 first/second/representations/western/ 下六类 SVG；
CC0 全文见 ../chessground/CC0-1.0.txt。
DG-RA 从 https://openclipart.org/download/351115 的 SVG 整图提取各单枚路径组，
移除背景、编辑器信息、整图排版变换和 crispEdges 渲染设置，统一为正方形画布，
保留原版路径、描边和颜色。

可复现导入脚本：web/scripts/import-classic-pieces.mjs。
将 JohnPablok 下载包解压至 sourceDir/cburnett-v2/，Kadagaden 固定版本仓库解压至
sourceDir/kadagaden/chess-pieces-master/，Sashité 十二枚保存至 sourceDir/sashite/wK.svg 等，
DG-RA 整图保存至 sourceDir/dg-ra.svg，再运行脚本并传入 sourceDir。
