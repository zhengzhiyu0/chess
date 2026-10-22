# Sounds

`sfx/`, `piano/`, `nes/` and `futuristic/` are sound themes from [Lichess](https://github.com/lichess-org/lila)
(`public/sound/<theme>/`), created by [Enigmahack](https://github.com/Enigmahack) and licensed under the
GNU Affero General Public License v3 or later (AGPLv3+), the same licence as this project.
See the [Lichess COPYING.md](https://github.com/lichess-org/lila/blob/master/COPYING.md).

Files are unmodified. Only the ones this app plays are included:
`Move`, `Capture`, `Check`, `GenericNotify`, `Victory`, `Defeat`, `Draw`, `LowTime`.

`board/` (the default "实木棋盘" theme): `Move.mp3` is `impactWood_light_000` and `Capture.mp3` is
`impactWood_medium_001` from [Kenney's Impact Sounds](https://kenney.nl/assets/impact-sounds), licensed
[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). They were converted from OGG to mono MP3,
with leading silence trimmed and the level lowered by 4 dB. The theme's other events use the `sfx/` files.
