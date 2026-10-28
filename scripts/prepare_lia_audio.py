"""Prepare existing MiniMax Design outputs; never submits billable requests.

Requires Python 3.10+. From the project root on Windows:
.venv\\Scripts\\python.exe scripts\\prepare_lia_audio.py
The manifest records the exact voice settings and the original Resource Versions.
"""
from __future__ import annotations

import argparse
import array
import html
import json
import re
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PACK = ROOT / 'ChessCoachResources'
LABELS = {
    'opening_book_entry': '开局库', 'opening_book_exit': '离开开局库',
    'player_accurate': '精准棋', 'player_best': '最佳棋',
    'player_brilliant': '妙手', 'capture_minor': '莉亚吃轻子',
    'capture_rook': '莉亚吃车', 'capture_queen': '莉亚吃后',
    'player_loses_minor': '玩家吃莉亚的轻子',
    'player_loses_rook': '玩家吃莉亚的车',
    'player_loses_queen': '玩家吃莉亚的后',
    'tactic_fork': '捉双', 'tactic_pin': '牵制', 'tactic_sacrifice': '弃子',
    'missed_mate': '错失杀棋', 'blunder_into_mate': '走入必杀',
    'mate': '将杀', 'comeback': '扳回局面',
    'lia_best_move': '莉亚关键最佳棋', 'capture_pawn': '莉亚吃兵',
    'tactic_discovered_attack': '发现攻击', 'tactic_zwischenzug': '中间手',
    'key_threat': '关键威胁', 'check': '莉亚将军',
    'player_check': '玩家将军', 'castling': '王车易位',
    'promotion': '升变', 'queen_early': '过早出后',
    'defense_found': '关键防守', 'player_missed_tactic': '错过战术',
}


def command(args: list[str]) -> bytes:
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        raise RuntimeError(result.stderr.decode('utf-8', errors='replace'))
    return result.stdout


def probe(path: Path) -> dict:
    return json.loads(command([
        'ffprobe', '-v', 'error', '-show_entries',
        'format=duration:stream=codec_name,sample_rate,channels,bit_rate',
        '-of', 'json', str(path),
    ]))


def speech_text(text: str) -> str:
    return ''.join(c for c in text if c.isalnum())


def write_preview(clips: list[dict]) -> None:
    rows = []
    for clip in clips:
        category = html.escape(clip['categoryLabel'])
        clip_id = html.escape(clip['id'])
        text = html.escape(clip['text'])
        processed = 'Audio/' + clip['file']
        raw = 'Source/' + clip['id'] + '.mp3'
        rows.append(f'''<article data-category="{category}" data-id="{clip_id}">
<div><span class="tag">{category}</span><code>{clip_id}</code></div>
<p>{text}</p><div class="players"><label>处理版 · {clip['durationSeconds']:.2f} 秒
<audio controls preload="none" src="{processed}"></audio></label>
<label>原始版<audio controls preload="none" src="{raw}"></audio></label></div>
<label class="mark"><input type="checkbox">这条需要调整</label></article>''')
    options = ''.join(f'<option>{html.escape(v)}</option>' for v in dict.fromkeys(c['categoryLabel'] for c in clips))
    page = '''<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>莉亚语音试听</title>
<style>
body{background:#10121c;color:#edf0ff;font:16px/1.6 system-ui,sans-serif;margin:0}
main{max-width:1040px;margin:auto;padding:28px 20px}h1{margin:0}p{margin:12px 0}
.muted{color:#adb5d4}nav{display:flex;gap:12px;flex-wrap:wrap;position:sticky;top:0;background:#10121cf5;padding:12px 0;z-index:1}
input,select,button{font:inherit;border:1px solid #596183;border-radius:8px;background:#212639;color:#fff;padding:8px}
article{padding:20px;background:#1a1f30;border:1px solid #313951;border-radius:12px;margin:16px 0}
code{color:#bdc6e9;font-size:12px;overflow-wrap:anywhere}.tag{color:#c7b8ff;margin-right:12px}
.players{display:flex;gap:24px;flex-wrap:wrap}.players label{display:flex;flex-direction:column;font-size:13px;color:#b5bedb}
audio{max-width:100%;width:380px;margin:8px 0}.mark{font-size:13px}article p{font-size:20px}
[hidden]{display:none}#export{white-space:pre-wrap;overflow-wrap:anywhere}
</style><main><h1>莉亚语音试听</h1>
<p class="muted">CLIP_COUNT 条 · Laid-back Girl 默认音色。逐条播放，比较句尾与发音。标记保存在此浏览器中。</p>
<nav><select id="category"><option value="">全部分类</option>OPTIONS</select>
<input id="search" placeholder="搜索台词或编号" aria-label="搜索台词或编号">
<button id="next">播放下一条</button><button id="marked">显示待调整编号</button></nav>
<pre id="export"></pre>ROWS
<script>
const cards=[...document.querySelectorAll('article')],category=document.querySelector('#category'),search=document.querySelector('#search');
let current=-1;
const filter=()=>cards.forEach(card=>card.hidden=!!((category.value&&card.dataset.category!==category.value)||(search.value&&!card.textContent.toLowerCase().includes(search.value.toLowerCase()))));
category.onchange=filter;search.oninput=filter;
document.addEventListener('play',event=>{if(event.target.tagName!=='AUDIO')return;document.querySelectorAll('audio').forEach(a=>{if(a!==event.target)a.pause()});current=cards.indexOf(event.target.closest('article'))},true);
document.querySelector('#next').onclick=()=>{const options=cards.map((card,index)=>({card,index})).filter(x=>!x.card.hidden);if(!options.length)return;const item=options.find(x=>x.index>current)||options[0];item.card.scrollIntoView({block:'center',behavior:'smooth'});item.card.querySelector('audio').play().catch(()=>{})};
cards.forEach(card=>{const key='lia-review:'+card.dataset.id,check=card.querySelector('input');try{check.checked=localStorage.getItem(key)==='1'}catch{}check.onchange=()=>{try{localStorage.setItem(key,check.checked?'1':'0')}catch{}}});
document.querySelector('#marked').onclick=()=>{document.querySelector('#export').textContent=cards.filter(c=>c.querySelector('input').checked).map(c=>c.dataset.id).join('\\n')||'尚未标记待调整台词'};
</script></main></html>'''.replace('CLIP_COUNT', str(len(clips))).replace('OPTIONS', options).replace('ROWS', '\n'.join(rows))
    (PACK / 'preview.html').write_text(page, encoding='utf-8')


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--rebuild', action='store_true', help='Recreate AAC files from preserved source audio')
    args = parser.parse_args()
    for tool in ('ffmpeg', 'ffprobe'):
        if not shutil.which(tool):
            raise RuntimeError(f'Missing required tool: {tool}')
    manifest = json.loads((ROOT / 'scripts/lia_voice_build.json').read_text(encoding='utf-8'))
    lines = manifest['lines']
    expected = manifest.get('expectedCount', len(lines))
    if not lines or len(lines) != expected or len({line['file'] for line in lines}) != expected:
        raise ValueError(f'Expected exactly {expected} unique clips')
    versions = {g['index']: g for g in manifest['generated']}
    for directory in ('Audio', 'Source'):
        (PACK / directory).mkdir(parents=True, exist_ok=True)
    clips = []
    for index, line in enumerate(lines):
        if not re.fullmatch(r'lia_[a-z_]+_\d{2}\.m4a', line['file']):
            raise ValueError(f'Invalid filename: {line["file"]}')
        clip_id = Path(line['file']).stem
        raw = PACK / 'Source' / (clip_id + '.mp3')
        timing_path = PACK / 'Source' / (clip_id + '.json')
        if not raw.exists() or not timing_path.exists():
            raise FileNotFoundError(f'Missing preserved MiniMax source audio or timestamps: {clip_id}')
        segments = json.loads(timing_path.read_text(encoding='utf-8-sig'))
        if speech_text(''.join(s['text'] for s in segments)) != speech_text(line['text']):
            raise ValueError(f'Timing text differs from requested text: {clip_id}')
        words = [word for segment in segments for word in segment.get('timestamped_words', [])]
        lexical = [word for word in words if speech_text(word['word'])]
        if not lexical:
            raise ValueError(f'No word timestamps: {clip_id}')
        last_word = max(w['time_end'] for w in lexical) / 1000
        last_mark = max(w['time_end'] for w in words) / 1000
        raw_duration = float(probe(raw)['format']['duration'])
        cut = min(raw_duration, max(last_word + 0.30, last_mark + 0.10))
        fade_duration = min(0.05, cut - last_word)
        target = PACK / 'Audio' / line['file']
        if args.rebuild or not target.exists():
            command([
                'ffmpeg', '-y', '-v', 'error', '-i', str(raw), '-map_metadata', '0',
                '-af', f'atrim=end={cut:.6f},asetpts=PTS-STARTPTS,afade=t=out:st={cut-fade_duration:.6f}:d={fade_duration:.6f}',
                '-ac', '1', '-ar', '24000', '-c:a', 'aac', '-b:a', '32k',
                '-movflags', '+faststart+use_metadata_tags', str(target),
            ])
        info = probe(target)
        stream = info['streams'][0]
        duration = float(info['format']['duration'])
        if stream['codec_name'] != 'aac' or int(stream['sample_rate']) != 24000 or stream['channels'] != 1:
            raise ValueError(f'Unexpected encoding: {clip_id}')
        if duration < last_word + 0.05 or abs(duration - cut) > 0.12:
            raise ValueError(f'Unsafe end time: {clip_id}')
        samples = array.array('h')
        samples.frombytes(command(['ffmpeg', '-v', 'error', '-xerror', '-i', str(target), '-f', 's16le', '-acodec', 'pcm_s16le', '-']))
        if not samples or max(abs(sample) for sample in samples) < 32:
            raise ValueError(f'Empty or silent audio: {clip_id}')
        category = re.sub(r'_\d{2}$', '', clip_id.removeprefix('lia_'))
        clip = {
            'id': clip_id, 'category': category, 'categoryLabel': LABELS[category],
            'text': line['text'], 'file': line['file'],
            'durationSeconds': round(duration, 3), 'rawDurationSeconds': raw_duration,
            'lastWordSeconds': round(last_word, 3), 'trimEndSeconds': round(cut, 3),
            'sizeBytes': target.stat().st_size,
            'taskId': versions[index]['taskId'], 'versionId': versions[index]['versionId'],
        }
        clips.append(clip)
        print(f'{index+1:03}/{len(lines)} {line["file"]} {duration:.2f}s', flush=True)
    (PACK / 'coach_lines.json').write_text(json.dumps({
        'model': manifest['model'], 'params': manifest['params'],
        'reviewStatus': 'awaiting-listening-review', 'clips': clips,
    }, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    write_preview(clips)
    report = {
        'count': len(clips), 'categories': len({c['category'] for c in clips}),
        'totalBytes': sum(c['sizeBytes'] for c in clips),
        'totalDurationSeconds': round(sum(c['durationSeconds'] for c in clips), 3),
        'checks': ['requested text matches timestamps', 'AAC mono 24000Hz', 'all files decode', 'non-silent audio', 'end time preserves final word'],
        'listeningReview': 'pending',
    }
    (PACK / 'build-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False))


if __name__ == '__main__':
    main()
