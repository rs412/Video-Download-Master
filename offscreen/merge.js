// offscreen/merge.js — 后台合并工人：
// 接收 MERGE_JOB → 分片并发下载视频流+音轨 → mediabunny remux 成单 mp4 → chrome.downloads 保存。
// 过程广播 MERGE_PROGRESS（弹窗若开着会显示），最终发 MERGE_DONE / MERGE_FAIL（background 收到后关闭本页）。

let _busy = false;

function report(type, extra) {
  try { chrome.runtime.sendMessage(Object.assign({ type: type }, extra)).catch(function () {}); } catch (e) {}
}

chrome.runtime.onMessage.addListener(function (msg) {
  if (!msg || msg.type !== "MERGE_JOB" || _busy) return;
  _busy = true;
  run(msg).finally(function () { _busy = false; });
});

async function run(job) {
  try {
    let lastSent = 0;
    const blob = await YTMerge.mergeAv(job.videoUrl, job.audioUrl, function (p, m) {
      const now = Date.now();
      if (now - lastSent < 400 && p < 1) return; // 进度广播节流
      lastSent = now;
      report("MERGE_PROGRESS", { pct: p, stage: m });
    });

    report("MERGE_PROGRESS", { pct: 0.99, stage: "保存文件…" });
    // offscreen 文档没有 chrome.downloads API → 生成 blob URL 交给 background 保存；
    // 本页面必须保持存活（blob URL 依赖它），落盘完成后由 background 关闭本页释放内存。
    const url = URL.createObjectURL(blob);
    report("MERGE_SAVE", { url: url, name: job.name || "video.mp4" });
  } catch (e) {
    report("MERGE_FAIL", { error: String((e && e.message) || e) });
  }
}
