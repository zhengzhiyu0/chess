"""Split timestamped MiniMax batches into the 847 independent review recordings.

Uses only preserved files; never calls a cloud API. Python 3.10+, ffmpeg, ffprobe.
"""
from __future__ import annotations
import array
import html
import json
from pathlib import Path
from prepare_lia_audio import command, probe, speech_text, LABELS

ROOT = Path(__file__).resolve().parents[1]
PACK = ROOT / 'ChessCoachResources' / 'Cast'


def write_preview(manifest, clips):
    roles = manifest['roles']
    original = json.loads((ROOT/'ChessCoachResources/coach_lines.json').read_text(encoding='utf-8'))['clips']
    all_roles = [dict(id='lia',name='莉亚',style='精准克制',voiceLabel='Laid-back Girl',voice='Chinese (Mandarin)_Laid_BackGirl',color='#8e7cf0',rationale='已确认的默认音色基准。')] + roles
    records = []
    for clip in original:
        records.append(dict(id=clip['id'],role='lia',category=clip['category'],text=clip['text'],src='../Audio/'+clip['file'],duration=clip['durationSeconds']))
    for clip in clips:
        records.append(dict(id=clip['id'],role=clip['role'],category=clip['category'],text=clip['text'],src='Audio/'+clip['role']+'/'+clip['file'],duration=clip['durationSeconds']))
    labels = dict(LABELS)
    labels.update(lia_best_move='对手关键好棋',capture_pawn='对手吃兵',capture_minor='对手吃轻子',capture_rook='对手吃车',capture_queen='对手吃后',player_loses_minor='玩家吃对手轻子',player_loses_rook='玩家吃对手车',player_loses_queen='玩家吃对手后',check='对手将军')
    cards = ''.join(f'''<button class="person" data-role="{r['id']}" style="--accent:{r['color']}"><span class="badge">{html.escape(r['name'][0])}</span><strong>{html.escape(r['name'])}</strong><span>{html.escape(r['style'])}</span><small>{html.escape(r['voiceLabel'])}</small></button>''' for r in all_roles)
    options = ''.join(f'<option value="{key}">{html.escape(value)}</option>' for key,value in labels.items())
    payload = json.dumps(dict(roles=all_roles,clips=records,labels=labels),ensure_ascii=False).replace('<','\\u003c')
    page='''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>国际象棋 · 八位角色语音预览</title><style>
*{box-sizing:border-box}body{margin:0;background:#10131d;color:#eef0fa;font:16px/1.6 system-ui,sans-serif}main{max-width:1260px;margin:auto;padding:30px 22px 130px}
.eyebrow{color:#b7a6ee;font-size:13px;letter-spacing:2px}h1{margin:4px 0 8px;font-size:32px}.sub{color:#aeb8ce}.people{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:25px 0}
button,input,select{font:inherit;color:inherit;background:#202739;border:1px solid #3b4661;border-radius:9px;padding:9px 12px}button{cursor:pointer}button:hover{border-color:#a293e2}.person{display:grid;text-align:left;grid-template-columns:46px 1fr;gap:0 12px;padding:16px}.badge{grid-row:span 3;width:44px;height:44px;border-radius:14px;display:grid;place-items:center;background:var(--accent);color:#161922;font-size:24px;font-weight:800}.person small{color:#9eabc5}.person span:not(.badge){color:#bbc4d8;font-size:13px}.person.active{outline:2px solid var(--accent);background:#2b3044}
nav{position:sticky;top:0;z-index:2;display:flex;gap:10px;flex-wrap:wrap;background:#10131df7;padding:14px 0}#search{flex:1;min-width:180px}section{background:#181f2f;padding:20px;border:1px solid #303a51;border-radius:12px;margin:18px 0}h2{font-size:22px;margin:0}#info{color:#aeb8ce;font-size:14px;margin:8px 0}.row{display:grid;grid-template-columns:180px 1fr 100px 85px;gap:12px;align-items:center;padding:15px 0;border-bottom:1px solid #2f384c}.row:last-child{border:0}.meta{font-size:12px;color:#9eabc5}.meta code{display:block;overflow-wrap:anywhere;font-size:10px}.text{font-size:18px}.review{font-size:12px;color:#b7c0d5}.review input{accent-color:#b9a1ff}#playerbar{position:fixed;bottom:0;left:0;right:0;background:#20283bf5;border-top:1px solid #485571;padding:12px max(20px,calc((100vw - 1216px)/2));display:flex;gap:18px;align-items:center;z-index:3}#now{flex:1;font-size:14px}audio{width:350px;max-width:100%}#export{white-space:pre-wrap;font-size:13px}#count{font-size:13px;color:#aeb8ce}label{cursor:pointer}.hint{font-size:13px;color:#aeb8ce}a{color:#c7b4ff}
@media(max-width:700px){.people{grid-template-columns:repeat(2,1fr)}.person{padding:12px;grid-template-columns:34px 1fr;gap:0 8px}.badge{width:32px;height:36px;font-size:21px}.row{grid-template-columns:1fr 95px}.meta{grid-column:1/-1}.text{font-size:16px}.review{grid-column:1/-1}#playerbar{flex-wrap:wrap;gap:5px}#now{flex-basis:100%}audio{width:100%}main{padding:22px 14px 175px}h1{font-size:27px}}
</style><main><div class="eyebrow">CHESS COACH VOICE CAST</div><h1>八种性格，在棋盘上相遇</h1>
<p class="sub">7 位新角色 · 每位 121 条 · 30 类关键事件。莉亚作为已确认基准一起试听。</p>
<div class="people">PERSON_CARDS</div><nav><select id="category"><option value="">全部事件</option>OPTIONS</select><input id="search" aria-label="搜索台词" placeholder="搜索台词或编号"><button id="compare">同事件比较八人</button><button id="next">播放下一条</button><button id="marked">导出待调整清单</button></nav>
<section><h2 id="heading"></h2><p id="info"></p><p class="hint">默认音色，无机械效果、手动情绪、变速或变调。勾选待调整条目后可导出编号。<a href="../preview.html">莉亚原始版对照页</a></p><div id="count"></div><pre id="export"></pre><div id="list"></div></section>
<p class="hint">8 位角色录音已接入普通对弈；本页保留供集中试听。处理版已检查解码、文本对应和切分边界，仍需试听确认发音及语气。</p></main>
<div id="playerbar"><div id="now">选择角色，点击一条台词开始试听</div><audio controls preload="none"></audio></div>
<script type="application/json" id="data">PAYLOAD</script><script>
const data=JSON.parse(document.querySelector('#data').textContent),$=s=>document.querySelector(s),audio=$('audio');let active='xiaoyou',comparison=false,current='',shown=[];let marks={};try{marks=JSON.parse(localStorage.getItem('chess-cast-review')||'{}')}catch{}
const roles=Object.fromEntries(data.roles.map(r=>[r.id,r]));
function play(clip){current=clip.id;audio.src=clip.src;$('#now').textContent=roles[clip.role].name+' · '+data.labels[clip.category]+'｜'+clip.text;audio.play().catch(e=>$('#now').textContent+='（请点击播放器重试）')}
function render(){const category=$('#category').value,query=$('#search').value.toLowerCase();shown=data.clips.filter(c=>(comparison||c.role===active)&&(!category||c.category===category)&&(!query||(c.id+c.text).toLowerCase().includes(query)));document.querySelectorAll('.person').forEach(b=>b.classList.toggle('active',!comparison&&b.dataset.role===active));$('#heading').textContent=comparison?'同事件 · 八人比较':roles[active].name+' · '+roles[active].style;$('#info').textContent=comparison?'选一个事件，比较不同角色的表达和声音。':roles[active].rationale+' 音色：'+roles[active].voice;$('#count').textContent='显示 '+shown.length+' 条';$('#list').replaceChildren();for(const c of shown){const row=document.createElement('div');row.className='row';const meta=document.createElement('div');meta.className='meta';meta.textContent=roles[c.role].name+' · '+data.labels[c.category];const code=document.createElement('code');code.textContent=c.id;meta.append(code);const text=document.createElement('div');text.className='text';text.textContent=c.text;const button=document.createElement('button');button.textContent='▶ '+c.duration.toFixed(1)+' 秒';button.onclick=()=>play(c);const label=document.createElement('label');label.className='review';const check=document.createElement('input');check.type='checkbox';check.checked=!!marks[c.id];check.onchange=()=>{marks[c.id]=check.checked;try{localStorage.setItem('chess-cast-review',JSON.stringify(marks))}catch{}};label.append(check,' 待调整');row.append(meta,text,button,label);$('#list').append(row)}}
document.querySelectorAll('.person').forEach(b=>b.onclick=()=>{active=b.dataset.role;comparison=false;render()});$('#category').onchange=render;$('#search').oninput=render;$('#compare').onclick=()=>{comparison=!comparison;if(comparison&&!$('#category').value)$('#category').value='player_brilliant';render()};$('#next').onclick=()=>{if(!shown.length)return;const i=shown.findIndex(c=>c.id===current);play(shown[(i+1)%shown.length])};$('#marked').onclick=()=>{const selected=data.clips.filter(c=>marks[c.id]);$('#export').textContent=selected.map(c=>roles[c.role].name+' '+c.id+' '+c.text).join('\\n')||'尚未标记条目';if(navigator.clipboard&&selected.length)navigator.clipboard.writeText($('#export').textContent).catch(()=>{})};render();
</script></html>'''.replace('PERSON_CARDS',cards).replace('OPTIONS',options).replace('PAYLOAD',payload)
    (PACK/'preview.html').write_text(page,encoding='utf-8')


def main():
    manifest=json.loads((ROOT/'scripts/cast_voice_build.json').read_text(encoding='utf-8'))
    tasks=json.loads((ROOT/'scripts/cast_voice_tasks.json').read_text(encoding='utf-8'))
    lookup={c['id']:c for c in manifest['clips']}
    prepared=[]
    for task in tasks:
        if task['status']!='completed': raise ValueError('Unfinished task '+task['id'])
        source_id=task.get('batchId',task.get('clipId'))
        source=PACK/'Source'/task['role']/(source_id+'.mp3')
        timing=source.with_suffix('.json')
        segments=json.loads(timing.read_text(encoding='utf-8-sig'))
        ids=task.get('clipIds',[task.get('clipId')])
        expected=''.join(speech_text(lookup[i]['text']) for i in ids)
        actual=''.join(speech_text(s['text']) for s in segments)
        if expected!=actual: raise ValueError('Subtitle text mismatch '+source_id)
        words=[w for s in segments for w in s['timestamped_words'] if speech_text(w['word'])]
        actual_words=''.join(speech_text(w['word']) for w in words)
        if actual_words!=expected: raise ValueError('Word text mismatch '+source_id)
        boundaries=[];cursor=0;word_index=0
        for clip_id in ids:
            target=cursor+len(speech_text(lookup[clip_id]['text']))
            chosen=[]
            while cursor<target:
                word=words[word_index];chosen.append(word);cursor+=len(speech_text(word['word']));word_index+=1
            if cursor!=target: raise ValueError('Word straddles clip boundary '+clip_id)
            boundaries.append((min(w['time_begin'] for w in chosen)/1000,max(w['time_end'] for w in chosen)/1000))
        raw_duration=float(probe(source)['format']['duration'])
        for i,clip_id in enumerate(ids):
            clip=lookup[clip_id]
            first,last=boundaries[i]
            prior_end=boundaries[i-1][1] if i else 0
            next_start=boundaries[i+1][0] if i+1<len(ids) else raw_duration
            if next_start<last-0.01: raise ValueError('Overlapping word times '+clip_id)
            start=max(0,first-0.10,(prior_end+first)/2 if i else 0)
            end=min(raw_duration,last+0.30,(last+next_start)/2 if i+1<len(ids) else raw_duration)
            if end<=last or start>first: raise ValueError('Unsafe trim '+clip_id)
            target=PACK/'Audio'/clip['role']/clip['file'];target.parent.mkdir(parents=True,exist_ok=True)
            duration=end-start
            fade=min(0.04,max(0.005,(end-last)/2))
            if not target.exists():
                command(['ffmpeg','-v','error','-y','-i',str(source),'-map_metadata','0','-af',f'atrim=start={start:.6f}:end={end:.6f},asetpts=PTS-STARTPTS,afade=t=out:st={duration-fade:.6f}:d={fade:.6f}','-ac','1','-ar','24000','-c:a','aac','-b:a','32k','-movflags','+faststart+use_metadata_tags',str(target)])
            info=probe(target);stream=info['streams'][0];length=float(info['format']['duration'])
            if stream['codec_name']!='aac' or int(stream['sample_rate'])!=24000 or stream['channels']!=1 or abs(length-duration)>0.10: raise ValueError('Invalid format '+clip_id)
            pcm=array.array('h');pcm.frombytes(command(['ffmpeg','-v','error','-xerror','-i',str(target),'-f','s16le','-acodec','pcm_s16le','-']))
            if not pcm or max(abs(x) for x in pcm)<32: raise ValueError('Silent audio '+clip_id)
            prepared.append(dict(**clip,durationSeconds=round(length,3),sizeBytes=target.stat().st_size,sourceFile=str(source.relative_to(PACK)).replace('\\','/'),sourceStartSeconds=round(start,6),sourceEndSeconds=round(end,6),firstWordSeconds=first,lastWordSeconds=last,taskId=task['id'],versionId=next(o['versionId'] for o in task['outputs'] if o['key']=='primary')))
        print(f'Processed {source_id}: {len(ids)} clips; total {len(prepared)}/847',flush=True)
    if len(prepared)!=847 or len({c['id'] for c in prepared})!=847: raise ValueError('Incomplete cast')
    prepared.sort(key=lambda c:list(lookup).index(c['id']))
    result=dict(model=manifest['model'],defaultParams=manifest['defaultParams'],roles=manifest['roles'],reviewStatus='awaiting-listening-review',clips=prepared)
    (PACK/'coach_lines.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    write_preview(manifest,prepared)
    report=dict(count=len(prepared),roles=len(manifest['roles']),categories=30,totalBytes=sum(c['sizeBytes'] for c in prepared),totalDurationSeconds=round(sum(c['durationSeconds'] for c in prepared),3),estimatedCredits=sum(t.get('billing',{}).get('estimatedCredits',0) for t in tasks),checks=['all requested text matches subtitle words','independent AAC mono 24000Hz','all recordings decode','non-silent audio','word boundaries preserved'],listeningReview='pending')
    (PACK/'build-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(report,ensure_ascii=False))


if __name__=='__main__': main()
