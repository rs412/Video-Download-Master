// offscreen/merge.js — 后台合并工人：
// 接收 MERGE_JOB → 分片并发下载视频流+音轨 → mediabunny remux 成单 mp4 → chrome.downloads 保存。
// 过程广播 MERGE_PROGRESS（弹窗若开着会显示），最终发 MERGE_DONE / MERGE_FAIL（background 收到后关闭本页）。

let _busy = false;

function report(type, extra) {
  try { chrome.runtime.sendMessage(Object.assign({ type: type }, extra)).catch(function () {}); } catch (e) {}
}


chrome.runtime.onMessage.addListener(function (msg) {
  if (!msg || _busy) return;
  if (msg.type === "MERGE_JOB") {
    _busy = true;
    run(msg).finally(function () { _busy = false; });
  } else if (msg.type === "BILI_BG_JOB") {
    // B 站后台任务：DNR 已由 background 注入 Referer，这里直接在扩展 origin 拉轨
    _busy = true;
    runBili(msg).finally(function () { _busy = false; });
  } else if (msg.type === "IQIYI_BG_JOB") {
    // 爱奇艺后台任务：逐分片下载 HLS/TS 分片（每段带 start/end 完整区间；CDN 对
    // 「无 start/end 参数的整文件直链」会截断大文件），拼接成完整 TS 后交 background 落盘
    _busy = true;
    runIqiyi(msg).finally(function () { _busy = false; });
  }
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

// B 站 DASH 轨道下载：rep = { init:{url,range}|null, segments:[url|{url,range}], mime }
// 流式读取（单个巨型分片也有进度）；扩展 origin fetch + DNR 注入的 Referer
async function downloadTrackRep(rep, label, fromP, toP, job) {
  const parts = [];
  if (rep && rep.init) parts.push(rep.init);
  const segs = (rep && rep.segments) || [];
  for (let i = 0; i < segs.length; i++) parts.push(segs[i]);
  if (!parts.length) throw new Error(label + "：没有可下载段");

  // 总大小：range 段直接可算；普通段等响应头 content-length 计入
  let totalBytes = 0;
  const plainMarks = new Array(parts.length).fill(false);
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const r = (typeof p === "object" && p.range) ? p.range : null;
    if (r && r.length === 2) totalBytes += r[1] - r[0] + 1;
    else plainMarks[i] = true;
  }

  const chunks = [];
  let received = 0, lastSent = 0;
  function prog(force) {
    const now = Date.now();
    if (!force && now - lastSent < 400) return;
    lastSent = now;
    const frac = totalBytes > 0 ? Math.min(0.99, received / totalBytes) : 0;
    const pct = fromP + (toP - fromP) * frac;
    const sizeTxt = totalBytes > 0
      ? Math.round(frac * 100) + "%"
      : Math.round(received / 1024) + " KB";
    report("MERGE_PROGRESS", { pct: pct, stage: "下载" + label + " " + sizeTxt + "…" });
  }
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const url = typeof p === "string" ? p : p.url;
    const range = (typeof p === "object" && p.range) ? p.range : null;
    const headers = {};
    if (range && range.length === 2) headers.Range = "bytes=" + range[0] + "-" + range[1];
    const resp = await fetch(url, { credentials: "include", headers: headers });
    if (!resp.ok) throw new Error(label + "第 " + (i + 1) + "/" + parts.length + " 段下载失败 HTTP " + resp.status);
    if (plainMarks[i]) {
      const cl = parseInt(resp.headers.get("content-length") || "0", 10) || 0;
      if (cl) totalBytes += cl; // 普通段大小就位
    }
    const reader = resp.body && resp.body.getReader ? resp.body.getReader() : null;
    if (!reader) {
      const b = await resp.arrayBuffer();
      chunks.push(b); received += b.byteLength;
    } else {
      for (;;) {
        const r2 = await reader.read();
        if (r2.done) break;
        chunks.push(r2.value);
        received += r2.value.length;
        prog(false);
      }
    }
    prog(true);
  }
  const blob = new Blob(chunks, { type: (rep && rep.mime) || "video/mp4" });
  chunks.length = 0; // 释放引用，Blob 已拷贝数据
  return blob;
}

async function runBili(job) {
  try {
    report("MERGE_PROGRESS", { pct: 0.01, stage: "解析完成，开始下载…" });
    const vBlob = await downloadTrackRep(job.video, "视频流", 0.02, 0.5, job);
    let final;
    if (job.audio) {
      const aBlob = await downloadTrackRep(job.audio, "音轨", 0.5, 0.68, job);
      final = await YTMerge.mergeBlobs(vBlob, aBlob, function (p, m) {
        report("MERGE_PROGRESS", { pct: 0.68 + 0.32 * p, stage: m });
      });
    } else {
      final = vBlob; // 无音轨：直接保存视频流
    }
    report("MERGE_PROGRESS", { pct: 0.99, stage: "保存文件…" });
    const url = URL.createObjectURL(final);
    report("MERGE_SAVE", { url: url, name: job.name || "bilibili.mp4" });
  } catch (e) {
    report("MERGE_FAIL", { error: String((e && e.message) || e) });
  }
}

// 爱奇艺：逐分片下载 → 合并成单个 TS Blob。segments = 全部分片直链（每段带 start/end 完整字节区间，
// 直接 fetch 即返回该区间全部字节）；DNR 已由 background 注入 Referer。
async function runIqiyi(job) {
  try {
    const segs = job.segments || [];
    if (!segs.length) throw new Error("没有可下载的分片");
    report("MERGE_PROGRESS", { pct: 0.01, stage: "开始下载爱奇艺分片（共 " + segs.length + " 片）…" });
    const total = job.totalBytes || 0;
    const chunks = [];
    let received = 0, lastSent = 0;
    for (let i = 0; i < segs.length; i++) {
      const ctrl = ("AbortController" in window) ? new AbortController() : null;
      const to = ctrl ? setTimeout(function () { ctrl.abort(); }, 30000) : null;
      let resp;
      try {
        resp = await fetch(segs[i], { credentials: "include", signal: ctrl ? ctrl.signal : undefined });
      } finally {
        if (to) clearTimeout(to);
      }
      if (!resp.ok) throw new Error("第 " + (i + 1) + "/" + segs.length + " 片下载失败 HTTP " + resp.status);
      const reader = (resp.body && resp.body.getReader) ? resp.body.getReader() : null;
      if (!reader) {
        const b = await resp.arrayBuffer();
        chunks.push(b); received += b.byteLength;
      } else {
        for (;;) {
          const r2 = await reader.read();
          if (r2.done) break;
          chunks.push(r2.value); received += r2.value.length;
        }
      }
      const now = Date.now();
      if (now - lastSent > 350 || i === segs.length - 1) {
        lastSent = now;
        const frac = total > 0 ? Math.min(0.99, received / total) : 0;
        report("MERGE_PROGRESS", {
          pct: 0.02 + 0.96 * frac,
          stage: "下载分片 " + (i + 1) + "/" + segs.length + (total > 0 ? " " + Math.round(frac * 100) + "%" : "")
        });
      }
    }
    report("MERGE_PROGRESS", { pct: 0.99, stage: "保存文件…" });
    const blob = new Blob(chunks, { type: "video/mp2t" });
    chunks.length = 0; // 释放引用，Blob 已拷贝数据
    const url = URL.createObjectURL(blob);
    report("MERGE_SAVE", { url: url, name: job.name || "iqiyi.ts" });
  } catch (e) {
    report("MERGE_FAIL", { error: String((e && e.message) || e) });
  }
}

// 腾讯视频：拉 m3u8 → 解析分片 → 逐片下载合并成完整 TS。DNR 已由 background 注入 Referer（通配 host）。
function parseHls(text, baseUrl) {
  const lines = (text || "").split(/\r?\n/);
  const segs = [];
  for (var i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t || t.charAt(0) === "#") continue; // 跳过标签行（含 #EXTINF / #EXT-X-STREAM-INF 等）
    // 分片 URL：绝对或相对 m3u8 路径
    if (/^https?:\/\//i.test(t)) segs.push(t);
    else { try { segs.push(new URL(t, baseUrl).href); } catch (e) { segs.push(t); } }
  }
  return segs;
}

