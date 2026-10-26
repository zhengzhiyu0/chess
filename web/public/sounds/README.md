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

The additional `wood/`, `felt/`, and `glass/` themes use the same Kenney CC0 pack:

| Theme | Move.mp3 source | Capture.mp3 source |
| --- | --- | --- |
| 轻柔木质 (`wood`) | `impactWood_light_001.ogg` | `impactWood_medium_000.ogg` |
| 柔和落子 (`felt`) | `impactSoft_medium_000.ogg` | `impactSoft_heavy_000.ogg` |
| 清脆玻璃 (`glass`) | `impactGlass_light_001.ogg` | `impactGlass_medium_001.ogg` |

Source archive: [Kenney Impact Sounds 1.0](https://kenney.nl/media/pages/assets/impact-sounds/87b4ddecda-1677589768/kenney_impact-sounds.zip).
The original licence is included as [LICENSE-Kenney.txt](LICENSE-Kenney.txt).
These six clips were converted to 44.1 kHz mono MP3 at 128 kb/s, with leading silence removed
and gain reduced by 4 dB. Reproduce from the archive's `Audio/` folder with FFmpeg:

```sh
ffmpeg -i INPUT.ogg -af 'silenceremove=start_periods=1:start_duration=0:start_threshold=-45dB,volume=-4dB' -ac 1 -ar 44100 -codec:a libmp3lame -b:a 128k -map_metadata -1 OUTPUT.mp3
```

Their notification events reuse `sfx/`. All selectable themes now use bundled MP3 files;
no oscillators or generated noise are used for playback or fallback. Missing samples fall back to
the corresponding Lichess `sfx/` recording. Invalid moves use the `LowTime` warning clip.
