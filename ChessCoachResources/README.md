# 莉亚语音包 · 完整版

已生成 121 条，覆盖 30 类事件。使用 MiniMax `speech-2.8-hd`，音色为 `Chinese (Mandarin)_Laid_BackGirl`。原有 60 条直接复用，本次补齐 61 条。

实际只传入 `voice_id`、`voice_id_source: catalog` 和 `language_boost: Chinese`；未设置情绪、语速、音高、音量或 voice_modify。正文、标点均取自已确认制作单的“朗读文本”。

双击 `preview.html` 可以按分类试听、搜索台词、比较处理版与原始版，并勾选需要调整的台词。页面不需要服务器，音频文件必须和页面一起保留。

- `Audio/`：121 个 M4A，AAC 单声道、24000Hz，目标码率 32kbps；约 1.99 MiB，总时长约 6 分 55 秒。
- `Source/`：完整保留 121 个原始 MP3 和逐字时间戳 JSON。
- `coach_lines.json`：台词、分类、文件名、时长、裁剪点以及 MiniMax 资源版本 ID。
- `build-report.json`：实际文件体积、时长和自动检查结果。

后处理依据最后一个字及句号时间戳，保留至少约 300ms 的字后余量，末端使用 50ms 淡出。裁剪点是时间戳估算，不代表完成逐条听感验收。原始文件保留，发现截尾或发音问题可调整单条。

自动检查通过：121 条正文与时间戳相符、AAC 编码和声道/采样率正确、全部文件可完整解码且非静音、裁剪点晚于最后一个字。听感验收待完成。

MiniMax Design 项目：`chess-voice/voice`，集合：`莉亚语音包`。本次 61 条任务的 estimatedCredits 合计 62 credits（其中一条为 2 credits），加上第一批约 60 credits，两个批次合计约 122 credits。

本地重复整理不会调用 API，也不会产生语音生成费用：

```powershell
.venv\Scripts\python.exe scripts\prepare_lia_audio.py
```

需要重新应用裁尾设置时加 `--rebuild`。完整生成与原始版本映射记录位于 `scripts/lia_voice_build.json`。

这份资源包已接入游戏：构建时由 `web/scripts/copy-voices.mjs` 同步到 `web/public/voices/lia/`；只有莉亚在关键事件触发时显示同文气泡和播放录音。其他角色暂不发言。
