// offscreen/merge.js — 后台合并工人：
// 接收 MERGE_JOB → 分片并发下载视频流+音轨 → mediabunny remux 成单 mp4 → chrome.downloads 保存。
// 过程广播 MERGE_PROGRESS（弹窗若开着会显示），最终发 MERGE_DONE / MERGE_FAIL（background 收到后关闭本页）。

let _busy = false;

function report(type, extra) {
  try { chrome.runtime.sendMessage(Object.assign({ type: type }, extra)).catch(function () {}); } catch (e) {}
}

// 腾讯页面中转接收端：content.js 把主世界下载的分片（base64）流转过来 →
// 这里解码累积 → 全部到齐后复用 mediabunny remux mp4 → MERGE_SAVE 落盘。
let _tqPage = null;
let _tqHeartbeat = null;
function _tqStartHeartbeat() {
  if (_tqHeartbeat) return;
  const t0 = Date.now();
  _tqHeartbeat = setInterval(function () {
    if (!_tqPage) return;
    const sec = Math.floor((Date.now() - t0) / 1000);
    report("MERGE_PROGRESS", { pct: 0.02, stage: "页面中转下载分片 0/" + _tqPage.total + "（已等待 " + sec + " 秒…）" });
  }, 3000);
}
function _tqStopHeartbeat() { if (_tqHeartbeat) { clearInterval(_tqHeartbeat); _tqHeartbeat = null; } }
chrome.runtime.onMessage.addListener(function (msg) {
  if (!msg || !msg.type) return;
  if (msg.type === "TENCENT_PAGE_BEGIN") {
    _tqPage = { name: msg.name || "tencent.mp4", total: msg.total || 0, parts: [], count: 0, bytes: 0 };
    _tqStopHeartbeat();
    _tqStartHeartbeat();
  } else if (msg.type === "TENCENT_PAGE_SEG" && _tqPage) {
    _tqStopHeartbeat();
    try {
      const bin = atob(msg.b64 || "");
      const u = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      _tqPage.parts[msg.index] = u;
      _tqPage.count++;
      _tqPage.bytes += u.length;
      report("MERGE_PROGRESS", {
        pct: 0.02 + 0.93 * (_tqPage.count / Math.max(1, _tqPage.total)),
        stage: "页面中转下载分片 " + _tqPage.count + "/" + _tqPage.total +
          "（已收 " + (_tqPage.bytes / 1048576).toFixed(1) + "MB）"
      });
    } catch (e) {}
  } else if (msg.type === "TENCENT_PAGE_DONE" && _tqPage) {
    _tqStopHeartbeat();
    const job = _tqPage;
    if (msg.tally) job.tally = msg.tally;
    _tqPage = null;
    (async function () {
      try {
        const arr = [];
        let empty = 0;
        for (let i = 0; i < job.parts.length; i++) {
          const p = job.parts[i];
          if (!p || !p.length) { empty++; continue; } // 空片跳过（Uint8Array 空数组是 truthy，必须判 length）
          arr.push(p);
        }
        if (!arr.length) throw new Error("没有拿到任何分片数据（CDN 全部拒绝，签名可能已过期）");
        const tally = job.tally || null;
        const incomplete = tally && tally.total && arr.length < tally.total;
        report("MERGE_PROGRESS", { pct: 0.95, stage: "转封装 mp4（混流 TS → 单文件 mp4）…" });
        const tsBlob = new Blob(arr, { type: "video/mp2t" });
        arr.length = 0;
        job.parts.length = 0;
        let blob = tsBlob;
        try {
          blob = await window.YTMerge.tsToMp4(tsBlob, function (p, m2) {
            report("MERGE_PROGRESS", { pct: 0.95 + 0.04 * p, stage: (m2 || "转封装 mp4") + "…" });
          });
        } catch (re) {
          console.warn("[vdm-tq] mp4 转封装失败，回退 .ts：", re && re.message);
          blob = tsBlob;
        }
        const url = URL.createObjectURL(blob);
        const baseName = (job.name || "tencent.mp4").replace(/\.(ts|mp4)$/i, "");
        // 不完整时在文件名与提示里显式标注，避免用户把残片当成完整视频
        let outName = baseName + ".mp4";
        if (incomplete) {
          outName = baseName + "_不完整(已下" + arr.length + "of" + tally.total + "片).mp4";
          const samples = (tally.samples && tally.samples.length)
            ? "，如 " + tally.samples.join("；") : "";
          const stopAt = tally.stoppedAt ? "（第 " + tally.stoppedAt + " 片起连续失败）" : "";
          report("MERGE_PROGRESS", {
            pct: 0.99,
            stage: "⚠ 仅下到 " + arr.length + "/" + tally.total + " 片" + stopAt +
              "（CDN 拒绝后续分片" + samples + "）——这是残片，不是完整视频"
          });
        } else if (empty) {
          outName = baseName + "_不完整(丢" + empty + "片).mp4";
        }
        report("MERGE_SAVE", { url: url, name: outName, incomplete: !!incomplete });
      } catch (e) {
        report("MERGE_FAIL", { error: String((e && e.message) || e) });
      }
    })();
  } else if (msg.type === "TENCENT_PAGE_FAIL") {
    _tqStopHeartbeat();
    _tqPage = null;
    report("MERGE_FAIL", { error: "腾讯页面中转：" + (msg.error || "未知") });
  }
});

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
  } else if (msg.type === "TENCENT_BG_JOB") {
    // 腾讯视频后台任务：先拉 m3u8 清单解析分片，再逐片下载合并成完整 TS
    _busy = true;
    runTencent(msg).finally(function () { _busy = false; });
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

async function runTencent(job) {
  try {
    const manifestUrl = job.manifestUrl;
    // 允许 popup 直接喂已解析好的分片列表（清单可能来自页面缓存体/内容嗅探，无法二次拉取）
    let segs = Array.isArray(job.segs) ? job.segs.slice() : null;
    if (segs && segs.length) {
      report("MERGE_PROGRESS", { pct: 0.02, stage: "使用已解析分片（共 " + segs.length + " 片）…" });
    } else {
      if (!manifestUrl) throw new Error("缺少 m3u8 地址");
      report("MERGE_PROGRESS", { pct: 0.01, stage: "拉取 m3u8 清单…" });
      const mc = ("AbortController" in window) ? new AbortController() : null;
      const mto = mc ? setTimeout(function () { mc.abort(); }, 20000) : null;
      let mres;
      try {
        mres = await fetch(manifestUrl, { credentials: "include", signal: mc ? mc.signal : undefined });
        if (!mres.ok && /^http:\/\//i.test(manifestUrl)) {
          mres = await fetch(manifestUrl.replace(/^http:/i, "https:"), { credentials: "include", signal: mc ? mc.signal : undefined });
        }
      } finally { if (mto) clearTimeout(mto); }
      if (!mres.ok) throw new Error("m3u8 拉取失败 HTTP " + mres.status);
      const mtext = await mres.text();
      segs = parseHls(mtext, manifestUrl);
      if (!segs.length) throw new Error("m3u8 未解析到分片（可能是多画质变种列表，需进一步适配）");
      report("MERGE_PROGRESS", { pct: 0.02, stage: "开始下载腾讯分片（共 " + segs.length + " 片）…" });
    }
    // 注意：http:// 分片在扩展页（安全上下文）会被混合内容拦截，统一升级 https
    for (var s = 0; s < segs.length; s++) {
      try { segs[s] = segs[s].replace(/^http:\/\//i, "https://"); } catch (e) {}
    }
    const chunks = [];
    let received = 0, lastSent = 0;
    const fmtMB = (n) => (n / 1048576).toFixed(1) + "MB";
    // smtcdns 壳域名剥壳：https://X.v.smtcdns.com/moviets.tc.qq.com/A/... → https://moviets.tc.qq.com/A/...
    // 腾讯 CDN 的 smtcdns host 是 DNS 调度壳，真实 host 是路径第一段；壳域名可能对扩展请求断流。
    function peelSmtcdns(u) {
      const m = /^https:\/\/[^/]+\.v\.smtcdns\.com\/([a-z0-9.-]+\.(?:qq\.com|qcloud\.com))\/(.+)$/i.exec(u);
      return m ? ("https://" + m[1] + "/" + m[2]) : null;
    }
    // 策略轮换：每片最多 4 种取法，一旦某种成功则固定（sticky）用于后续所有分片
    const STRATS = [
      { label: "原始直链+cookie", build: function (u) { return { url: u, creds: "include", headers: {} }; } },
      { label: "原始直链无cookie", build: function (u) { return { url: u, creds: "omit", headers: {} }; } },
      { label: "剥壳真实host", build: function (u) { var p = peelSmtcdns(u); return p ? { url: p, creds: "include", headers: {} } : null; } },
      { label: "剥壳+Range", build: function (u) { var p = peelSmtcdns(u); return p ? { url: p, creds: "omit", headers: { Range: "bytes=0-" } } : null; } }
    ];
    let sticky = -1; // 已验证可行的策略下标
    for (let i = 0; i < segs.length; i++) {
      // 单个分片整体（响应头 + body 读取）共用 15 秒死线：信号在 body 读完后才清除，
      // 避免「响应头到达但 body 挂起」导致 reader.read() 永久等待（卡 2% 的根因）。
      let got = null;
      let lastErr = null;
      let usedStrat = "";
      const rest = [0, 1, 2, 3].filter(function (x) { return x !== sticky; });
      const order = sticky >= 0 ? [sticky].concat(rest) : rest; // sticky 失败自动回退全轮换
      for (var oi = 0; oi < order.length && !got; oi++) {
        const si = order[oi];
        for (var rep = 0; rep < 2 && !got; rep++) {
          const plan = STRATS[si].build(segs[i]);
          if (!plan) { lastErr = new Error("策略不适用（非 smtcdns 壳域名）"); break; }
          if (oi > 0 || rep > 0) await new Promise(function (rn) { setTimeout(rn, 400); });
          const c2 = ("AbortController" in window) ? new AbortController() : null;
          const t2 = c2 ? setTimeout(function () { c2.abort(); }, 15000) : null;
          try {
            const resp = await fetch(plan.url, {
              credentials: plan.creds,
              headers: plan.headers,
              signal: c2 ? c2.signal : undefined
            });
            if (!resp.ok) throw new Error("HTTP " + resp.status);
            const reader = (resp.body && resp.body.getReader) ? resp.body.getReader() : null;
            if (!reader) {
              const b = await resp.arrayBuffer();
              got = b;
            } else {
              const parts = [];
              for (;;) {
                const r2 = await reader.read();
                if (r2.done) break;
                parts.push(r2.value);
                // 片内字节进度：单片慢也能看到数据在走
                const nowIn = Date.now();
                if (nowIn - lastSent > 350) {
                  lastSent = nowIn;
                  report("MERGE_PROGRESS", {
                    pct: 0.02 + 0.93 * (i / segs.length),
                    stage: "下载分片 " + (i + 1) + "/" + segs.length +
                      "（已收 " + fmtMB(received + parts.reduce(function (a, c3) { return a + c3.length; }, 0)) + " · " + STRATS[si].label + "）"
                  });
                }
              }
              got = parts;
            }
            sticky = si; // 该策略已验证可行，后续固定使用
            usedStrat = STRATS[si].label;
          } catch (e3) {
            lastErr = e3;
            got = null; // 换策略/重试
          } finally {
            if (t2) clearTimeout(t2); // body 读完（或放弃）才解除死线
          }
        }
      }
      if (!got) {
        const u = segs[i] || "";
        const uShow = (u.slice(0, 100)) + (u.length > 100 ? "…" : "");
        throw new Error("第 " + (i + 1) + "/" + segs.length + " 片下载失败（4 策略 × 2 次均失败）：" +
          ((lastErr && lastErr.message) || "未知") + " · " + uShow);
      }
      if (got instanceof ArrayBuffer) {
        chunks.push(got); received += got.byteLength;
      } else {
        for (var p2 = 0; p2 < got.length; p2++) { chunks.push(got[p2]); received += got[p2].length; }
      }
      const now = Date.now();
      if (now - lastSent > 350 || i === segs.length - 1) {
        lastSent = now;
        report("MERGE_PROGRESS", {
          pct: 0.02 + 0.93 * ((i + 1) / segs.length),
          stage: "下载分片 " + (i + 1) + "/" + segs.length + "（已收 " + fmtMB(received) + (usedStrat ? " · " + usedStrat : "") + "）"
        });
      }
    }
    report("MERGE_PROGRESS", { pct: 0.95, stage: "转封装 mp4（混流 TS → 单文件 mp4）…" });
    const tsBlob = new Blob(chunks, { type: "video/mp2t" });
    chunks.length = 0;
    let blob = tsBlob;
    try {
      blob = await window.YTMerge.tsToMp4(tsBlob, function (p, msg) {
        report("MERGE_PROGRESS", { pct: 0.95 + 0.04 * p, stage: (msg || "转封装 mp4") + "…" });
      });
    } catch (remuxErr) {
      console.warn("[vdm-tq] mp4 转封装失败，回退 .ts：", remuxErr && remuxErr.message);
      blob = tsBlob;
    }
    const url = URL.createObjectURL(blob);
    const baseName = (job.name || "tencent").replace(/\.ts$/i, "");
    report("MERGE_SAVE", { url: url, name: baseName + ".mp4" });
  } catch (e) {
    report("MERGE_FAIL", { error: String((e && e.message) || e) });
  }
}
