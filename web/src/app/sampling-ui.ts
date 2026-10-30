import { shareFile } from '../backup';
import { clearSamplingCapture, exportSamplingCapture, samplingCaptureSummary } from '../maia/sampling-capture';

/** Installs settings controls only; recording is owned by the committed-move path. */
export function mountSamplingControls(host: HTMLElement): { refresh(): void } {
  host.innerHTML = `<details class="probability-help"><summary>这些概率和随机性分别是什么意思？</summary>
    <p><b>人类着法预测</b>：Maia 预测指定水平的人选择某步的概率，不代表这步是最佳走法，也不是实际棋手数据库的统计。</p>
    <p><b>实际选中概率</b>：对弈会按 temperature 调整后再抽样。1 保留原分布；0 总选最常见走法；降低温度通常减少变化，也可能增强棋力，不能只当作风格开关。当前对弈 Top-P 固定为 1，不截断候选。</p>
    <p>例如原预测为 60% / 30% / 10%，temperature = 0.5 后实际约为 78.3% / 19.6% / 2.2%。诊断报告会分别列出两种概率。</p>
    <p><b>预期得分</b> = P(胜) + ½ × P(和)，不是纯获胜概率。自由复盘比较中每列双方使用相同等级，并明确当前行棋方视角；它与 Stockfish 评估不同。</p>
    <p>Maia 难度输入不是经过校准的 FIDE / Lichess 等级分。更高预测准确率、更强对弈表现和更多开局变化是不同指标，不能互相替代。</p>
  </details>
  <label class="check"><input type="checkbox" name="samplingCapture" /> 保存 Maia 采样诊断（默认关闭）</label>
  <small class="muted">保存设置后生效。只记录本机实际落子的 Maia 决策，含局面、等级、参数、候选概率和耗时，不上传。最多保留最近 10 局且总量不超过 8 MiB；浏览器容量不足时可能更早写入失败。与棋谱、启动日志和数据备份分开保存。</small>
  <div class="sampling-actions"><button type="button" data-sampling-export="html">导出可读报告</button><button type="button" data-sampling-export="jsonl">导出 JSONL</button><button type="button" data-sampling-clear>清除诊断</button></div>
  <small class="muted" id="sampling-status" role="status"></small>`;
  const status = host.querySelector<HTMLElement>('#sampling-status')!;
  const buttons = [...host.querySelectorAll('button')];
  function refresh() {
    const summary = samplingCaptureSummary();
    status.textContent = summary.ok
      ? `已记录 ${summary.games} 局、${summary.decisions} 次决策（${(summary.bytes / 1024).toFixed(1)} KiB）`
      : `读取诊断失败：${summary.error}`;
  }
  for (const button of host.querySelectorAll<HTMLButtonElement>('[data-sampling-export]')) {
    button.onclick = async () => {
      buttons.forEach(b => { b.disabled = true; });
      try {
        const summary = samplingCaptureSummary();
        if (!summary.ok) throw new Error(summary.error);
        if (!summary.decisions) { status.textContent = '还没有采样记录。保存开启诊断后，与 Maia 对弈即可记录。'; return; }
        const format = button.dataset.samplingExport as 'html' | 'jsonl';
        const text = exportSamplingCapture(format);
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const outcome = await shareFile(`maia-sampling-${stamp}.${format}`, text, format === 'html' ? 'text/html' : 'application/x-ndjson');
        status.textContent = outcome === 'cancelled' ? '已取消导出，记录仍保留。' : '诊断文件已准备完成。';
      } catch (err) {
        status.textContent = `导出失败：${err instanceof Error ? err.message : String(err)}`;
      } finally {
        buttons.forEach(b => { b.disabled = false; });
      }
    };
  }
  host.querySelector<HTMLButtonElement>('[data-sampling-clear]')!.onclick = () => {
    if (!confirm('清除本机全部 Maia 采样诊断？不会删除棋谱或已导出的文件。')) return;
    const outcome = clearSamplingCapture();
    if (outcome.ok) refresh();
    else status.textContent = `清除失败：${outcome.error}`;
  };
  refresh();
  return { refresh };
}
