// popup.js — 弹出界面：拉取格式 → 在「弹窗内」的沙箱 iframe 批量解密签名 → 下载。
// 沙箱 iframe 必须放在扩展页面（弹窗）内：若放进 YouTube 页面会被其 frame-src CSP 拦截。
// 解密使用 yt-dlp 官方求解器，一次请求同时批量求解 n 与 sig，避免重复解析数 MB 的 player JS。
//
// 交互设计借鉴 yt-dlp：
//   -f bestvideo+bestaudio/b  → 「最佳画质」一键（纯视频流 + 最佳音轨两个文件）
//   -f ba                     → 「最佳音频」一键
//   -S res:720                → 「720p 快速」
//   --write-subs/--convert-subs → 字幕下载（timedtext json3 → srt/vtt/lrc/txt）
//   --write-thumbnail         → 封面下载
//   --write-info-json         → metadata.json 导出
//   -o "%(title)s..."         → 文件名模板（变量见 SETTINGS 说明）

const $ = (id) => document.getElementById(id);
const $list = $("list");
const $err = $("err");

const _pending = new Map();
let _seq = 0;
let _sandboxReady = null;
let _playerCache = { url: null, text: null };

const state = {
  data: null,
  base: null,
  formats: [],
  tab: "all",
  res: "all",
  client: "web",
  bgJob: null, // 后台任务进度 {pct, stage, name, bytes, done, total}；存 session，重开弹窗可续显
  settings: { template: "{title} [{quality}]", askPath: false, subFmt: "srt", client: "auto" }
};

// ---------- 后台任务进度（跨弹窗开关保持可见）----------
// 弹窗关掉后 state 全丢，重开就看不到正在跑的任务了 —— 所以进度同时写 chrome.storage.session，
// 每次开弹窗先回灌；任务结束/失败时清空。
const BG_JOB_KEY = "vdm_bg_job";
function setBgJob(job) {
  state.bgJob = job;
  try { chrome.storage.session.set({ [BG_JOB_KEY]: job }); } catch (e) {}
  renderProgress();
}
async function restoreBgJob() {
  try {
    const o = await chrome.storage.session.get(BG_JOB_KEY);
    if (o && o[BG_JOB_KEY]) state.bgJob = o[BG_JOB_KEY];
  } catch (e) {}
  renderProgress();
}

// ---------- 工具 ----------
function fmtSize(bytes) {
  if (!bytes) return null;
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (i === 0 ? v : v.toFixed(1)) + " " + u[i];
}

function fmtDuration(sec) {
  if (!sec) return "";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const p = (n) => (n < 10 ? "0" + n : String(n));
  return h > 0 ? h + ":" + p(m) + ":" + p(s) : m + ":" + p(s);
}

function fmtCount(n) {
  if (!n) return "";
  if (n >= 1e8) return (n / 1e8).toFixed(1) + " 亿次";
  if (n >= 1e4) return (n / 1e4).toFixed(1) + " 万次";
  return n + " 次";
}

function shortCodec(c) {
  if (!c) return null;
  const s = c.split(".")[0].toLowerCase();
  const map = {
    avc1: "H.264", avc: "H.264", vp9: "VP9", vp09: "VP9",
    av01: "AV1", hvc1: "H.265", hev1: "H.265",
    mp4a: "AAC", opus: "Opus", vorbis: "Vorbis", flac: "FLAC", mp3: "MP3"
  };
  return map[s] || s.toUpperCase();
}

function sanitize(name) {
  return (name || "video").replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 110);
}

function getN(url) {
  try { return new URL(url).searchParams.get("n"); } catch (e) { return null; }
}

function setErr(msg, copyable) {
  if (!msg) { $err.textContent = ""; $err.style.display = "none"; return; }
  $err.textContent = msg;
  $err.style.display = "block";
  $err.style.cursor = copyable === false ? "default" : "pointer";
  $err.title = copyable === false ? "" : "点击复制诊断信息";
  if (copyable !== false) console.warn("[yt-dl]", msg);
}

function toast(msg) {
  setErr(msg, false);
  $err.style.background = "#eef7ff";
  $err.style.borderColor = "#bcdcff";
  $err.style.borderLeftColor = "#0066ff";
  $err.style.color = "#0b4f9c";
  setTimeout(resetErrStyle, 4000);
}

function resetErrStyle() {
  $err.style.background = "";
  $err.style.borderColor = "";
  $err.style.borderLeftColor = "";
  $err.style.color = "";
}

$err.onclick = function () {
  if (!$err.textContent || $err.title !== "点击复制诊断信息") return;
  navigator.clipboard.writeText($err.textContent).then(
    () => { $err.title = "已复制"; setTimeout(() => { $err.title = "点击复制诊断信息"; }, 1500); },
    () => {}
  );
};

// ---------- 文件名（对标 yt-dlp -o 模板）----------
function buildName(f) {
  const m = (state.data && state.data.meta) || {};
  const quality = f.qualityLabel || (f.hasVideo ? f.height + "p" : "") || shortCodec(f.acodec) || f.itag;
  const v = {
    title: m.title || "video",
    author: m.author || "",
    id: m.videoId || "",
    quality: quality,
    itag: String(f.itag || ""),
    ext: f.ext || "mp4",
    date: m.uploadDate || m.publishDate || ""
  };
  let tpl = state.settings.template || "{title} [{quality}]";
  let name = tpl.replace(/\{(\w+)\}/g, (all, k) => (v[k] != null ? v[k] : all));
  return sanitize(name) + "." + (f.ext || "mp4");
}

// ---------- 沙箱 iframe（唯一允许 new Function 的上下文）----------
function getSandbox() {
  if (_sandboxReady) return _sandboxReady;
  _sandboxReady = new Promise((resolve, reject) => {
    const frame = document.createElement("iframe");
    frame.src = chrome.runtime.getURL("sandbox.html");
    frame.sandbox = "allow-scripts";
    frame.style.display = "none";

    const t = setTimeout(() => {
      window.removeEventListener("message", onReady);
      reject(new Error("沙箱 iframe 就绪超时（10s）"));
    }, 10000);

    function onReady(e) {
      if (e.data && e.data.__yt_nsig_ready__) {
        clearTimeout(t);
        window.removeEventListener("message", onReady);
        resolve(frame);
      }
    }
    window.addEventListener("message", onReady);
    document.body.appendChild(frame);
  });
  return _sandboxReady;
}

window.addEventListener("message", (e) => {
  const d = e.data;
  if (d && d.__yt_nsig_res__) {
    const p = _pending.get(d.__yt_nsig_res__.reqId);
    if (p) {
      _pending.delete(d.__yt_nsig_res__.reqId);
      p(d.__yt_nsig_res__);
    }
  }
});

async function fetchPlayerJs(url) {
  if (_playerCache.url === url) return _playerCache.text;
  const r = await fetch(url);
  if (!r.ok) throw new Error("player JS 下载失败：HTTP " + r.status);
  const text = await r.text();
  if (!text || text.length < 10000) {
    throw new Error("player JS 内容异常（长度 " + (text || "").length + "）");
  }
  _playerCache = { url: url, text: text };
  return text;
}

function describeFailure(info) {
  const lines = [];
  lines.push("n: " + info.solvedN + "/" + info.totalN + " 已解密，sig: " + info.solvedS + "/" + info.totalS + " 已解密");
  if (info.nErr) lines.push("求解器错误(n)：" + info.nErr);
  if (info.sigErr) lines.push("求解器错误(sig)：" + info.sigErr);
  if (info.diag) {
    lines.push("player JS 长度：" + info.diag.playerLen);
    lines.push("含 ('alr','yes') 指纹：" + (info.diag.hasFingerprint ? "是" : "否 ← 抓到的可能不是 player 主文件，或指纹已变更"));
  }
  return lines.join("\n");
}

async function descrambleAll(formats, playerJs, playerUrl) {
  const nEntries = [];
  const sigEntries = [];
  for (const f of formats) {
    if (!f.url) continue;
    const n = getN(f.url);
    if (n) nEntries.push({ f: f, n: n });
    if (f.sig) sigEntries.push({ f: f, s: f.sig });
  }
  if (!nEntries.length && !sigEntries.length) return null;

  const frame = await getSandbox();
  const nChallenges = Array.from(new Set(nEntries.map((e) => e.n)));
  const sigChallenges = Array.from(new Set(sigEntries.map((e) => e.s)));
  const reqId = ++_seq;

  const res = await new Promise((resolve) => {
    _pending.set(reqId, resolve);
    frame.contentWindow.postMessage(
      {
        __yt_nsig__: {
          reqId: reqId,
          playerJs: playerJs,
          url: playerUrl,
          challenges: nChallenges,
          sigChallenges: sigChallenges
        }
      },
      "*"
    );
    setTimeout(() => {
      if (_pending.has(reqId)) {
        _pending.delete(reqId);
        resolve({ ok: false, error: "求解超时（30s）——player JS 过大或求解器卡住" });
      }
    }, 30000);
  });

  if (!res || !res.ok) return { error: (res && res.error) || "签名解密失败（沙箱无响应）" };

  const nMap = res.data || {};
  let solvedN = 0;
  for (const e of nEntries) {
    const dn = nMap[e.n];
    if (!dn || dn === e.n) continue;
    try {
      const u = new URL(e.f.url);
      u.searchParams.set("n", dn);
      e.f.url = u.toString();
      solvedN++;
    } catch (err) {}
  }

  const sMap = res.sigData || {};
  let solvedS = 0;
  for (const e of sigEntries) {
    const ds = sMap[e.s];
    if (!ds || ds === e.s) continue;
    try {
      const u = new URL(e.f.url);
      u.searchParams.set(e.f.sp || "signature", ds);
      e.f.url = u.toString();
      e.f.sig = null;
      solvedS++;
    } catch (err) {}
  }

  const info = {
    solvedN: solvedN, totalN: nEntries.length,
    solvedS: solvedS, totalS: sigEntries.length,
    diag: res.diag || null, nErr: res.nErr || null, sigErr: res.sigErr || null
  };
  const failed =
    (info.totalN > 0 && info.solvedN < info.totalN) ||
    (info.totalS > 0 && info.solvedS < info.totalS);
  if (failed) info.error = describeFailure(info);
  return info;
}

// ---------- 下载 ----------
let _hlsBusy = false;

function doDownload(f, suffix) {
  if (f.isHls) { doHlsDownload(f); return "HLS"; }
  const name = buildName(f);
  const finalName = suffix ? name.replace(/(\.\w+)$/, suffix + "$1") : name;
  chrome.downloads.download(
    { url: f.url, filename: finalName, saveAs: !!state.settings.askPath },
    (id) => {
      if (chrome.runtime.lastError) toast("下载失败：" + chrome.runtime.lastError.message);
      else watchDownload(id, finalName, f.itag);
    }
  );
  return finalName;
}

// 下载被服务器拒绝（403）时：立即报错 + 把该格式标记置灰，杜绝「点了没反应」的困惑
function markBadByItag(itag) {
  const f = state.formats.find((x) => String(x.itag) === String(itag));
  if (f && !f.bad) {
    f.bad = true;
    renderList();
  }
}

function pickBestAudio() {
  const cands = state.formats.filter((f) => !f.bad && f.url && f.hasAudio && !f.hasVideo);
  if (!cands.length) return null;
  return cands.slice().sort((a, b) => b.bitrate - a.bitrate)[0];
}

// HLS 下载：解析 m3u8 → 并发拉分段 → 内存拼接 → 保存 mp4（预合并流，无需 ffmpeg）
async function doHlsDownload(f) {
  if (_hlsBusy) { toast("已有 HLS 下载进行中，请等它完成"); return; }
  _hlsBusy = true;
  const showPct = (msg) => {
    $err.textContent = msg;
    $err.style.display = "block";
    $err.style.cursor = "default";
  };
  try {
    showPct("HLS：解析清单…（下载期间请保持弹窗打开）");
    const info = await YTHls.resolveBestVariant(f.url);
    if (info.height && !f.height) f.height = info.height;
    const blob = await YTHls.download(info, (d, t) => {
      showPct("HLS 下载进度：" + Math.round((d / t) * 100) + "%（" + d + "/" + t + " 段）—— 请保持弹窗打开");
    });
    showPct("HLS：保存文件…");
    const name = buildName(f);
    const url = URL.createObjectURL(blob);
    chrome.downloads.download(
      { url: url, filename: name, saveAs: !!state.settings.askPath },
      (id) => {
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        if (chrome.runtime.lastError) toast("下载失败：" + chrome.runtime.lastError.message);
        else { setErr(""); watchDownload(id, name); }
      }
    );
  } catch (e) {
    toast("HLS 下载失败：" + String((e && e.message) || e));
  } finally {
    _hlsBusy = false;
  }
}

// 合并用音轨：优先 AAC/m4a（mp4 容器兼容性最好），没有再取最高码率的
function pickMergeAudio() {
  const a = pickBestAudio();
  if (!a) return null;
  const aacs = state.formats
    .filter((f) => !f.bad && f.url && f.hasAudio && !f.hasVideo && /mp4a/.test(f.acodec || ""))
    .sort((x, y) => y.bitrate - x.bitrate);
  return aacs[0] || a;
}

// 纯视频流无声轨：优先转入后台 offscreen 合并（弹窗可关闭）；
// 后台不可用时回退弹窗内合并（需保持打开）；合并本身失败则分文件下载
async function downloadVideoWithAudio(f) {
  const a = pickMergeAudio();
  if (!a) {
    const vName = doDownload(f);
    toast("已下载视频流：" + vName + "\n（未找到纯音轨，该文件无声）");
    return;
  }

  // 1) 后台合并（offscreen document，不受弹窗生命周期影响）
  let bgOk = false;
  try {
    const resp = await chrome.runtime.sendMessage({
      type: "MERGE_START",
      videoUrl: f.url,
      audioUrl: a.url,
      name: buildName(f)
    });
    if (resp && resp.ok) {
      bgOk = true;
      toast("合并已转入后台，本弹窗可以关闭；完成后文件自动保存到浏览器下载。");
    } else if (resp && resp.error) {
      // 后台明确拒绝（如已有任务进行中）：提示等待，不另起弹窗内合并
      toast(resp.error);
      return;
    }
  } catch (e) {}

  if (bgOk) return;

  // 2) 回退：弹窗内合并（进度可见，但需保持弹窗打开）
  const showPct = (msg) => {
    $err.textContent = msg;
    $err.style.display = "block";
    $err.style.cursor = "default";
  };

  try {
    showPct("自动合并：下载视频流与音轨…（请保持弹窗打开）");
    const blob = await YTMerge.mergeAv(f.url, a.url, (p, msg) => {
      showPct("自动合并 " + Math.round(p * 100) + "%：" + msg + " —— 请保持弹窗打开");
    });
    showPct("自动合并：保存文件…");
    const name = buildName(f);
    const url = URL.createObjectURL(blob);
    chrome.downloads.download(
      { url: url, filename: name, saveAs: !!state.settings.askPath },
      () => {
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        if (chrome.runtime.lastError) toast("下载失败：" + chrome.runtime.lastError.message);
        else { setErr(""); resetErrStyle(); }
      }
    );
    toast("已下载合并后的单文件（含音轨）：" + name);
  } catch (e) {
    const vName = doDownload(f, ".video");
    const aName = doDownload(a, ".audio");
    toast(
      "自动合并失败（" + String((e && e.message) || e) + "），已分开下载两个文件：\n" +
        vName + "\n" + aName + "\n\n" +
        "合并命令：\nffmpeg -i \"" + vName + "\" -i \"" + aName + "\" -c copy 输出.mp4"
    );
  }
}

function copyLink(f) {
  navigator.clipboard.writeText(f.url).then(
    () => toast("直链已复制到剪贴板（有效期较短，请尽快使用）"),
    () => toast("复制失败，请手动从控制台获取")
  );
}

// ---------- 渲染 ----------
function renderMeta() {
  const m = state.data.meta || {};
  const box = $("meta");
  if (!m.title) { box.classList.add("hidden"); return; }
  box.classList.remove("hidden");
  const img = $("thumb");
  if (m.thumbnail) { img.src = m.thumbnail; img.style.display = ""; }
  else img.style.display = "none";
  $("title").textContent = m.title;
  const bits = [];
  if (m.author) bits.push(m.author);
  if (m.lengthSeconds) bits.push(fmtDuration(m.lengthSeconds));
  if (m.viewCount) bits.push(fmtCount(m.viewCount));
  if (m.publishDate) bits.push(m.publishDate.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3"));
  $("sub").textContent = bits.join(" · ");
  $("sub").title = m.title;
}

function renderQuick() {
  $("quick").classList.remove("hidden");
  const ok = state.formats.filter((f) => !f.bad && f.url);
  const audio = ok.filter((f) => f.hasAudio && !f.hasVideo);
  $("quick").querySelector('[data-quick="audio"]').disabled = audio.length === 0;
}

function renderFilters() {
  const box = $("filters");
  box.classList.remove("hidden");
  const heights = Array.from(
    new Set(state.formats.filter((f) => !f.bad && f.hasVideo && f.height).map((f) => f.height))
  ).sort((a, b) => b - a);
  if (!heights.length) { box.innerHTML = ""; return; }

  let html = '<button class="chip' + (state.res === "all" ? " active" : "") + '" data-res="all">全部</button>';
  for (const h of heights) {
    html += '<button class="chip' + (String(state.res) === String(h) ? " active" : "") +
      '" data-res="' + h + '">' + h + "p</button>";
  }
  box.innerHTML = html;
  box.querySelectorAll(".chip").forEach((c) => {
    c.onclick = () => {
      state.res = c.dataset.res === "all" ? "all" : parseInt(c.dataset.res, 10);
      renderFilters();
      renderList();
    };
  });
}

function kindOf(f) {
  if (f.type === "progressive") return "progressive";
  return f.hasVideo ? "video" : "audio";
}

function visibleFormats() {
  return state.formats.filter((f) => {
    if (!f.url) return false;
    if (state.tab !== "all" && kindOf(f) !== state.tab) return false;
    if (state.res !== "all" && f.hasVideo && f.height !== state.res) return false;
    return true;
  });
}

function renderList() {
  const all = state.formats.filter((f) => f.url);
  const list = visibleFormats()
    .slice()
    .sort(
      (a, b) =>
        (b.height || 0) - (a.height || 0) ||
        (b.bitrate || 0) - (a.bitrate || 0) ||
        (b.fps || 0) - (a.fps || 0)
    );

  $list.innerHTML = "";
  if (!list.length) {
    const d = document.createElement("div");
    d.className = "empty";
    d.textContent = "没有符合当前筛选条件的格式";
    $list.appendChild(d);
    return;
  }

  for (const f of list) {
    const kind = kindOf(f);
    const el = document.createElement("div");
    el.className = "row" + (f.bad ? " bad" : "");

    const main = document.createElement("div");
    main.className = "row-main";

    const top = document.createElement("div");
    top.className = "row-top";

    const badge = document.createElement("span");
    badge.className = "badge" + (kind === "audio" ? " audio" : kind === "progressive" ? " merged" : "");
    badge.textContent = f.qualityLabel || (f.hasVideo ? f.height + "p" : "音频") || f.itag;
    top.appendChild(badge);

    if (f.fps && f.fps > 30) {
      const s = document.createElement("span");
      s.className = "mini hi";
      s.textContent = f.fps + "fps";
      top.appendChild(s);
    }
    if (kind === "progressive") {
      const s = document.createElement("span");
      s.className = "mini";
      s.textContent = "含音轨";
      top.appendChild(s);
    }
    if (kind === "video") {
      const s = document.createElement("span");
      s.className = "mini warn";
      s.textContent = "无声";
      top.appendChild(s);
    }
    if (f.bad) {
      const s = document.createElement("span");
      s.className = "mini warn";
      s.textContent = "签名未解密";
      top.appendChild(s);
    }
    main.appendChild(top);

    const sub = document.createElement("div");
    sub.className = "row-sub";
    const parts = [f.ext];
    if (f.hasVideo && f.vcodec) parts.push(shortCodec(f.vcodec));
    if (f.hasAudio && f.acodec) parts.push(shortCodec(f.acodec));
    const sz = fmtSize(f.filesize);
    if (sz) parts.push((f.filesizeApprox ? "≈" : "") + sz);
    if (f.hasAudio && !f.hasVideo && f.bitrate) parts.push(Math.round(f.bitrate / 1000) + "kbps");
    parts.push("itag " + f.itag);
    sub.textContent = parts.join(" · ");
    sub.title = f.mimeType;
    main.appendChild(sub);
    el.appendChild(main);

    const acts = document.createElement("div");
    acts.className = "row-actions";

    const btn = document.createElement("button");
    btn.className = "dl";
    btn.textContent = "下载";
    btn.disabled = !!f.bad;
    btn.onclick = () => {
      if (kind === "video") downloadVideoWithAudio(f);
      else doDownload(f);
    };
    acts.appendChild(btn);

    if (kind === "video" && !f.bad) {
      const b2 = document.createElement("button");
      b2.className = "icon-btn";
      b2.textContent = "仅视频";
      b2.title = "只下载无声视频流";
      b2.onclick = () => doDownload(f);
      acts.appendChild(b2);
    }

    const copy = document.createElement("button");
    copy.className = "icon-btn";
    copy.textContent = "⧉";
    copy.title = "复制直链";
    copy.onclick = () => copyLink(f);
    acts.appendChild(copy);

    el.appendChild(acts);
    $list.appendChild(el);
  }

  const badCount = all.length - all.filter((f) => !f.bad).length;
  if (badCount === all.length) {
    setErr("所有格式均需签名解密但解密失败：\n" +
      (state.data._nsigError ||
        (state.data._nsigInfo ? describeFailure(state.data._nsigInfo) : "未知原因")));
  } else if (badCount) {
    setErr(badCount + " 个格式因签名未解密已置灰。\n" + (state.data._nsigError || ""));
  } else {
    setErr("");
  }
}

function renderExtra() {
  $("extra").classList.remove("hidden");
  const m = state.data.meta || {};
  const sel = $("subLang");
  const caps = m.captions || [];
  sel.innerHTML = "";
  if (!caps.length) {
    const o = document.createElement("option");
    o.textContent = "该视频无字幕轨";
    sel.appendChild(o);
    sel.disabled = true;
  } else {
    sel.disabled = false;
    for (const c of caps) {
      const o = document.createElement("option");
      o.value = c.baseUrl || "";
      o.textContent = c.name + (c.kind === "asr" ? "（自动生成）" : "");
      sel.appendChild(o);
    }
  }
  $("dlSub").disabled = !caps.length;
  $("dlThumb").disabled = !m.thumbnail;
  $("dlChapters").disabled = !(m.chapters && m.chapters.length);

  const selClient = $("clientSel");
  if (selClient.dataset.filled !== "1") {
    selClient.innerHTML = '<option value="auto">自动（优先可用高清）</option>';
    for (const c of YTClients.CLIENTS) {
      const o = document.createElement("option");
      o.value = c.id;
      o.textContent = c.label;
      selClient.appendChild(o);
    }
    selClient.dataset.filled = "1";
  }
  selClient.value = state.settings.client || "auto";
  const cur = YTClients.getClient(selClient.value);
  $("clientHint").textContent =
    selClient.value === "auto"
      ? "自动：先试网页直链，不足高清则依次尝试页面 PO Token → Vision OS → TV 降级版 → Web Embedded → Web Safari(HLS)。"
      : cur && cur.note
      ? cur.note
      : "";
}

// ---------- 附加资源下载 ----------
function downloadText(text, filename, mime) {
  const blob = new Blob([text], { type: (mime || "text/plain") + ";charset=utf-8" });
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url: url, filename: filename, saveAs: false }, () => {
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    if (chrome.runtime.lastError) toast("下载失败：" + chrome.runtime.lastError.message);
  });
}

async function onDownloadSubtitle() {
  const sel = $("subLang");
  const url = sel.value;
  if (!url) return;
  const m = state.data.meta || {};
  const track = (m.captions || []).find((c) => c.baseUrl === url) || {};
  const lang = track.languageCode || "sub";
  const fmt = $("subFmt").value;
  try {
    const r = await YTSubs.fetchSubtitle(url, fmt);
    downloadText(r.text, sanitize(m.title) + "." + lang + "." + r.ext, "text/plain");
    toast("字幕已保存（" + r.count + " 条）");
  } catch (e) {
    toast("字幕下载失败：" + String((e && e.message) || e));
  }
}

function onDownloadThumb() {
  const m = state.data.meta || {};
  if (!m.thumbnail) return;
  chrome.downloads.download(
    { url: m.thumbnail, filename: sanitize(m.title) + ".jpg", saveAs: false },
    () => { if (chrome.runtime.lastError) toast("封面下载失败：" + chrome.runtime.lastError.message); }
  );
}

function onDownloadJson() {
  const d = state.data;
  const payload = {
    id: d.meta.videoId,
    title: d.meta.title,
    uploader: d.meta.author,
    channel_id: d.meta.channelId,
    duration: d.meta.lengthSeconds,
    view_count: d.meta.viewCount,
    upload_date: d.meta.uploadDate || d.meta.publishDate,
    categories: [d.meta.category],
    description: d.meta.shortDescription,
    thumbnail: d.meta.thumbnail,
    chapters: (d.meta.chapters || []).map((c) => ({ title: c.title, start_time: c.startMs / 1000 })),
    formats: d.formats.map((f) => ({
      format_id: String(f.itag),
      ext: f.ext,
      resolution: f.hasVideo ? f.width + "x" + f.height : null,
      fps: f.fps || null,
      vcodec: f.vcodec,
      acodec: f.acodec,
      filesize: f.filesize,
      filesize_approx: f.filesizeApprox ? f.filesize : null,
      tbr: f.bitrate ? f.bitrate / 1000 : null
    }))
  };
  downloadText(JSON.stringify(payload, null, 2), sanitize(d.meta.title) + ".info.json", "application/json");
}

function onDownloadChapters() {
  const m = state.data.meta || {};
  if (!m.chapters || !m.chapters.length) return;
  downloadText(YTSubs.chaptersToText(m.chapters), sanitize(m.title) + ".chapters.txt", "text/plain");
}

// ---------- 一键下载（对标 -f bv+ba/b 等）----------
function bestOf(list) {
  if (!list || !list.length) return null;
  return list
    .slice()
    .sort(
      (a, b) =>
        (b.height || 0) - (a.height || 0) ||
        (b.bitrate || 0) - (a.bitrate || 0) ||
        (b.fps || 0) - (a.fps || 0)
    )[0];
}

function quickDownload(kind) {
  const ok = state.formats.filter((f) => !f.bad && f.url);
  if (!ok.length) return;

  if (kind === "audio") {
    const a = pickBestAudio();
    if (a) doDownload(a);
    return;
  }

  const videos = ok.filter((f) => f.hasVideo);
  const merged = videos.filter((f) => f.type === "progressive");
  const pure = videos.filter((f) => f.type !== "progressive");

  let target;
  if (kind === "fast") {
    // 优先 720p 以内「含音轨」的合并格式（可直接播放），否则退到纯视频流
    const pool720 = videos.filter((f) => f.height && f.height <= 720);
    const pool = pool720.length ? pool720 : videos;
    target = bestOf(pool.filter((f) => f.type === "progressive")) || bestOf(pool);
  } else {
    const bm = bestOf(merged);
    const bp = bestOf(pure);
    target = bp && (!bm || (bp.height || 0) > (bm.height || 0)) ? bp : bm;
  }

  if (!target) return;
  if (target.type === "progressive") doDownload(target);
  else downloadVideoWithAudio(target);
}

// ---------- 下载进度 ----------
const _active = new Map();
function watchDownload(id, name, itag) {
  if (!id) return;
  chrome.downloads.search({ id: id }, (items) => {
    if (items && items[0]) _active.set(id, { name: name, itag: itag, received: 0, total: items[0].totalBytes || 0 });
    renderProgress();
  });
}

function renderProgress() {
  const box = $("progress");
  const job = state.bgJob;
  if (!_active.size && !job) { box.classList.add("hidden"); box.innerHTML = ""; return; }
  box.classList.remove("hidden");
  let html = "";
  // 后台合并任务（B站/爱奇艺/腾讯，含页面中转）：单独一行带进度条
  if (job) {
    const jp = Math.max(0, Math.min(100, Math.round((job.pct || 0) * 100)));
    const tail = job.done && job.total
      ? " · " + job.done + "/" + job.total + " 片" + (job.bytes ? " · " + (job.bytes / 1048576).toFixed(1) + "MB" : "")
      : (job.bytes ? " · " + (job.bytes / 1048576).toFixed(1) + "MB" : "");
    html += '<div class="pg"><span>' + String(job.name || "后台任务").slice(0, 22) +
      '</span><span class="bar"><i style="width:' + jp + '%"></i></span><span>' + jp + "%</span></div>" +
      '<div class="pg-stage">' + (job.stage || "") + tail + "</div>";
  }
  _active.forEach((v) => {
    const pct = v.total ? Math.min(100, Math.round((v.received / v.total) * 100)) : 0;
    html += '<div class="pg"><span>' + v.name.slice(0, 22) +
      '</span><span class="bar"><i style="width:' + pct + '%"></i></span><span>' +
      (v.total ? pct + "%" : fmtSize(v.received) || "…") + "</span></div>";
  });
  box.innerHTML = html;
}

chrome.downloads.onChanged.addListener((d) => {
  if (!_active.has(d.id)) return;
  if (d.bytesReceived) _active.get(d.id).received = d.bytesReceived.current;
  if (d.state && (d.state.current === "complete" || d.state.current === "interrupted")) {
    const item = _active.get(d.id);
    _active.delete(d.id);
    renderProgress();
    if (d.state.current === "interrupted" && d.error && d.error.current === "SERVER_FORBIDDEN") {
      if (item && item.itag !== undefined) markBadByItag(item.itag);
      toast(
        "HTTP 403：该格式被 YouTube 拒绝（缺 PO Token），已标记置灰。\n" +
          "请点右上角 ↻ 重试，或在「设置 → 数据源」切换（TV / Web Embedded / Web Safari HLS）。"
      );
    } else if (d.state.current === "interrupted" && d.error && d.error.current) {
      toast("下载中断：" + d.error.current);
    }
  }
  renderProgress();
});

// ---------- 后台合并（offscreen）进度与结果 ----------
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg) return;
  // 爱奇艺后台任务：进度/结果单独落到绿卡状态行（弹窗开着时可见）
  const iq = document.getElementById("iqStatus");
  function setIq(t, cls) { if (iq) { iq.textContent = t; iq.className = "iq-status" + (cls ? " " + cls : ""); } }
  // 腾讯视频后台任务：进度/结果落到蓝卡状态行
  const tq = document.getElementById("tqStatus");
  function setTq(t, cls) { if (tq) { tq.textContent = t; tq.className = "tq-status" + (cls ? " " + cls : ""); } }
  if (msg.type === "MERGE_PROGRESS") {
    const txt = "后台下载 " + Math.round((msg.pct || 0) * 100) + "%：" + (msg.stage || "") +
      "（可关闭本弹窗和页面）";
    const job = { pct: msg.pct || 0, stage: msg.stage || "", name: state.bgJob && state.bgJob.name ? state.bgJob.name : "后台任务" };
    if (state.iqMergeActive && iq) { setIq(txt); job.name = "爱奇艺"; setBgJob(job); }
    else if (state.tqMergeActive && tq) { setTq(txt); job.name = "腾讯视频"; setBgJob(job); }
    else if (state.bgJob) { setBgJob(Object.assign({}, state.bgJob, { pct: msg.pct || 0, stage: msg.stage || "" })); }
    else {
      $err.textContent = txt;
      $err.style.display = "block";
      $err.style.cursor = "default";
    }
  } else if (msg.type === "TENCENT_PAGE_PROG") {
    // 页面中转的实时进度（content.js 转发自主世界）：片计数 + 字节进度，首片未完成时也能看到活动
    const done = msg.done || 0, total = msg.total || 0;
    const pct = total ? Math.min(0.93, 0.02 + 0.91 * (done / total)) : 0.02;
    if (state.tqMergeActive && tq) {
      const kb = msg.bytes ? "（已收 " + (msg.bytes / 1048576).toFixed(1) + "MB）" : "";
      setTq("页面中转下载分片 " + done + "/" + (total || "?") + kb + "…");
    }
    setBgJob({
      pct: pct, stage: "页面中转下载分片 " + done + "/" + (total || "?"),
      name: "腾讯视频", bytes: msg.bytes || 0, done: done, total: total
    });
  } else if (msg.type === "MERGE_DONE") {
    setBgJob(null);
    if (state.iqMergeActive) { state.iqMergeActive = false; setIq("下载完成：" + (msg.name || ""), "ok"); }
    if (state.tqMergeActive) { state.tqMergeActive = false; setTq("下载完成：" + (msg.name || ""), "ok"); }
    resetErrStyle();
    toast("后台合并完成，已保存到浏览器下载：" + (msg.name || ""));
  } else if (msg.type === "MERGE_FAIL") {
    setBgJob(null);
    if (state.iqMergeActive) { state.iqMergeActive = false; setIq("下载失败：" + (msg.error || "未知原因"), "err"); }
    if (state.tqMergeActive) { state.tqMergeActive = false; setTq("下载失败：" + (msg.error || "未知原因"), "err"); }
    resetErrStyle();
    toast("后台合并失败：" + (msg.error || "未知原因"));
  } else if (msg.type === "VM_SE_MSE_PROG" || msg.type === "VM_SE_MSE_DONE") {
    // 腾讯「边播边存」录制：播放器每往 MSE 缓冲塞一片，media-main.js 就通知一次已捕获字节
    const rec = document.getElementById("tqRecInfo");
    const saveBtn = document.getElementById("tqSaveBtn");
    const sizeMB = msg.size ? (msg.size / 1048576).toFixed(1) : "0";
    state._mseSize = msg.size || 0;
    if (rec) {
      const tail = msg.complete || msg.type === "VM_SE_MSE_DONE" ? "（播放到片尾，已完整）" : "";
      rec.textContent = "边播边存：已捕获 " + sizeMB + " MB · " + (msg.tracks || 0) + " 条轨道" + tail;
      rec.className = "tq-rec-info" + (msg.size > 0 ? " ok" : "");
    }
    if (saveBtn) saveBtn.disabled = !(msg.size > 0);
  }
});

// ---------- 设置持久化 ----------
function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(["ytDlSettings"], (r) => {
      if (r && r.ytDlSettings) Object.assign(state.settings, r.ytDlSettings);
      resolve();
    });
  });
}

function saveSettings() {
  chrome.storage.sync.set({ ytDlSettings: state.settings });
}

// ---------- 签名解密（n 与 sig，一次批量）----------
async function decryptFormats(data) {
  for (const f of data.formats) {
    f._n0 = f.url ? getN(f.url) : null;
    f._s0 = f.sig || null;
  }

  if (data.formats.some((f) => f._n0 || f._s0)) {
    if (!data.playerJsUrl) {
      data._nsigError = "未找到 player JS 地址";
    } else {
      try {
        const playerJs = await fetchPlayerJs(data.playerJsUrl);
        const info = await descrambleAll(data.formats, playerJs, data.playerJsUrl);
        if (info) {
          console.log("[yt-dl] nsig 诊断:", info);
          data._nsigInfo = info;
          if (info.error) data._nsigError = info.error + "\nplayer: " + data.playerJsUrl;
        }
      } catch (e) {
        data._nsigError = String((e && e.message) || e) + "\nplayer: " + data.playerJsUrl;
      }
    }
  }

  for (const f of data.formats) {
    if (!f.url) continue;
    const nUnchanged = !!f._n0 && getN(f.url) === f._n0;
    const sigUnchanged = !!f._s0 && !!f.sig;
    f.bad = nUnchanged || sigUnchanged;
    delete f._n0;
    delete f._s0;
  }
}

// ---------- 数据源选择：绕过 web 客户端的 GVS PO Token ----------
// 回退优先级：
//   1) web 直链探测通过 → 直接用（不折腾）
//   2) PO Token 注入：页面播放器播放时发出的 googlevideo URL 自带 pot，
//      把 pot 拼到高清格式 URL 上再探测（pot 绑定访客+视频，不绑定 itag）
//   3) 换 InnerTube 客户端（tv 等，页面主世界带 cookie 请求）
function setStatus(msg) {
  $list.innerHTML = '<div class="empty">' + msg + "</div>";
}

// PO Token 注入回退：成功返回数据源对象，失败返回 null（不污染 base，直到探测通过才落地）
async function tryPotFallback(base) {
  const gvs = base.gvs;
  const hasPot = !!(gvs && (gvs.pot || (gvs.urls && Object.keys(gvs.urls).length)));
  if (!hasPot) {
    state._potNote = "页面未捕获到 PO Token（pot）—— 让视频播放几秒后再点重试";
    return null;
  }

  function withPot(u, itag) {
    // 播放器亲自用过的 URL 最可靠，直接采用
    if (gvs.urls && gvs.urls[itag]) return gvs.urls[itag];
    if (!gvs.pot || /[?&]pot=/.test(u)) return null;
    return u + (u.indexOf("?") >= 0 ? "&" : "?") +
      "pot=" + encodeURIComponent(gvs.pot) + "&potc=1";
  }

  const cands = base.formats
    .filter((f) => f.url && f.hasVideo)
    .sort((a, b) => (b.height || 0) - (a.height || 0))
    .slice(0, 6);

  setStatus("尝试页面 PO Token（pot）…");
  for (const f of cands) {
    const nu = withPot(f.url, f.itag);
    if (!nu) continue;
    const p = await YTClients.probe(nu);
    if (p.ok) {
      // 第一条通过后再验证一条不同 itag，防单条 URL 偶然通过
      const next = cands.find((g) => g !== f);
      if (next) {
        const nu2 = withPot(next.url, next.itag);
        const p2 = nu2 ? await YTClients.probe(nu2) : { ok: false };
        if (!p2.ok) continue;
      }
      // 门槛：pot 只能注入到「已有直链」的格式。若直链仍只覆盖低清（SABR），pot 再有效也救不了高清
      const hs = videoHeights(base.formats);
      if (hs.probe < hs.all && hs.probe < 720) {
        state._potNote = "pot 验证通过，但直链仅覆盖 " + hs.probe + "p / 页面最高 " + hs.all + "p → 继续回退";
        return null;
      }
      // pot 已验证有效，统一应用到所有格式
      for (const g of base.formats) {
        if (!g.url) continue;
        const u2 = withPot(g.url, g.itag);
        if (u2) g.url = u2;
      }
      return { data: base, client: "web+pot", probed: true, potUsed: true,
        detail: "pot 注入双档验证通过（含播放器捕获 " + Object.keys(gvs.urls || {}).length + " 条 URL）" };
    }
  }
  state._potNote = "页面 pot 注入后直链仍被拒（403）";
  return null;
}

// 通过 content 脚本让「页面主世界」请求指定客户端，并解密签名，返回可直接用的 parsed 数据
async function getClientVideoViaPage(client, base, tabId) {
  const resp = await chrome.tabs.sendMessage(tabId, {
    type: "GET_CLIENT_VIDEO",
    client: client, // 整个 spec 原样透传（main.js 按 ctx/clientName/clientVersion/clientId/auth/embedUrl 组装）
    ytcfg: base.ytcfg
  });
  if (!resp || !resp.ok) return { ok: false, error: (resp && resp.error) || "客户端请求失败" };

  const parsed = resp.data;
  parsed.playerJsUrl = parsed.playerJsUrl || base.playerJsUrl; // 同 player，nsig 求解器通用
  parsed.ytcfg = parsed.ytcfg || base.ytcfg;
  await decryptFormats(parsed);
  return { ok: true, parsed: parsed };
}

// 页面声明的最高视频档 vs 有直链的最高档。
// SABR 改版下 web 数据的高清格式没有直链（url=null），只有 360p(itag 18) 有 ——
// 此时即使 360p 探测通过也不能用 web 数据源，必须走回退链。
function videoHeights(formats) {
  let all = 0, probe = 0;
  for (const f of formats) {
    if (!f.hasVideo || !f.height) continue;
    all = Math.max(all, f.height);
    if (f.url) probe = Math.max(probe, f.height);
  }
  return { all: all, probe: probe };
}

// HLS 行：预合并音视频的 m3u8 清单（免 PO Token 的高清兜底，逐段拼接下载）
function hlsFormat(url) {
  return {
    itag: "hls",
    qualityLabel: "HLS 最高画质",
    mimeType: "application/x-mpegurl",
    ext: "mp4",
    hasVideo: true,
    hasAudio: true,
    type: "progressive",
    url: url,
    isHls: true,
    bitrate: 0,
    height: 0,
    filesize: null
  };
}

async function resolveSource(base, tab) {
  const tabId = tab && tab.id;
  const videoId = (base.meta && base.meta.videoId) || null;
  if (!videoId) return { data: base, client: "web" };

  const pref = state.settings.client || "auto";

  // 自动：先探测网页自带数据（web 客户端）。
  // 双重门槛：① 双档探测 HTTP 通过；② 有直链的最高档要达到页面声明的最高档（或至少 720p），
  // 否则视为 SABR 限直链，强制走回退链。
  const hs = videoHeights(base.formats);
  const webProbe = await YTClients.probeMulti(base.formats, 2);
  if (webProbe.ok && (hs.probe >= hs.all || hs.probe >= 720)) {
    return {
      data: base, client: "web", probed: true,
      detail: "WEB 直链探测通过：" + webProbe.detail + "（直链覆盖 " + hs.probe + "p / 页面最高 " + hs.all + "p）"
    };
  }
  state._probeNote =
    "网页直链探测 " + webProbe.detail + "；页面最高 " + hs.all +
    "p 但直链仅覆盖 " + hs.probe + "p（高清为 SABR，无直链）→ 走回退链";

  // 手动指定某个非 web 客户端（若设置的客户端已不存在或为 web，则穿到自动回退）
  if (pref !== "auto") {
    const c = YTClients.getClient(pref);
    if (c && c.id !== "web" && tabId) {
      setStatus("正在请求 " + c.label + " 客户端…");
      const r = await getClientVideoViaPage(c, base, tabId);
      if (r.ok) {
        const mp = await YTClients.probeMulti(r.parsed.formats, 2);
        if (mp.ok) {
          return { data: r.parsed, client: c.id, probed: true, detail: c.label + " 双档探测通过：" + mp.detail };
        }
        if (r.parsed.hlsManifestUrl) {
          r.parsed.formats.push(hlsFormat(r.parsed.hlsManifestUrl));
          return { data: r.parsed, client: c.id, probed: true, hls: true,
            detail: c.label + " 直链未通过（" + mp.detail + "），改用 HLS 预合并流" };
        }
        return {
          data: r.parsed,
          client: c.id,
          probed: false,
          detail: c.label + " 探测未通过：" + mp.detail,
          err: c.label + " 的直链仍被拒（" + mp.detail + "）（该客户端可能也需 PO Token）"
        };
      }
      // 请求失败不终止，穿到自动回退链
      state._probeNote =
        (state._probeNote ? state._probeNote + "\n" : "") +
        "手动指定 " + c.label + " 失败：" + r.error;
    }
  }

  // 自动回退 1：页面播放器 PO Token 注入（最可靠，不依赖客户端政策）
  const potRes = await tryPotFallback(base);
  if (potRes) return potRes;

  // 自动回退 2：依次尝试客户端（visionos → tv_downgraded → web_embedded → web_safari(HLS)）
  const tried = [];
  for (const c of YTClients.CLIENTS) {
    if (c.id === "web" || !tabId) continue;
    setStatus("尝试 " + c.label + " 客户端…");
    const r = await getClientVideoViaPage(c, base, tabId);
    if (!r.ok) {
      tried.push(c.label + "：" + r.error);
      console.warn("[yt-dl]", c.id, r.error);
      continue;
    }
    const parsed = r.parsed;

    const mp = await YTClients.probeMulti(parsed.formats, 2);
    if (mp.ok) return { data: parsed, client: c.id, probed: true, detail: c.label + " 双档探测通过：" + mp.detail };

    // 直链被拒但返回了 HLS 清单（预合并音视频，HLS 流免 PO Token）→ 用 HLS 兜底
    if (parsed.hlsManifestUrl) {
      parsed.formats.push(hlsFormat(parsed.hlsManifestUrl));
      return { data: parsed, client: c.id, probed: true, hls: true,
        detail: c.label + " 直链未通过（" + mp.detail + "），改用 HLS 预合并流" };
    }
    tried.push(c.label + "（" + mp.detail + "）");
    console.warn("[yt-dl]", c.id, "探测失败", mp.detail);
  }

  let err =
    "所有回退均失败（web 403 / PO Token 注入无效 / 各客户端直链 403）—— YouTube 的 PO Token 限制。\n" +
    "当前仅 360p 合并格式可用。\n\n尝试记录：\n" +
    (tried.length ? tried.join("\n") : "无") +
    (state._potNote ? "\nPO Token：" + state._potNote : "");
  if (state._probeNote) err = state._probeNote + "\n\n" + err;
  return { data: base, client: "web", probed: false, err: err, detail: tried.join(" | ") || "无" };
}

function renderSrcBar(src) {
  const bar = $("srcbar");
  let label;
  if (src.client === "web+pot") label = "WEB + 页面 PO Token";
  else {
    const c = YTClients.getClient(src.client);
    label = c ? c.label : src.client;
  }
  bar.classList.remove("hidden");
  const ok = src.probed !== false;
  bar.innerHTML =
    '<span class="src-dot' + (ok ? " ok" : "") + '"></span>' +
    "数据源：" + label +
    (src.probed ? " · 直链检测通过" : " · 直链 403（高清不可用）") +
    (src.detail ? '<div class="src-detail">' + src.detail.replace(/</g, "&lt;") + "</div>" : "");
  bar.className = ok ? "srcbar" : "srcbar warn";
}

// ---------- 主流程 ----------
async function load() {
  await restoreBgJob(); // 重开弹窗：把仍在跑的后台任务进度接回来显示
  setErr("");
  resetErrStyle();
  state._probeNote = null;
  state._potNote = null;
  $list.innerHTML = '<div class="empty">解析中…</div>';
  ["meta", "quick", "tabs", "filters", "extra", "srcbar"].forEach((id) => $(id).classList.add("hidden"));

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = (tab && tab.url) || "";

  // 非 YouTube 站点：走通用媒体嗅探（HLS / DASH / 直链）
  if (!/youtube\.com\/watch/.test(url)) {
    await loadGeneric(tab);
    return;
  }
  $list.innerHTML = '<div class="empty">读取播放数据…</div>';

  let resp;
  try {
    resp = await chrome.tabs.sendMessage(tab.id, { type: "GET_VIDEO" });
  } catch (e) {
    $list.innerHTML = '<div class="empty">无法连接到页面脚本</div>';
    setErr("请重新加载扩展并刷新视频页后重试。");
    return;
  }
  if (!resp || !resp.ok) {
    $list.innerHTML = '<div class="empty">' + ((resp && resp.error) || "解析失败") + "</div>";
    return;
  }

  const base = resp.data;

  await decryptFormats(base);
  const src = await resolveSource(base, tab);

  const data = src.data;
  state.data = data;
  state.client = src.client;
  state.formats = data.formats;
  state.res = "all";

  renderMeta();
  renderQuick();
  renderFilters();
  renderList();
  renderExtra();
  renderSrcBar(src);
  $("tabs").classList.remove("hidden");

  if (src.err) setErr(src.err);
}

// ---------- 通用站点：媒体嗅探与下载 ----------
const MEDIA_LABEL = {
  hls: "HLS 流", dash: "DASH 流", video: "视频文件",
  audio: "音频", m4s: "MSE 分片", ts: "TS 分片", other: "媒体"
};

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtSize(n) {
  if (!n) return "";
  if (n < 1024) return n + "B";
  if (n < 1048576) return (n / 1024).toFixed(0) + "KB";
  if (n < 1073741824) return (n / 1048576).toFixed(1) + "MB";
  return (n / 1073741824).toFixed(2) + "GB";
}

function shortName(u) {
  try {
    const p = new URL(u).pathname.split("/").pop();
    return decodeURIComponent(p || "").slice(0, 60) || u.slice(0, 60);
  } catch (e) { return String(u).slice(0, 60); }
}

function safeFileName(s) {
  // 去掉尾部可能附带的网页类扩展（防止 page.title 自带 ".htm" 导致 Edge 下载拦截）。
  // 注意 replace 的第二个参数是替换字符串，"$1" = 第一个捕获组本身；要剥掉 .htm 必须替换为空串。
  // 用 /g 全局替换，应对「x.htm and y.htm」这种病理文件名（虽然极少）。
  return String(s || "video")
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\.(htm|html|php|asp|aspx|jsp|cgi|do|action)(?=\b|$)/gi, "")
    .slice(0, 80);
}

// Edge「增强安全性 → 下载」会拦截所有 .htm/.html 等网页类扩展名下载（提示「无法下载 - 没有权限」）。
// 这是一份**通用黑名单**，所有「自动推测扩展名」或「拼接 base 名」的路径都必须经过它。
// 黑名单里的扩展名统统回退为 .mp4 —— 它们永远不该出现在视频下载文件名里。
// 注意：黑名单正则**不要求 .htm 在末尾**——只要 URL 任意位置含 .htm/.html/... 就直接过滤。
// 理由：B 站页面里常见运营活动子请求 URL（/blackboard/.../topic.htm?v=1, /index/ding-h5.htm?...），
//       pathname 末段可能是 /topic.htm?v=1 但也可能是 /xxx/yyy.htm&ref=... 等形态，
//       末尾限定会让少数边界 case 漏网（用户实测已验证）。误杀概率极低（合法视频 URL 几乎不会含 .htm）。
const WEB_EXT_BLOCKLIST = /\.(htm|html|php|asp|aspx|jsp|cgi|do|action)/i;
const WEB_EXT_SET = new Set(["htm", "html", "php", "asp", "aspx", "jsp", "cgi", "do", "action"]);

function safeExtFromUrl(u) {
  const m = /\.(\w{2,5})(\?|#|$)/.exec(u || "");
  if (!m) return ".mp4";
  const ext = m[1].toLowerCase();
  if (WEB_EXT_SET.has(ext)) return ".mp4"; // 网页类扩展名强制回退
  return "." + ext;
}

// popup 端最后一道防线：去重 + 过滤网页类 URL
// 哪怕 mainworld 因旧版没过滤、或 iframe 注入了多个 frame 误传，.htm 也再不进列表
function dedupeMedia(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  const seen = new Set();
  for (const m of arr) {
    if (!m || !m.url) continue;
    // 网页类伪协议（bilibili://playurl）和 URL 都过滤
    // WEB_EXT_BLOCKLIST 已放宽：URL 任意位置含 .htm/.html/... 就过滤
    if (typeof m.url === "string" && WEB_EXT_BLOCKLIST.test(m.url)) continue;
    // 遥测/埋点端点（//host/log/…、/report/…）永远不是媒体
    if (typeof m.url === "string" && /\/\/[^/]*\/(log|report|data\/report)\//i.test(m.url)) continue;
    if (seen.has(m.url)) continue;
    seen.add(m.url);
    out.push(m);
  }
  return out;
}

async function loadGeneric(tab) {
  if (!tab) return;
  $list.innerHTML = '<div class="empty">嗅探页面媒体…</div>';
  ["quick", "tabs", "filters"].forEach((id) => $(id).classList.add("hidden"));
  state.tabId = tab.id;

  // MV3 下 content script 偶尔会丢（service worker 重启 / 扩展热更），
  // chrome.tabs.sendMessage 会抛 "Could not establish connection"。
  // 这里做三次尝试：第一次直接发；第二次短暂重试（content.js 可能在注入中）；
  // 第三次让 background 用 chrome.scripting.executeScript 强制注入后再发。
  let resp = null;
  for (let attempt = 0; attempt < 2 && !resp; attempt++) {
    resp = await tryGetMedia(tab.id);
    if (resp) break;
    if (attempt === 0) await new Promise((r) => setTimeout(r, 250));
  }
  if (!resp) {
    // 强制注入 content.js + media-main.js
    try {
      await chrome.runtime.sendMessage({ type: "REINJECT_CONTENT", tabId: tab.id });
      await new Promise((r) => setTimeout(r, 200));
      resp = await tryGetMedia(tab.id);
    } catch (e) {
      console.warn("[yt-dl] 强制注入失败：", e && e.message);
    }
  }

  if (!resp || !resp.ok) {
    $list.innerHTML = '<div class="empty">无法连接到页面脚本<br /><small>请点右上角 ↻ 重试，或刷新当前页面</small></div>';
    setErr("请重新加载扩展并刷新当前页面后重试。");
    return;
  }

  const raw = resp.media || [];
  const filtered = dedupeMedia(raw);
  const dropped = raw.length - filtered.length;
  state.media = filtered;
  state.page = resp.page || {};

  // 爱奇艺：显示专用下载入口，并清空通用嗅探列表
  // （嗅探到的 DASH 分片带签名鉴权 D2102，无法直接下载，只能走 tvid 换直链）
  const iqEl = document.getElementById("iqiyi");
  const iqStatus = document.getElementById("iqStatus");
  if (isIqiyi()) {
    iqEl.classList.remove("hidden");
    iqStatus.className = "iq-status hidden";
    iqStatus.textContent = "";
    state.media = [];
    const bar = $("srcbar");
    bar.classList.remove("hidden");
    bar.className = "srcbar";
    bar.innerHTML = '<span class="src-dot"></span>爱奇艺 · 请用下方「获取并下载（最高画质）」按钮';
    $list.innerHTML =
      '<div class="empty">爱奇艺分片带签名鉴权，嗅探到的直链无法直接下载<br />' +
      "<small>点下方绿色按钮，由扩展用 tvid 换取可用片源</small></div>";
    return;
  }
  iqEl.classList.add("hidden");

  // 腾讯视频：显示专用下载入口，并清空通用嗅探列表
  // （嗅探到的 .ts 分片带 vkey 签名且会过期，只能走 getvinfo 换 m3u8 逐片合并）
  const tqEl = document.getElementById("tencent");
  const tqStatus = document.getElementById("tqStatus");
  if (isTencent()) {
    tqEl.classList.remove("hidden");
    tqStatus.className = "tq-status hidden";
    tqStatus.textContent = "";
    state.media = [];
    const bar = $("srcbar");
    bar.classList.remove("hidden");
    bar.className = "srcbar";
    bar.innerHTML = '<span class="src-dot"></span>腾讯视频 · 请用下方「获取并下载（最高画质）」按钮';
    $list.innerHTML =
      '<div class="empty">腾讯视频分片带签名且会过期，嗅探到的直链无法直接下载<br />' +
      "<small>点下方红色「获取并下载（最高画质）」按钮，由扩展用 vid 换取可用片源</small></div>";
    return;
  }
  tqEl.classList.add("hidden");

  const bar = $("srcbar");
  bar.classList.remove("hidden");
  bar.className = state.media.length ? "srcbar" : "srcbar warn";
  bar.innerHTML =
    '<span class="src-dot' + (state.media.length ? " ok" : "") + '"></span>' +
    "站点：" + esc(state.page.host || "") +
    (state.media.length
      ? " · 捕获 " + state.media.length + " 个媒体资源"
        + (dropped > 0 ? " · 已拦截 " + dropped + " 个网页类伪媒体" : "")
      : " · 未捕获到媒体（先让视频播放几秒再点 ↻）");

  renderMediaList();
}

async function tryGetMedia(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: "GET_MEDIA", timeout: 2500 });
  } catch (e) {
    return null;
  }
}

// 带超时的标签页消息：避免页面脚本不回包时 popup 永久转圈
function sendMessageTimeout(tabId, msg, ms) {
  return new Promise((resolve, reject) => {
    let done = false;
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error("页面脚本响应超时（请刷新页面后重试）"));
    }, ms);
    chrome.tabs.sendMessage(tabId, msg).then(
      (r) => { if (!done) { done = true; clearTimeout(t); resolve(r); } },
      (e) => { if (!done) { done = true; clearTimeout(t); reject(e); } }
    );
  });
}

// 通用 Promise 超时包装（用于 executeScript / fetch 等不一定自带超时的调用）
function runWithTimeout(promise, ms, errMsg) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(errMsg || "操作超时")), ms))
  ]);
}

function isIqiyi() {
  const h = String((state.page && state.page.host) || "").replace(/^www\./, "").toLowerCase();
  return /(^|\.)iqiyi\.com$/.test(h);
}

function isTencent() {
  const h = String((state.page && state.page.host) || "").replace(/^www\./, "").toLowerCase();
  return /(^|\.)qq\.com$/.test(h) && /v\.qq\.com/.test(String(state.page && state.page.url) || "");
}

function renderMediaList() {
  let list = dedupeMedia(state.media || []);
  // B 站适配器就位时，裸的 m4s/ts 分片行是冗余的（同一批流，点「待匹配」也下不了）→ 收起
  const hasBiliAdapter = list.some((m) => m.bilibili === true);
  if (hasBiliAdapter) {
    const hidden = list.filter((m) => !m.bilibili && (m.type === "m4s" || m.type === "ts")).length;
    list = list.filter((m) => m.bilibili || (m.type !== "m4s" && m.type !== "ts"));
    state._hiddenBiliRaw = hidden;
  } else {
    state._hiddenBiliRaw = 0;
  }
  if (!list.length) {
    $list.innerHTML =
      '<div class="empty">未捕获到媒体资源<br /><small>请让视频播放几秒，再点右上角 ↻ 重试</small></div>';
    return;
  }
  $list.innerHTML = list
    .map((m, i) => {
      const needAdapt = m.type === "m4s" || m.type === "ts";
      const isBili = m.bilibili === true;
      const isDurl = isBili && m.playurl && m.playurl.durl && m.playurl.durl.length;
      const badgeText = isDurl
        ? "B 站 FLV"
        : (isBili ? "B 站 DASH" : (MEDIA_LABEL[m.type] || m.type));
      const subText = isBili
        ? esc(m.label || (isDurl
            ? "B 站 FLV 分段：" + m.playurl.durl.length + " 段 → 扩展内拼接为单 .flv"
            : "B 站官方 playurl 接口（高清 + 音轨）"))
        : esc(m.host || "") + (m.size ? " · " + fmtSize(m.size) : "") + (needAdapt ? " · 需站点适配" : "");
      // URL 诊断片段（用灰色小字显示完整 URL 前 80 字符）：
      // 排查「明明过滤 .htm 但渲染出 .htm」类问题时，必须看到 m.url 真实形态。
      // pseudo URL（bilibili://playurl）也能从这里看出来。
      const urlDiag = (typeof m.url === "string") ? m.url.slice(0, 80) : String(m.url);
      return (
        '<div class="row">' +
          '<div class="row-main">' +
            '<div class="row-top">' +
              '<span class="badge ' + m.type + (isBili ? " bili" : "") + '">' + esc(badgeText) + "</span>" +
              esc(shortName(m.url)) +
            "</div>" +
            '<div class="row-sub">' + subText + "</div>" +
            '<div class="row-url" title="' + esc(urlDiag) + '">' + esc(urlDiag) + "</div>" +
          "</div>" +
          '<button class="dl" data-i="' + i + '"' + (needAdapt ? " disabled" : "") + ">" +
            (needAdapt ? "待适配" : "下载") +
          "</button>" +
        "</div>"
      );
    })
    .join("");

  // 隐藏行脚注：B 站适配器就位时收起的裸分片计数（它们与适配器下载的是同一批流）
  if (state._hiddenBiliRaw > 0) {
    $list.insertAdjacentHTML("beforeend",
      '<div class="bili-hidden-note">已收起 ' + state._hiddenBiliRaw +
      " 个裸媒体分片（与「B 站 DASH」是同一批流，用上面的下载按钮即可）</div>");
  }

  $list.querySelectorAll("button.dl").forEach((b) => {
    if (b.disabled) return;
    // ⚠ 必须用过滤后的渲染列表取 item；state.media 是未过滤数组，索引会错位
    b.onclick = () => downloadMedia(list[parseInt(b.dataset.i, 10)]);
  });
}

// 通用下载分派：HLS → 分段拼接；DASH → MPD 解析拼接；直链 → 直接下载

// B 站 durl（FLV 分段）下载：交给页面主世界拉段拼接（page origin 带 SESSDATA + referrer）
// 降级链：单段直接下；多段优先主世界拼接；拼接失败退回逐段下载（本地 ffmpeg 合并）
async function downloadBliDurl(durls, base, show) {
  if (!durls.length) throw new Error("durl 为空");

  // 单段：无需拼接，直接交给浏览器下载管理器（自动带 cookie/referrer，无 CORS 限制）
  if (durls.length === 1) {
    chrome.downloads.download(
      { url: durls[0].url, filename: base + ".flv", saveAs: !!state.settings.askPath },
      () => {
        if (chrome.runtime.lastError) {
          setErr("下载失败：" + chrome.runtime.lastError.message);
          toast("下载失败：" + chrome.runtime.lastError.message);
        } else {
          toast("已开始下载 B 站 FLV：" + base + ".flv");
        }
      }
    );
    return;
  }

  // 多段：主世界拼接
  if (!state.tabId) throw new Error("未找到页面标签");
  show("B 站 FLV：拼接 " + durls.length + " 段…");
  try {
    const resp = await chrome.tabs.sendMessage(state.tabId, {
      type: "BILI_DURL_DOWNLOAD",
      durls: durls.map((d) => ({ url: d.url })),
      filename: base + ".flv",
      saveAs: !!state.settings.askPath
    });
    if (!resp || !resp.ok) throw new Error((resp && resp.error) || "B 站 FLV 拼接失败");
    toast("已保存 B 站 FLV 视频：" + base + ".flv");
    setErr(""); resetErrStyle();
    return;
  } catch (e) {
    // 降级：逐段交给浏览器下载，用户本地 ffmpeg 合并
    console.warn("[vdm] 主世界拼接失败，退回逐段下载：", e && e.message);
    durls.forEach((d, i) => {
      const segName = base + ".part" + (i + 1) + ".flv";
      chrome.downloads.download({ url: d.url, filename: segName, saveAs: false });
    });
    toast(
      "拼接失败（" + String((e && e.message) || e) + "），已改为分段下载 " + durls.length +
        " 个文件。\n本地合并命令：\nffmpeg -i \"" + base + ".part1.flv\" -c copy 输出.mp4\n" +
        "（多段可先 concat：ffmpeg -f concat -i list.txt -c copy 输出.mp4）"
    );
  }
}

async function downloadMedia(m) {
  if (!m) return;
  const show = (msg) => {
    $err.textContent = msg;
    $err.style.display = "block";
    $err.style.cursor = "default";
  };
  const base = safeFileName((state.page && state.page.title) || "video");

  try {
    if (m.type === "hls") {
      await armMediaRefererRule(m); // 第一次：保证 m3u8 清单本身能 fetch
      show("HLS：解析清单…（请保持弹窗打开）");
      const info = await YTHls.resolveBestVariant(m.url);
      // 第二次：把分片真实 host 一并加上（爱奇艺等 CDN 经常跨 host）
      await armMediaRefererRule(m, info.hosts);
      let blob;
      try {
        blob = await YTHls.download(info, (d, t) => {
          show("HLS 下载：" + Math.round((d / t) * 100) + "%（" + d + "/" + t + " 段）—— 请保持弹窗打开");
        });
      } catch (e) {
        // 扩展页 fetch 被 CDN 拒绝 → 回退页面主世界（HLS 的 init + segments 同样适用）
        console.warn("[vdm] HLS 扩展页下载失败，回退页面主世界：", e && e.message);
        blob = await mainWorldDownloadTrack(
          { init: info.initUrl, segments: info.segments, mime: "video/mp4" }, "video", show);
      }
      saveBlob(blob, base + ".mp4");
      toast("已保存 HLS 视频：" + base + ".mp4");
      setErr("");
      resetErrStyle();
      return;
    }

    if (m.type === "dash") {
      // B 站适配：优先 dash（MP4 分段）；否则 durl（FLV 分段，去 header 拼接）
      if (m.bilibili && m.playurl) {
        if (m.playurl.durl && m.playurl.durl.length) {
          await downloadBliDurl(m.playurl.durl, base, show);
          return;
        }
        show("B 站：解析 dash…");
        const bili = await YTDash.fromBilibili(m.playurl, { qn: 80 });

        // 1) 优先后台下载（offscreen + DNR 注入 Referer）：弹窗和页面都可以关闭
        let bgOk = false;
        try {
          const resp = await chrome.runtime.sendMessage({
            type: "BILI_BG_DOWNLOAD",
            video: bili.video,
            audio: bili.audio || null,
            name: base + ".mp4"
          });
          if (resp && resp.ok) {
            bgOk = true;
            show("B 站：后台下载已开始，本弹窗和页面都可以关闭（进度可在重新打开弹窗后查看）");
            return;
          }
          if (resp && resp.error) show(resp.error + "，改用页面下载…");
        } catch (e) {}

        // 2) 回退：页面主世界下载（⚠ bilivideo CDN 校验来源，必须带页面 SESSDATA + referrer）。
        //    需保持本弹窗与 B 站页面打开，直到下载完成。
        if (!state.tabId) throw new Error("未找到页面标签");
        // 进度接收口：content.js 转发的 BILI_DASH_PROGRESS → 实时刷新 show 文案。
        // 优先字节进度（流式读取，单个巨型分片也能看到百分比跳动）；
        // 数字在涨 = 正在下载；一直不动超过 ~1 分钟 = 消息通道可能断了，刷新页面重试。
        const trackLabel = (k) => (k === "video" ? "视频" : "音轨");
        state._dashSink = (kind, p) => {
          p = p || {};
          if (p.contentLength > 0) {
            const pct = Math.min(99, Math.round((p.bytes / p.contentLength) * 100));
            show("B 站：下载" + trackLabel(kind) + " " + pct + "%（" + fmtSize(p.bytes) + " / " + fmtSize(p.contentLength) + "）");
          } else if (p.bytes > 0) {
            show("B 站：下载" + trackLabel(kind) + " 已收 " + fmtSize(p.bytes) + "（总大小未知）");
          } else {
            show("B 站：下载" + trackLabel(kind) + "…（" + (p.done || 0) + "/" + (p.total || 0) + " 片）");
          }
        };
        const videoMime = (bili.video && bili.video.mime) || "video/mp4";
        show("B 站：主世界下载视频…（请保持页面与本弹窗打开）");
        const vResp = await chrome.tabs.sendMessage(state.tabId, {
          type: "BILI_DASH_TRACK_DOWNLOAD",
          initSpec: bili.video && bili.video.init,
          segments: bili.video && bili.video.segments,
          mime: videoMime,
          kind: "video"
        });
        state._dashSink = null;
        if (!vResp || !vResp.ok || !vResp.blobUrl) {
          throw new Error((vResp && vResp.error) || "B 站视频段下载失败");
        }
        let finalBlob, ext = ".mp4";
        if (bili.audio) {
          const audioMime = bili.audio.mime || "audio/mp4";
          state._dashSink = (kind, done, total) => {
            show("B 站：下载音轨 " + Math.round((done / total) * 100) + "%（" + done + "/" + total + " 片）");
          };
          show("B 站：主世界下载音轨…");
          const aResp = await chrome.tabs.sendMessage(state.tabId, {
            type: "BILI_DASH_TRACK_DOWNLOAD",
            initSpec: bili.audio.init,
            segments: bili.audio.segments,
            mime: audioMime,
            kind: "audio"
          });
          state._dashSink = null;
          if (!aResp || !aResp.ok || !aResp.blobUrl) {
            throw new Error((aResp && aResp.error) || "B 站音轨段下载失败");
          }
          show("合并音视频…");
          finalBlob = await YTMerge.mergeAv(
            vResp.blobUrl, aResp.blobUrl,
            (p, msg) => show("合并 " + Math.round(p * 100) + "%：" + msg)
          );
        } else {
          // 仅视频流（dash.audio 缺失时退回单 blob）
          const r = await fetch(vResp.blobUrl);
          finalBlob = await r.blob();
        }
        saveBlob(finalBlob, base + ext);
        toast("已保存 B 站视频：" + base + ext);
        setErr(""); resetErrStyle();
        return;
      }

      // 先装 Referer 伪装规则（爱奇艺等站点 CDN 对扩展 origin 会返回 403/405）
      await armMediaRefererRule(m);
      show("DASH：解析 MPD…");
      const parsed = await YTDash.resolve(m.url);
      // 把 MPD 内部 BaseURL/SegmentTemplate 引用的真实分片 host 一并装上
      // （爱奇艺 MPD 在 meta-cdn.video.iqiyi.com，分片却在 data.video.iqiyi.com）
      if (parsed.hosts && parsed.hosts.length) await armMediaRefererRule(m, parsed.hosts);
      const best = YTDash.pickBest(parsed.reps);
      if (!best.video && !best.audio) throw new Error("MPD 中没有可下载的表示");

      // 扩展页 fetch 可能被 CDN 按来源拒绝（爱奇艺 405 / 各站 403）→
      // 失败自动回退到页面主世界下载（带站点 cookie + referrer）。
      const grab = async (rep, kind) => {
        if (!rep) return null;
        try {
          return await YTDash.downloadSegments(rep, m.url, (p) =>
            show("DASH 下载" + (kind === "audio" ? "音轨" : "视频") + "：" + Math.round(p * 100) + "%"));
        } catch (e) {
          console.warn("[vdm] DASH 扩展页下载失败，回退页面主世界：", e && e.message);
          return await mainWorldDownloadTrack(rep, kind, show);
        }
      };
      const vBlob = await grab(best.video, "video");
      const aBlob = await grab(best.audio, "audio");

      if (vBlob && aBlob) {
        show("合并音视频…");
        const merged = await YTMerge.mergeAv(
          URL.createObjectURL(vBlob), URL.createObjectURL(aBlob),
          (p, msg) => show("合并 " + Math.round(p * 100) + "%：" + msg)
        );
        saveBlob(merged, base + ".mp4");
      } else {
        saveBlob(vBlob || aBlob, base + (vBlob ? ".mp4" : ".m4a"));
      }
      toast("已保存 DASH 视频：" + base + ".mp4");
      setErr("");
      resetErrStyle();
      return;
    }

    // 直链（video / audio）
    chrome.downloads.download(
      { url: m.url, filename: base + guessExt(m.url), saveAs: !!state.settings.askPath },
      () => {
        if (chrome.runtime.lastError) toast("下载失败：" + chrome.runtime.lastError.message);
        else toast("已开始下载：" + shortName(m.url));
      }
    );
  } catch (e) {
    let msg = String((e && e.message) || e);
    // 分片流（HLS/DASH）失败 → 自动降级到列表里已合并好的直链。
    // 爱奇艺等站点的 DASH 分片带签名鉴权（需 vf/authKey 等参数，错误码 D2102），
    // 签名算法在播放器 JS 里，通用下载器拿不到 → 分片 URL 本身不可用，
    // 换扩展页/主世界发请求都一样失败。而已合并的 mp4 直链走 chrome.downloads
    // 浏览器原生下载栈，不带扩展 Origin、不需签名，成功率最高。
    if (m.type === "hls" || m.type === "dash") {
      const direct = (state.media || []).filter(
        (x) => x && x.url && (x.type === "video" || x.type === "audio")
      );
      if (direct.length) {
        // 优先挑体积最大的直链（通常画质最好）
        const d = direct.slice().sort((a, b) => (b.size || 0) - (a.size || 0))[0];
        // 直链同样要带站点 cookie + referrer 才能拿到真内容：chrome.downloads 是
        // 浏览器原生下载栈，不带 Referer，爱奇艺会返回一份 1KB 错误 JSON（存成 .mp4）。
        // 所以直链也走主世界下载（复用 MAIN_TRACK_DOWNLOAD 单分片通道），并校验内容。
        try {
          // asUrl=true：大文件不读进 popup 内存，校验 size 后直接把 blobUrl 落盘
          const got = await mainWorldDownloadTrack(
            { init: null, segments: [{ url: d.url, range: null }], mime: "video/mp4" },
            "video", show, true
          );
          if (!got || !got.blobUrl || got.size < 10240) {
            throw new Error("直链返回异常内容（" + (got ? got.size : 0) +
              " 字节，疑似鉴权错误页），该站资源需签名鉴权");
          }
          chrome.downloads.download(
            { url: got.blobUrl, filename: base + guessExt(d.url), saveAs: !!state.settings.askPath },
            () => {
              if (chrome.runtime.lastError) {
                setErr("保存失败：" + chrome.runtime.lastError.message);
                toast("保存失败：" + chrome.runtime.lastError.message);
              } else {
                setErr("");
                resetErrStyle();
                toast("分片需签名，已改用页面下载直链：" + shortName(d.url));
              }
            }
          );
        } catch (e2) {
          const err2 = String((e2 && e2.message) || e2);
          setErr("下载失败：" + msg + " ｜备用直链也失败：" + err2);
          toast("备用直链也失败：" + err2);
        }
        return;
      }
      msg += " ｜该站分片流需签名鉴权，且未捕获到可用直链";
    }
    setErr("下载失败：" + msg);
    toast("下载失败：" + msg);
  }
}

// 爱奇艺：在页面主世界内自包含执行的 tvid 提取函数（必须无外层闭包引用）
// 提交给 chrome.scripting.executeScript 时会被序列化到目标标签页的 MAIN world。
// 提取顺序：①QiyiPlayerProphetData / __INITIAL_STATE__ / playerInstance → ②DOM 属性 →
//          ③当前 document HTML 正则 → ④同源 fetch(location.href) 拿原始 HTML 兜底（CSP 允许 'self'）
async function iqiyiTvidInPage() {
  function fromText(t) {
    if (!t) return null;
    var m = /["']?tvi[dD]["']?\s*[:=]\s*["']?(\d{6,})/.exec(t);
    return m ? m[1] : null;
  }
  function deepTvid(obj) {
    if (!obj || typeof obj !== "object") return null;
    var paths = [["tvid"],["tvId"],["video","tvid"],["video","tvId"],["currentVideoInfo","tvid"],["currentVideoInfo","tvId"],["playInfo","tvid"],["album","tvId"],["data","tvid"]];
    for (var i=0;i<paths.length;i++){
      var cur=obj,ok=true;
      for (var j=0;j<paths[i].length;j++){ if(cur==null){ok=false;break;} cur=cur[paths[i][j]]; }
      if(ok && cur && /^\d{6,}$/.test(String(cur))) return String(cur);
    }
    var stack=[obj],seen=0;
    while(stack.length && seen<3000){
      var node=stack.pop(); seen++;
      if(node && typeof node==="object"){
        for (var k in node){
          if(!Object.prototype.hasOwnProperty.call(node,k)) continue;
          var v=node[k];
          if(k==="tvid"||k==="tvId"){ if(v && /^\d{6,}$/.test(String(v))) return String(v); }
          else if(v && typeof v==="object" && seen<3000) stack.push(v);
        }
      }
    }
    return null;
  }
  try { var t=deepTvid(window.QiyiPlayerProphetData); if(t) return t; } catch(e){}
  try { var t2=deepTvid(window.__INITIAL_STATE__); if(t2) return t2; } catch(e){}
  try { var pi=window.playerInstance; if(pi){ var pt=pi.tvid||(pi.video&&(pi.video.tvid||pi.video.tvId)); if(pt && /^\d{6,}$/.test(String(pt))) return String(pt); } } catch(e){}
  try { var el=document.querySelector("[data-player-tvid],[data-shareplattrigger-tvid]"); if(el){ var dv=el.getAttribute("data-player-tvid")||el.getAttribute("data-shareplattrigger-tvid"); if(dv && /^\d+$/.test(dv)) return dv; } } catch(e){}
  try { var h=document.documentElement.innerHTML; var ht=fromText(h); if(ht) return ht; } catch(e){}
  // 兜底：同源拉页面自身 HTML（爱奇艺 page-CSP 的 connect-src 通常允许 'self'）
  try {
    var ctrl = ("AbortController" in window) ? new AbortController() : null;
    var to = ctrl ? setTimeout(function(){ctrl.abort();},8000) : null;
    var r = await fetch(location.href, { credentials:"omit", signal: ctrl ? ctrl.signal : undefined });
    if(to) clearTimeout(to);
    if(r.ok){ var txt=await r.text(); var mt=fromText(txt); if(mt) return mt; }
  } catch(e){}
  return null;
}

// popup 侧封装：直接拿 tvid 字符串（绕过 content.js ↔ media-main.js 的 postMessage 桥接，
// 桥接在爱奇艺页因 page-CSP/初始化顺序可能不可靠，executeScript 按需注入主世界更稳）。
async function getIqiyiTvidScripting(tabId) {
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      world: "MAIN",
      func: iqiyiTvidInPage
    });
    if (res && res[0] && typeof res[0].result !== "undefined") return res[0].result || null;
  } catch (e) {
    console.warn("[vdm-iq] executeScript 失败：", e && e.message);
  }
  return null;
}

// 爱奇艺专用下载：① 主世界取 tvid → ② popup 用纯 MD5 算 vf 换 /dash 片源直链
// → ③ 剥离分片参数拿整文件 TS 直链 → ④ chrome.downloads 原生下载（可关弹窗后台跑）。
// 不走 DASH 分片（data.video.iqiyi.com 带签名鉴权，通用下载器拿不到 → D2102），
// 而是走 cache.video.iqiyi.com/dash 接口（vf 签名可算、无 Cookie 也能用）。
async function doIqiyiDownload() {
  const $status = $("iqStatus");
  const setS = (t, cls) => {
    $status.textContent = t;
    $status.className = "iq-status" + (cls ? " " + cls : "");
  };
  if (!state.tabId) { setS("未找到页面标签，请刷新页面后重试", "err"); return; }
  const btn = $("iqBtn");
  const oldLabel = btn.textContent;
  btn.disabled = true;
  let tvid = null;
  try {
    setS("爱奇艺：读取 tvid…（最长约 12 秒）");
    try {
      tvid = await runWithTimeout(getIqiyiTvidScripting(state.tabId), 10000, "executeScript 超时");
    } catch (e) {
      console.warn("[vdm-iq] scripting 失败：", e && e.message);
    }
    // 兜底：旧 postMessage 桥接（media-main.js 主世界监听器，部分页面可能不可达）
    if (!tvid) {
      try {
        const r = await sendMessageTimeout(state.tabId, { type: "IQ_GET_TVID" }, 6000);
        if (r && r.ok && r.tvid) tvid = r.tvid;
      } catch (e) {}
    }
    if (!tvid) {
      throw new Error("未获取到 tvid（请确认在爱奇艺播放页且视频已加载几秒，刷新页面后重试）");
    }

    setS("爱奇艺：换取片源直链（最高画质）…");
    const res = await YTIqiyi.resolve(tvid);
    if (!res.best) {
      throw new Error("无可用码流（code=" + res.code + " st=" + res.st + "），可能需登录或片源已下架");
    }
    const best = res.best;

    // 列出可选项，便于用户了解画质（仅展示，不强干扰）
    const picks = res.streams
      .filter((s) => s.segments.length)
      .sort((a, b) => (b.bid || 0) - (a.bid || 0))
      .map((s) => s.label + (s.scrsz ? " " + s.scrsz : ""))
      .join(" / ");
    const name = safeFileName((state.page && state.page.title) || "iqiyi") + best.ext;
    const sizeTxt = best.totalBytes ? " · 约 " + Math.round(best.totalBytes / 1048576) + " MB" : "";
    setS("已选 " + best.label + (best.scrsz ? " · " + best.scrsz : "") +
      " · 共 " + best.count + " 个分片" + sizeTxt +
      "\n可用画质：" + (picks || best.label) + "\n正在启动后台下载（逐片合并，避免大文件被截断）…");

    // 走 offscreen 后台逐片下载并合并（与 B 站一致）：弹窗和页面都可关闭。
    // 不再用「去 start/end 参数的整文件直链」——爱奇艺 CDN 对大文件会截断到约 1/4，
    // 导致下到的视频只有原片 1/5 时长。
    const start = await chrome.runtime.sendMessage({
      type: "IQIYI_BG_DOWNLOAD",
      segments: best.segments,
      totalBytes: best.totalBytes || 0,
      name: name,
      hosts: ["iqiyi.com"],
      referer: (state.page && state.page.url) || ""
    });
    if (!start || !start.ok) {
      throw new Error((start && start.error) || "无法启动后台下载（可能已有其他后台任务进行中）");
    }
    state.iqMergeActive = true;
    setS("后台下载已启动：" + best.count + " 个分片（弹窗和页面都可关闭，浏览器后台继续）…", "ok");
    toast("爱奇艺后台下载已启动（" + best.count + " 片）");
  } catch (e) {
    setS("爱奇艺下载失败：" + String((e && e.message) || e), "err");
  } finally {
    btn.disabled = false;
    btn.textContent = oldLabel;
  }
}

// —— 腾讯视频：完全自包含的页面主世界函数（executeScript 注入，不依赖 lib/tencent.js 是否已注入）——
// 背景：lib/tencent.js 走 manifest content_scripts(document_idle) 注入，SPA/注入时序下可能未就绪，
// 此时 window.YTTencent 为 undefined，getVid 静默返回 null → 报「未获取到 vid」。
// 改为把提取/解析逻辑整段内联进 executeScript 的 func（与爱奇艺第 45 轮同款修法）。

// 自包含 vid 提取：全局状态树 → HTML 正则 → URL 末段兜底
function tencentVidInPage() {
  var re = /["']?vid["']?\s*[:=]\s*["']?([A-Za-z0-9_]{6,})/;
  var globals = [window.__PINIA__, window.__INITIAL_STATE__, window.__NUXT__, window.__NEXT_DATA__, window.QZoutputJSON];
  for (var i = 0; i < globals.length; i++) {
    try {
      if (globals[i]) {
        var gm = re.exec(JSON.stringify(globals[i]));
        if (gm && gm[1]) return gm[1];
      }
    } catch (e) {}
  }
  try {
    var mh = re.exec(document.documentElement.innerHTML || "");
    if (mh && mh[1]) return mh[1];
  } catch (e) {}
  try {
    var um = /\/x\/(?:cover|page)\/[^/]+\/([A-Za-z0-9_]{6,})\.html/i.exec(location.href)
          || /\/x\/(?:cover|page)\/([A-Za-z0-9_]{6,})\.html/i.exec(location.href);
    if (um && um[1]) return um[1];
  } catch (e) {}
  return null;
}

// 自包含片源解析（启动器）：executeScript 对 async func 的 Promise 等待不可靠
// （实测可能 fulfilled 但 result 为 undefined），改为「启动 + 页面全局变量存结果 + popup 轮询」。
// 结果序列化为 JSON 字符串写入 window.__vdm_tq_result，天然可克隆、跨版本兼容。
function tencentResolveStart(vid, pageUrl) {
  window.__vdm_tq_result = null;
  async function run() {
  var APP_VERSION = "3.5.57";
  var PLATFORM = "10901";
  var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";
  var KEY = new Uint8Array([0x4f,0x6b,0xda,0xa3,0x9e,0x2f,0x8c,0xb0,0x7f,0x5e,0x72,0x2d,0x9e,0xde,0xf3,0x14]);
  var IV  = new Uint8Array([0x01,0x50,0x4a,0xf3,0x56,0xe6,0x19,0xcf,0x2e,0x42,0xbb,0xa6,0x8c,0x3f,0x70,0xf9]);
  function rnd(n) {
    var s = "0123456789abcdefghijklmnopqrstuvwxyz";
    var o = "";
    for (var i = 0; i < n; i++) o += s[Math.floor(Math.random() * s.length)];
    return o;
  }
  async function ckey(videoId, url, guid) {
    var ts = Math.floor(Date.now() / 1000);
    var payload = videoId + "|" + ts + "|mg3c3b04ba|" + APP_VERSION + "|" + guid + "|" +
      PLATFORM + "|" + url.slice(0, 48) + "|" + UA.toLowerCase().slice(0, 48) +
      "||Mozilla|Netscape|Windows x86_64|00|";
    var sum = 0;
    for (var i = 0; i < payload.length; i++) sum += payload.charCodeAt(i);
    var body = "|" + sum + "|" + payload;
    var bytes = new TextEncoder().encode(body);
    var pad = (16 - (bytes.length % 16)) % 16;
    var padded = new Uint8Array(bytes.length + pad);
    padded.set(bytes);
    for (var j = 0; j < pad; j++) padded[bytes.length + j] = 0x20;
    var ck = await crypto.subtle.importKey("raw", KEY, { name: "AES-CBC" }, false, ["encrypt"]);
    var out = await crypto.subtle.encrypt({ name: "AES-CBC", iv: IV }, ck, padded);
    var u = new Uint8Array(out);
    var hex = "";
    for (var k = 0; k < u.length; k++) hex += ("0" + u[k].toString(16)).slice(-2);
    return hex.toUpperCase();
  }
  async function tryGetVinfo(v) {
    var guid = rnd(16);
    var flowid = rnd(32);
    var ck = await ckey(v, pageUrl, guid);
    var q = new URLSearchParams({
      vid: v, cid: "", cKey: ck, encryptVer: "8.1", sphls: "2", dtype: "3",
      defn: "hd", spsrt: "2", sphttps: "1", otype: "json", spwm: "1",
      hevclv: "28", drm: "40", spvideo: "4", spsfrhdr: "100",
      host: "v.qq.com", referer: "v.qq.com", ehost: pageUrl,
      appVer: APP_VERSION, platform: PLATFORM, guid: guid, flowid: flowid
    });
    var cm = /\/cover\/([a-z0-9]+)\//.exec(pageUrl || location.href || "");
    if (cm) q.set("cid", cm[1]);
    var url = "https://h5vv6.video.qq.com/getvinfo?" + q.toString();
    var ctrl = ("AbortController" in window) ? new AbortController() : null;
    var to = ctrl ? setTimeout(function () { ctrl.abort(); }, 15000) : null;
    var r;
    try {
      r = await fetch(url, {
        credentials: "include",
        headers: { Referer: "https://v.qq.com/" },
        signal: ctrl ? ctrl.signal : undefined
      });
    } finally { if (to) clearTimeout(to); }
    if (!r.ok) throw new Error("getvinfo HTTP " + r.status);
    var txt = await r.text();
    var ii = txt.indexOf("{");
    var ij = txt.lastIndexOf("}");
    if (ii < 0 || ij <= ii) throw new Error("getvinfo 无 JSON 返回");
    // 腾讯 otype=json 实际返回 QZOutputJson={...}; —— 截取首 { 到末 } 之间的纯 JSON，避免尾部 }; 导致 parse 报错
    var d;
    try { d = JSON.parse(txt.slice(ii, ij + 1)); }
    catch (pe) { throw new Error("getvinfo 响应解析失败：" + pe.message + "（前 80 字符：" + txt.slice(0, 80) + "）"); }
    if (d.code !== "0.0" && d.code !== 0 && String(d.code) !== "0") {
      throw new Error("腾讯接口拒绝：" + (d.msg || "未知") + "（code=" + d.code + "）");
    }
    var vi = d.vl.vi[0];
    if (!vi || !vi.ul || !vi.ul.ui) throw new Error("无可用片源");
    var ui = vi.ul.ui;
    var out = { br: vi.br, vw: vi.vw, vh: vi.vh, fn: vi.fn, vid: v, m3u8List: [] };
    for (var x = 0; x < ui.length; x++) {
      var u = ui[x];
      if (u.hls || (u.url && /\.m3u8(\?|#|$)/i.test(u.url))) {
        var mu = u.url + (u.hls ? u.hls.pt : "");
        if (out.m3u8List.indexOf(mu) < 0) out.m3u8List.push(mu);
      }
    }
    // 直链优先（yt-dlp 及各类腾讯下载器的首选方案）：fn+fvkey 走 chrome.downloads 原生下载栈，
    // 由浏览器下载进程发请求——既无扩展 origin 断流问题，也无 CORS 约束，且直接就是 mp4。
    if (vi.fn && vi.fvkey && ui.length && ui[0].url) {
      out.direct = ui[0].url + vi.fn + "?vkey=" + vi.fvkey;
    }
    if (out.direct || out.m3u8List.length) {
      out.m3u8 = out.m3u8List[0];
      return out;
    }
    throw new Error("该视频无 HLS 片源且无直链（可能需登录或 VIP）");
  }
  var candidates = [];
  if (vid) candidates.push(vid);
  try {
    var href = pageUrl || location.href || "";
    var um = /\/x\/(?:cover|page)\/[^/]+\/([A-Za-z0-9_]{6,})\.html/i.exec(href);
    if (!um) um = /\/x\/(?:cover|page)\/([A-Za-z0-9_]{6,})\.html/i.exec(href);
    if (um && um[1] && candidates.indexOf(um[1]) < 0) candidates.push(um[1]);
  } catch (e) {}
  if (!candidates.length) throw new Error("缺少 vid（无法构造请求）");
  var lastErr = null;
  for (var c = 0; c < candidates.length; c++) {
    try {
      var rr = await tryGetVinfo(candidates[c]);
      if (rr) return rr;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("未解析到可用片源（vid 候选均失败）");
  }
  run().then(function (r) {
    window.__vdm_tq_result = JSON.stringify({ ok: true, data: r });
  }).catch(function (e) {
    window.__vdm_tq_result = JSON.stringify({ ok: false, error: String((e && e.message) || e) });
  });
  return "started";
}

// 轮询读取（同步注入）：返回 window.__vdm_tq_result（JSON 字符串）或 null
function tencentResolvePoll() {
  return window.__vdm_tq_result || null;
}

// 自包含：页面世界拉 m3u8 并解析分片列表（CDN 对扩展 origin 断流，借页面网络环境）
function tencentM3u8Start(manifestUrl) {
  window.__vdm_tq_m3u8 = null;
  (async function () {
    try {
      var ctrl = ("AbortController" in window) ? new AbortController() : null;
      var to = ctrl ? setTimeout(function () { ctrl.abort(); }, 20000) : null;
      var r;
      try {
        // 注意：必须不带 cookie（omit）——CDN 返回 ACAO:*，带凭据的跨域请求会被 CORS 规范拦截（播放器即不带 cookie 拉流）
        r = await fetch(manifestUrl, { credentials: "omit", signal: ctrl ? ctrl.signal : undefined });
      } finally { if (to) clearTimeout(to); }
      if (!r.ok) throw new Error("m3u8 HTTP " + r.status);
      var txt = await r.text();
      var lines = txt.split(/\r?\n/);
      var segs = [];
      for (var i = 0; i < lines.length; i++) {
        var t = lines[i].trim();
        if (!t || t.charAt(0) === "#") continue;
        if (/^https?:\/\//i.test(t)) segs.push(t);
        else { try { segs.push(new URL(t, manifestUrl).href); } catch (e) { segs.push(t); } }
      }
      if (!segs.length) throw new Error("m3u8 未解析到分片");
      window.__vdm_tq_m3u8 = JSON.stringify({ ok: true, segs: segs });
    } catch (e) {
      window.__vdm_tq_m3u8 = JSON.stringify({ ok: false, error: String((e && e.message) || e) });
    }
  })();
  return "started";
}
function tencentM3u8Poll() {
  return window.__vdm_tq_m3u8 || null;
}

// ===== 腾讯视频：通用小工具（并发取首个命中 / 带 https 升级的取文本 / 内容判定）=====
// http→https 升级是必须的：https 页面（以及扩展页）禁止混合内容，播放器清单/分片若
// 是 http:// 会直接抛 "Failed to fetch"，旧版多次报这个错就是没做升级。
async function _vdmText(u, ms) {
  const c = new AbortController();
  const tm = setTimeout(() => c.abort(), ms || 6000);
  try {
    try {
      const r = await fetch(u, { credentials: "omit", signal: c.signal });
      if (r.ok) return { url: u, txt: await r.text() };
    } catch (e1) {}
    if (/^http:\/\//i.test(u)) {
      const u2 = u.replace(/^http:/i, "https:");
      const r2 = await fetch(u2, { credentials: "omit", signal: c.signal });
      if (r2.ok) return { url: u2, txt: await r2.text() };
    }
  } catch (e2) {
  } finally { clearTimeout(tm); }
  return null;
}
// 轻量嗅探：只取前 4KB 就断开。清单本身就这么大，分片则读几个 KB 就能判定不是清单，
// 于是「上百条候选全量嗅探」也能在几秒内跑完（完整拉取每条要几秒，全量根本不可行）。
async function _vdmSniff(u, ms) {
  const c = new AbortController();
  const tm = setTimeout(() => c.abort(), ms || 5000);
  const read = async (url) => {
    const r = await fetch(url, { credentials: "omit", signal: c.signal });
    if (!r.ok) return null;
    const rd = (r.body && r.body.getReader) ? r.body.getReader() : null;
    if (!rd) return { url: url, txt: await r.text() };
    const parts = [];
    let got = 0;
    for (;;) {
      const rr = await rd.read();
      if (rr.done) break;
      parts.push(rr.value);
      got += rr.value.length;
      if (got >= 4096) { try { rd.cancel(); } catch (e) {} break; }
    }
    const all = new Uint8Array(got);
    let off = 0;
    for (const p of parts) { all.set(p, off); off += p.length; }
    try { return { url: url, txt: new TextDecoder("utf-8").decode(all) }; } catch (e) { return null; }
  };
  try {
    try {
      const r1 = await read(u);
      if (r1 && r1.txt) return r1;
    } catch (e1) {}
    if (/^http:\/\//i.test(u)) {
      try { return await read(u.replace(/^http:/i, "https:")); } catch (e2) {}
    }
  } catch (e3) {
  } finally { clearTimeout(tm); }
  return null;
}
async function _vdmBytes(u, ms) {
  const c = new AbortController();
  const tm = setTimeout(() => c.abort(), ms || 9000);
  let bytes = 0, ok = false;
  try {
    const read = async (url) => {
      const r = await fetch(url, { credentials: "omit", signal: c.signal });
      if (!r.ok) return false;
      const rd = (r.body && r.body.getReader) ? r.body.getReader() : null;
      if (rd) { for (;;) { const rr = await rd.read(); if (rr.done) break; bytes += rr.value.length; } }
      else bytes += (await r.arrayBuffer()).byteLength;
      return true;
    };
    try { ok = await read(u); } catch (e1) {}
    if (!ok && /^http:\/\//i.test(u)) { bytes = 0; try { ok = await read(u.replace(/^http:/i, "https:")); } catch (e2) {} }
  } catch (e3) {
  } finally { clearTimeout(tm); }
  return { ok: ok, bytes: bytes };
}
// 固定并发跑候选，谁先证明可用就用谁（旧版串行探测 40+ 条 = 几分钟，是"太慢"的根因）
async function _vdmRace(items, limit, worker) {
  let i = 0, hit = null;
  const n = Math.max(1, Math.min(limit, items.length));
  const runners = [];
  for (let k = 0; k < n; k++) {
    runners.push((async () => {
      for (;;) {
        if (hit) return;
        const idx = i++;
        if (idx >= items.length) return;
        let r = null;
        try { r = await worker(items[idx], idx); } catch (e) {}
        if (r && !hit) hit = r;
      }
    })());
  }
  await Promise.all(runners);
  return hit;
}
// 清单判定只认内容特征：#EXTM3U 是 HLS 的绝对标志（腾讯清单 URL 常无 .m3u8 字样、
// Content-Type 也不是 mpegurl，按 URL/CT 分类必然漏判）
function _vdmIsManifest(t) {
  return /^\s*#EXTM3U/m.test(String(t || "")) || /<MPD[\s>]/i.test(String(t || ""));
}
function _vdmParseManifest(txt, base) {
  const segs = [], variants = [];
  for (const ln of String(txt || "").split(/\r?\n/)) {
    const t = ln.trim();
    if (!t || t.charAt(0) === "#") continue;
    let abs = t;
    if (!/^https?:\/\//i.test(t)) { try { abs = new URL(t, base).href; } catch (e) { continue; } }
    if (/\.(m3u8|mpd)(\?|#|$)/i.test(abs)) variants.push(abs); else segs.push(abs);
  }
  return { segs: segs, variants: variants };
}
// 从任意文本（播放器 API 的 JSON 等）里榨出媒体地址：
// ① .m3u8 直链 ② hls.pt + url 组合（腾讯清单路径常藏在 pt 字段里且无扩展名）
// ③ 同目录成组的分片列表（不限制 .ts —— 新播放器用 fmp4/无扩展名，只认 .ts 会全漏）
function _vdmExtract(txt) {
  const clean = String(txt || "").replace(/\\/g, "");
  const out = { m3u8: [], segs: [] };
  (clean.match(/https?:\/\/[^"'\s<>\\]+?\.m3u8[^"'\s<>\\]*/g) || []).forEach((u) => out.m3u8.push(u));
  const pts = (clean.match(/"pt"\s*:\s*"([^"]+)"/g) || [])
    .map((x) => x.replace(/^"pt"\s*:\s*"/, "").replace(/"$/, "")).filter((x) => x.length > 3);
  const bUrls = (clean.match(/"url"\s*:\s*"(https?:\/\/[^"]+)"/g) || [])
    .map((x) => x.replace(/^"url"\s*:\s*"/, "").replace(/"$/, ""))
    .filter((x, i, a) => a.indexOf(x) === i);
  for (const pt of pts) {
    for (const bu of bUrls) out.m3u8.push(bu.replace(/\/$/, "") + (pt.charAt(0) === "/" ? pt : "/" + pt));
  }
  const isNotAsset = (u) => !/\.(png|jpe?g|gif|webp|svg|css|js|woff2?|ico|html|json)(\?|#|$)/i.test(u);
  // 分片判定放宽扩展名（新播放器用 fmp4 / 无扩展名），但必须排除图片脚本等静态资源，
  // 否则会把一组 CDN 图片误当成分片列表（旧版只认 .ts 又会整组漏掉，两头都不行）
  const isMedia = (u) => isNotAsset(u) && (
    /\.(ts|m4s|f4v|mp4|m4a|aac|flv|mkv|webm)(\?|#|$)/i.test(u)
    || /\/moviets\.|\/ltsplay|smtcdns\.com\/[^/]+\/.*\/\d+\./i.test(u)
  );
  const groups = new Map();
  for (const u of clean.match(/https?:\/\/[^"'\s<>\\]+/g) || []) {
    if (!isMedia(u) || /\.(m3u8|mpd)(\?|#|$)/i.test(u)) continue;
    const dir = u.slice(0, u.lastIndexOf("/") + 1);
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(u);
  }
  groups.forEach((arr) => {
    const uniq = arr.filter((u, i, a) => a.indexOf(u) === i);
    if (uniq.length >= 3) out.segs = out.segs.concat(uniq);
  });
  out.m3u8 = out.m3u8.filter((u, i, a) => a.indexOf(u) === i);
  out.segs = out.segs.filter((u, i, a) => a.indexOf(u) === i);
  return out;
}
function _vdmDiag(d) {
  let s = "〔诊断：录制请求 " + d.wrAll + "（清单类 " + d.wrM3u8 + " / 分片类 " + d.wrSeg + "）" +
    " · 缓存体清单 " + d.bodyM3u8 + " · 缓存体分片组 " + d.bodySegs +
    " · 候选 " + (d.cand || 0) + " 已快筛 " + d.tried;
  if (d.smallGroup) s += " · 疑似小组已弃 " + d.smallGroup + " 片";
  if (d.sampleTop && d.sampleTop.length) s += "\n候选样本：\n" + d.sampleTop.join("\n");
  return s + "〕";
}

// 第一路径（猫抓同款）：直接用浏览器真实发出过的请求，不做线路探测。
// 猫抓从不探测——它把 webRequest 看到的请求原样列给用户，点哪条下哪条。我们同样：
// 候选全部来自 webRequest 录制 + 页面已缓存响应体，命中判定只认响应内容。
async function tencentPickFromSession(tabId, diag, setS) {
  const T0 = Date.now();
  const BUDGET = 30000;
  const left = () => Math.max(1200, BUDGET - (Date.now() - T0));
  const overBudget = () => Date.now() - T0 > BUDGET;

  // ① webRequest 录制（浏览器级视角，覆盖 Web Worker / iframe / 注入时机盲区）
  let items = [];
  try {
    const wr = await chrome.runtime.sendMessage({ type: "GET_WR_MEDIA", tabId: tabId });
    items = (wr && wr.ok && Array.isArray(wr.items)) ? wr.items : [];
  } catch (e) {}
  const seen = new Set(); const uniq = [];
  for (const it of items) {
    if (!it || !it.url || !/^https?:/i.test(it.url)) continue;
    if (seen.has(it.url)) continue;
    seen.add(it.url); uniq.push(it);
  }
  diag.wrAll = uniq.length;
  diag.wrM3u8 = uniq.filter((i) => i.kind === "m3u8").length;
  diag.wrSeg = uniq.filter((i) => i.kind === "seg").length;

  // ② 页面已缓存的响应体（零网络开销；播放器 API 的 JSON 里常直接带着清单/分片）
  let bodies = [];
  try {
    const pr = await chrome.scripting.executeScript({
      target: { tabId: tabId }, world: "MAIN",
      func: () => JSON.stringify((window.__vdm_hls_body__ || []).map(function (b) {
        return { u: b.url, t: String(b.text || "").slice(0, 400000) };
      }))
    });
    bodies = JSON.parse((pr && pr[0] && pr[0].result) || "[]") || [];
  } catch (e) {}

  const cand = [];
  const pushCand = (u) => { if (u && /^https?:/i.test(u) && cand.indexOf(u) < 0) cand.push(u); };
  let cachedManifest = null, jsonSegs = [];
  for (const b of bodies) {
    if (_vdmIsManifest(b.t)) {
      const p = _vdmParseManifest(b.t, b.u);
      if (p.segs.length && !cachedManifest) cachedManifest = { url: b.u, txt: b.t, segs: p.segs, variants: p.variants };
      else if (p.variants.length && !cachedManifest) cachedManifest = { url: b.u, txt: b.t, segs: [], variants: p.variants };
      diag.bodyM3u8++;
      continue;
    }
    const ex = _vdmExtract(b.t);
    ex.m3u8.forEach(pushCand);
    if (ex.segs.length > jsonSegs.length) jsonSegs = ex.segs;
  }
  diag.bodySegs = jsonSegs.length;

  // ③ 候选 = 录制到的**全部**非静态请求，按"是否像腾讯媒体 CDN"打分排序后全量嗅探。
  // 上一版只取前 24 条，结果真清单排在后面没被校验（诊断：录制 147 条却只校验 23 条，
  // 样本全是 vinfo_proxy / wuji_cache / txhlsjs-kernel.js 这类页面 API 和脚本）。
  // 打分原则：CDN 域名与"和已捕获分片同域"是最强信号，站点自身的接口/脚本一律压后。
  const segHosts = new Set();
  for (const i of uniq) {
    if (i.kind !== "seg") continue;
    try { segHosts.add(new URL(i.url).hostname); } catch (e) {}
  }
  const CDN = /smtcdns|tc\.qq\.com|moviets|ltsplay|qbox|myqcloud|qcloudcdn|video\.dispatch|gslb\.|apd-|vods?\.|cdn[a-z0-9]*\./i;
  // 注意：vd*.l.qq.com/vinfo_proxy 这类"信息接口"不能当非媒体排除掉——
  // 它的 JSON 里往往就带着播放器真正要用的清单路径（hls.pt）。
  const NON_MEDIA = /wuji|gtimg|qpic|qlogo|report|beacon|analytics|adservice|sentry|apm\.|log\./i;
  const ASSET = /\.(js|css|png|jpe?g|gif|webp|svg|woff2?|ttf|ico|map|html|json)(\?|#|$)/i;
  const score = (it) => {
    const u = it.url;
    let s = 0, host = "";
    try { host = new URL(u).hostname; } catch (e) {}
    if (host && segHosts.has(host)) s += 100;           // 与已捕获分片同域 = 同一条 CDN
    if (CDN.test(u)) s += 50;                            // 腾讯媒体 CDN 域名
    if (/m3u8|manifest|playlist|\.mpd|hls|dash/i.test(u)) s += 20;
    if (/\.ts(\?|#|$)|moviets|\/ts\/|fmp4/i.test(u)) s += 15;
    if (/getvinfo|vinfo|getinfo|vplay|getplay|playerv/i.test(u)) s += 25; // 信息接口：JSON 里常藏清单路径
    if (it.cl > 0 && it.cl < 150000) s += 8;             // 小体积文本更像清单
    if (NON_MEDIA.test(u)) s -= 60;
    if (ASSET.test(u)) s -= 40;
    return s;
  };
  uniq.map((i) => ({ u: i.url, s: score(i) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 80)
    .forEach((x) => pushCand(x.u));
  // 名字里带 m3u8 的排最前（最可能是真清单，并发池首个命中即停，顺序影响命中速度）
  cand.sort((a, b) => (/m3u8/i.test(b) ? 1 : 0) - (/m3u8/i.test(a) ? 1 : 0));
  diag.cand = cand.length;
  diag.sampleTop = cand.slice(0, 8).map((u) => {
    try {
      const p = new URL(u);
      return p.hostname + (p.pathname.length > 46 ? p.pathname.slice(0, 46) + "…" : p.pathname);
    } catch (e) { return String(u).slice(0, 78); }
  });

  // 解析一次清单（含一层变种跟进，取分片最多 = 画质最高的那条）
  const expand = async (m3u8, txt) => {
    let p = _vdmParseManifest(txt, m3u8);
    if (!p.segs.length && p.variants.length) {
      let best = null;
      await Promise.all(p.variants.slice(0, 8).map(async (v) => {
        const r = await _vdmText(v, Math.min(6000, left()));
        if (!r || !_vdmIsManifest(r.txt)) return;
        const pv = _vdmParseManifest(r.txt, v);
        if (pv.segs.length && (!best || pv.segs.length > best.segs.length)) best = { url: v, segs: pv.segs };
      }));
      if (best) return best;
      return null;
    }
    return p.segs.length ? { url: m3u8, segs: p.segs } : null;
  };

  if (cachedManifest && cachedManifest.segs.length) {
    return { m3u8: cachedManifest.url, segs: cachedManifest.segs, via: "缓存清单" };
  }
  if (cachedManifest && cachedManifest.variants.length) {
    const best = await expand(cachedManifest.url, cachedManifest.txt);
    if (best) return { m3u8: best.url, segs: best.segs, via: "缓存清单-变种" };
  }
  // 「同目录成组」只是启发式，少量同路径 URL（图标/接口/埋点）也会被凑成一组。
  // 上一版就是因此只拿到 3 片就开下——真正的片源列表少说几十片，低于阈值一律不认。
  const MIN_GROUP = 10;
  if (jsonSegs.length >= MIN_GROUP) return { m3u8: jsonSegs[0], segs: jsonSegs, via: "JSON分片组" };
  if (jsonSegs.length) diag.smallGroup = jsonSegs.length;

  if (cand.length && !overBudget()) {
    setS("快筛 " + cand.length + " 条播放会话请求（只读前 4KB 判内容，约 3~8 秒）…");
    // 并发 10 + 前 4KB 快筛：命中才完整拉取。全量候选也能在几秒内跑完。
    const hit = await _vdmRace(cand, 10, async (u) => {
      if (overBudget()) return null;
      const s = await _vdmSniff(u, 5000);
      if (!s) return null;
      diag.tried++;
      if (_vdmIsManifest(s.txt)) {
        // 命中：完整拉一次（快筛只读了 4KB，清单可能更长）
        const full = await _vdmText(u, 8000);
        const ex = await expand(u, (full && full.txt) || s.txt);
        return ex ? { m3u8: ex.url, segs: ex.segs, via: "内容快筛" } : null;
      }
      const inner = _vdmExtract(s.txt);
      for (const iu of inner.m3u8.slice(0, 4)) {
        const ri = await _vdmSniff(iu, 5000);
        if (ri && _vdmIsManifest(ri.txt)) {
          const full2 = await _vdmText(iu, 8000);
          const ex = await expand(iu, (full2 && full2.txt) || ri.txt);
          if (ex) return { m3u8: ex.url, segs: ex.segs, via: "JSON内清单" };
        }
      }
      if (inner.segs.length >= MIN_GROUP) return { m3u8: u, segs: inner.segs, via: "JSON分片组" };
      return null;
    });
    if (hit) return hit;
  }
  // 走到这里说明没抓到清单。把打分最高的候选样本带出去——下一轮靠它定位，
  // 比继续猜 URL 特征有效得多（每条截断，避免错误信息爆炸）。
  if (!diag.sampleTop || !diag.sampleTop.length) {
    diag.sampleTop = uniq.slice(-8).map((i) => {
      try {
        const p = new URL(i.url);
        return p.hostname + (p.pathname.length > 46 ? p.pathname.slice(0, 46) + "…" : p.pathname);
      } catch (e) { return String(i.url).slice(0, 78); }
    });
  }
  return null;
}

// 页面中转下载：扩展 origin 被 CDN 限流时的兜底（页面自己能播 = 页面网络环境必通）
async function tencentRelayDownload(tabId, segs, name, setS) {
  try {
    await chrome.runtime.sendMessage({ type: "TENCENT_PAGE_BEGIN", name: name, total: segs.length });
  } catch (e2) {}
  state.tqMergeActive = true; // 先置位：中转一开始就会狂发进度，标记晚了会整段丢
  setBgJob({ pct: 0.02, stage: "等待页面接管…", name: "腾讯视频", done: 0, total: segs.length });
  setS("页面中转下载中：共 " + segs.length + " 片（借播放页网络环境；弹窗可关闭，浏览器后台继续）…");
  let relay = null;
  try {
    relay = await chrome.tabs.sendMessage(tabId, { type: "TENCENT_PAGE_RELAY", segments: segs });
  } catch (e3) {
    throw new Error("页面桥接未就绪（" + ((e3 && e3.message) || e3) +
      "）——请【刷新腾讯视频标签页】后再点下载（扩展重载后页面里的桥接脚本必须刷新才更新）");
  }
  if (!relay || !relay.ok) {
    state.tqMergeActive = false;
    setBgJob(null);
    throw new Error((relay && relay.error) || "页面中转启动失败（请刷新页面后重试）");
  }
  toast("腾讯视频页面中转下载已启动");
}

// 自包含（页面主世界）：兜底路径——从我们自构造的 getvinfo 线路里挑一条能用的。
// 已删掉旧版的「URL 移植」与「Range 链式」：4 轮实测全部 0KB / 断@0KB，属必死分支，
// 留着只会把探测拖到几分钟。现在最多试 2 条线路（同 CDN 策略一致，首条断流即可判定全断），
// 全局 30 秒死线；取文本统一带 http→https 升级。
function tencentPickM3u8Start(listJson, wrJson, seedJson) {
  window.__vdm_tq_pick = null;
  var _t0 = Date.now();
  var _DEADLINE = 30000;
  function _expired() { return Date.now() - _t0 > _DEADLINE; }
  (async function () {
    var detail = [];
    function isM(t) { return /^\s*#EXTM3U/m.test(t) || /<MPD[\s>]/i.test(t); }
    function getText(u, ms) {
      return new Promise(function (resolve) {
        (async function () {
          var c = ("AbortController" in window) ? new AbortController() : null;
          var t = c ? setTimeout(function () { c.abort(); }, ms || 6000) : null;
          try {
            try {
              var r = await fetch(u, { credentials: "omit", signal: c ? c.signal : undefined });
              if (r.ok) { resolve({ url: u, txt: await r.text() }); return; }
            } catch (e1) {}
            if (/^http:\/\//i.test(u)) {
              var u2 = u.replace(/^http:/i, "https:");
              var r2 = await fetch(u2, { credentials: "omit", signal: c ? c.signal : undefined });
              if (r2.ok) { resolve({ url: u2, txt: await r2.text() }); return; }
            }
            resolve(null);
          } catch (e2) { resolve(null); } finally { if (t) clearTimeout(t); }
        })();
      });
    }
    function testFetch(url) {
      return new Promise(function (resolve) {
        (async function () {
          var c = ("AbortController" in window) ? new AbortController() : null;
          var t = c ? setTimeout(function () { c.abort(); }, 8000) : null;
          var bytes = 0;
          try {
            var r = await fetch(url, { credentials: "omit", signal: c ? c.signal : undefined });
            if (!r.ok) { resolve({ ok: false, bytes: 0, note: "HTTP " + r.status }); return; }
            var rd = (r.body && r.body.getReader) ? r.body.getReader() : null;
            if (rd) { for (;;) { var rr = await rd.read(); if (rr.done) break; bytes += rr.value.length; } }
            else { bytes = (await r.arrayBuffer()).byteLength; }
            resolve({ ok: true, bytes: bytes });
          } catch (e) {
            if (/^http:\/\//i.test(url)) {
              bytes = 0;
              try {
                var r2 = await fetch(url.replace(/^http:/i, "https:"), { credentials: "omit", signal: c ? c.signal : undefined });
                if (r2.ok) {
                  var rd2 = (r2.body && r2.body.getReader) ? r2.body.getReader() : null;
                  if (rd2) { for (;;) { var r3 = await rd2.read(); if (r3.done) break; bytes += r3.value.length; } }
                  else { bytes = (await r2.arrayBuffer()).byteLength; }
                  resolve({ ok: true, bytes: bytes }); return;
                }
              } catch (e2b) {}
            }
            resolve({ ok: false, bytes: bytes, note: "断流" });
          } finally { if (t) clearTimeout(t); }
        })();
      });
    }
    function parseSegs(txt, baseUrl) {
      var lines = (txt || "").split(/\r?\n/);
      var segs = [], variants = [];
      for (var j = 0; j < lines.length; j++) {
        var t = lines[j].trim();
        if (!t || t.charAt(0) === "#") continue;
        var abs = t;
        if (!/^https?:\/\//i.test(t)) { try { abs = new URL(t, baseUrl).href; } catch (e) { continue; } }
        if (/\.(m3u8|mpd)(\?|#|$)/i.test(abs)) variants.push(abs); else segs.push(abs);
      }
      return { segs: segs, variants: variants };
    }
    async function resolve1(mu) {
      var g = await getText(mu, 6000);
      if (!g) return { segs: [], note: "Failed to fetch" };
      var p = parseSegs(g.txt, g.url);
      if (p.segs.length) return { segs: p.segs, url: g.url };
      for (var i = 0; i < p.variants.length && i < 4; i++) {
        var g2 = await getText(p.variants[i], 6000);
        if (g2 && isM(g2.txt)) {
          var p2 = parseSegs(g2.txt, g2.url);
          if (p2.segs.length) return { segs: p2.segs, url: g2.url };
        }
      }
      return { segs: [], note: "无分片" };
    }

    // 序号外推：完全保留播放器分片 URL 的路径与查询串，只替换序号 → 生成完整分片列表。
    // （旧版「移植」是拿我们清单的文件名套到播放器目录上，文件名不同必然 404/0KB；
    //   这里反过来实现，播放器 URL 的 host、签名目录、vkey 等全部原样保留，只动序号）
    function numRuns(s) {
      var out = [], re = /\d+/g, m;
      while ((m = re.exec(s))) out.push({ i: m.index, len: m[0].length, v: parseInt(m[0], 10) });
      return out;
    }
    function buildTpl(seeds) {
      function splitU(u) { var q = u.indexOf("?"); return { p: q >= 0 ? u.slice(0, q) : u, s: q >= 0 ? u.slice(q) : "" }; }
      var a = splitU(seeds[0]);
      var runs = numRuns(a.p);
      if (!runs.length) return null;
      var idx = -1;
      if (seeds.length >= 2) {
        var rb = numRuns(splitU(seeds[1]).p);
        if (rb.length !== runs.length) return null;
        for (var i = 0; i < runs.length; i++) {
          if (rb[i].v !== runs[i].v) { if (idx >= 0) return null; idx = i; }
        }
        if (idx < 0) return null;
      } else {
        idx = runs.length - 1;
      }
      var r = runs[idx];
      return {
        tpl: a.p.slice(0, r.i) + "{n}" + a.p.slice(r.i + r.len) + a.s,
        pad: r.len, first: r.v
      };
    }
    function renderTpl(tpl, n) {
      var s = String(n);
      while (s.length < tpl.pad) s = "0" + s;
      return tpl.tpl.replace("{n}", s);
    }

    // ① webRequest 录到的清单候选（可能还是被我们误分类的"其他"请求）
    var wrList = [];
    try { wrList = JSON.parse(wrJson) || []; } catch (eW) {}
    for (var w = 0; w < wrList.length && w < 12 && !_expired(); w++) {
      try {
        var rw = await resolve1(wrList[w]);
        if (!rw.segs.length) continue;
        var fw = await testFetch(rw.segs[0]);
        if (!fw.ok) { detail.push("嗅探#" + (w + 1) + " 首片断流（" + Math.round(fw.bytes / 1024) + "KB）"); continue; }
        window.__vdm_tq_pick = JSON.stringify({ ok: true, m3u8: rw.url, segs: rw.segs, via: "webrequest" });
        return;
      } catch (eW2) {}
    }

    // ② 自构造 getvinfo 线路：最多 2 条（同 CDN 策略一致，首条 16KB 断流即可判定全断）
    var list = [];
    try { list = JSON.parse(listJson) || []; } catch (e) {}
    // ②a 先拿我们清单的分片总数（用于序号外推），并缓存解析结果
    var rl0 = list.length ? await resolve1(list[0]) : { segs: [] };
    var totalN = rl0.segs.length;
    // ②b 序号外推：播放器分片 URL + 我们的分片总数 = 完整可用列表
    var seeds = [];
    try { seeds = JSON.parse(seedJson || "[]") || []; } catch (eSd) {}
    if (seeds.length && totalN > 1 && !_expired()) {
      try {
        var tpl = buildTpl(seeds.slice(0, 6));
        if (tpl) {
          var startIdx = tpl.first === 0 ? 0 : (tpl.first <= 1 ? 1 : tpl.first);
          var gen = [];
          for (var k = 0; k < totalN; k++) gen.push(renderTpl(tpl, startIdx + k));
          var fg = await testFetch(gen[0]);
          if (fg.ok) {
            window.__vdm_tq_pick = JSON.stringify({ ok: true, m3u8: gen[0], segs: gen, via: "序号外推" });
            return;
          }
          detail.push("序号外推 首片断流（" + Math.round(fg.bytes / 1024) + "KB）");
        }
      } catch (eT) {
        detail.push("序号外推 " + String((eT && eT.message) || eT));
      }
    }
    var maxLines = Math.min(2, list.length);
    for (var i2 = 0; i2 < maxLines && !_expired(); i2++) {
      try {
        var rl = (i2 === 0) ? rl0 : await resolve1(list[i2]);
        if (!rl.segs.length) { detail.push("线路" + (i2 + 1) + " " + (rl.note || "无分片")); continue; }
        var f2 = await testFetch(rl.segs[0]);
        if (!f2.ok) {
          detail.push("线路" + (i2 + 1) + " 首片断流（" + Math.round(f2.bytes / 1024) + "KB）");
          continue;
        }
        window.__vdm_tq_pick = JSON.stringify({ ok: true, m3u8: rl.url, segs: rl.segs, via: "getvinfo" });
        return;
      } catch (e2) {
        detail.push("线路" + (i2 + 1) + " " + String((e2 && e2.message) || e2));
      }
    }
    window.__vdm_tq_pick = JSON.stringify({ ok: false, error: "全部候选不可用（" + detail.join("；") + "）" });
  })();
  return "started";
}
function tencentPickM3u8Poll() {
  return window.__vdm_tq_pick || null;
}

async function doTencentDownload() {
  const $status = $("tqStatus");
  const setS = (t, cls) => {
    $status.textContent = t;
    $status.className = "tq-status" + (cls ? " " + cls : "");
  };
  if (!state.tabId) { setS("未找到页面标签，请刷新页面后重试", "err"); return; }
  const btn = $("tqBtn");
  const oldLabel = btn.textContent;
  btn.disabled = true;
  const pageTitle = safeFileName((state.page && state.page.title) || "tencent");
  const pageUrl = (state.page && state.page.url) || "";
  const diag = { wrAll: 0, wrM3u8: 0, wrSeg: 0, bodyM3u8: 0, bodySegs: 0, tried: 0 };

  try {
    // ===== 第一路径（猫抓同款）：直接用浏览器真实发出过的请求，不探测、不猜后缀 =====
    setS("读取播放会话已发出的请求…");
    let picked = null;
    try {
      picked = await tencentPickFromSession(state.tabId, diag, setS);
    } catch (eA) {
      console.warn("[vdm-tq] 会话直取异常：", eA && eA.message);
    }
    if (picked && picked.segs && picked.segs.length) {
      const first = await _vdmBytes(picked.segs[0], 9000);
      if (first.ok && first.bytes > 8192) {
        const nm = pageTitle + ".mp4";
        setS("已锁定播放器会话片源（" + picked.via + "，" + picked.segs.length + " 片，首片 " +
          Math.round(first.bytes / 1024) + "KB）\n启动后台逐片下载 → 自动合成 mp4…", "ok");
        state.tqMergeActive = true; // 先置位，避免启动瞬间的进度消息因为标记未设而丢失
        setBgJob({ pct: 0.02, stage: "启动后台逐片下载…", name: "腾讯视频", done: 0, total: picked.segs.length });
        const start = await chrome.runtime.sendMessage({
          type: "TENCENT_BG_DOWNLOAD", manifestUrl: picked.m3u8, segs: picked.segs,
          name: nm, hosts: ["*"], referer: pageUrl
        });
        if (start && start.ok) {
          setS("后台下载已启动：" + nm + "（弹窗和页面都可关闭）…", "ok");
          toast("腾讯视频后台下载已启动");
          return;
        }
        state.tqMergeActive = false;
        setBgJob(null);
        setS("后台下载启动失败（" + ((start && start.error) || "未知") + "），改走页面中转…");
      } else {
        setS("扩展侧取片受限（" + Math.round(first.bytes / 1024) + "KB），改走页面中转…");
      }
      await tencentRelayDownload(state.tabId, picked.segs, pageTitle + ".mp4", setS);
      return;
    }

    // ===== 第二路径：读 vid → 自构造 getvinfo 换片源（第一路径没抓到时的兜底）=====
    let vid = null;
    try {
      setS("未捕获到会话片源，改用解析流程：读取 vid…（最长约 12 秒）");
      let vidErr = null;
      try {
        const res = await chrome.scripting.executeScript({
          target: { tabId: state.tabId }, world: "MAIN", func: tencentVidInPage
        });
        if (res && res[0] && typeof res[0].result !== "undefined") vid = res[0].result || null;
      } catch (e) {
        vidErr = (e && e.message) ? e.message : String(e);
      }
      if (!vid) {
        throw new Error("未获取到 vid" + (vidErr
          ? "（注入失败：" + vidErr + "）"
          : "（页面状态树/HTML/URL 均未命中；请确认在腾讯视频播放页且视频已加载几秒，刷新页面后重试）"));
      }
      setS("腾讯视频：换取片源 m3u8（最高画质）…");
      await chrome.scripting.executeScript({
        target: { tabId: state.tabId }, world: "MAIN", func: tencentResolveStart,
        args: [vid, pageUrl]
      });
      let r = null, tqErr = null;
      const t0 = Date.now();
      while (Date.now() - t0 < 25000) {
        await new Promise((res2) => setTimeout(res2, 500));
        let raw = null;
        try {
          const pr = await chrome.scripting.executeScript({
            target: { tabId: state.tabId }, world: "MAIN", func: tencentResolvePoll
          });
          raw = (pr && pr[0] && pr[0].result) || null;
        } catch (e) { tqErr = (e && e.message) || String(e); break; }
        if (raw) {
          try {
            const j = JSON.parse(raw);
            if (j.ok) r = j.data; else tqErr = j.error;
          } catch (e2) { tqErr = "结果解析失败：" + ((e2 && e2.message) || e2); }
          break;
        }
      }
      if (!r) throw new Error(tqErr || "换取片源超时（25 秒），请刷新页面后重试");

      // 分支 A（首选）：fn+fvkey 渐进式 mp4 直链 → 浏览器原生下载栈
      if (r.direct) {
        const dName = pageTitle + ".mp4";
        const dTxt = (r.vw && r.vh) ? " · " + r.vw + "×" + r.vh : "";
        setS("已选腾讯视频 MP4 直链" + dTxt + "\n浏览器原生下载已启动（可关闭弹窗）…", "ok");
        await chrome.downloads.download({ url: r.direct, filename: dName, saveAs: false });
        toast("腾讯视频直链下载已启动");
        return;
      }
      if (!r.m3u8) throw new Error("无可用 HLS 片源（可能需登录或 VIP）");

      const resTxt = (r.vw && r.vh) ? " · " + r.vw + "×" + r.vh : "";
      setS("已选腾讯视频 HLS" + resTxt + "\n校验可用线路…");
      let segs = null;
      try {
        const lineList = (r.m3u8List && r.m3u8List.length ? r.m3u8List : [r.m3u8]);
        let wrCand = [], wrSeeds = [];
        try {
          const wr = await chrome.runtime.sendMessage({ type: "GET_WR_MEDIA", tabId: state.tabId });
          if (wr && wr.ok && Array.isArray(wr.items)) {
            for (const it of wr.items) {
              if (!it || !it.url || /^https?:/i.test(it.url) === false) continue;
              if (it.kind === "seg") { if (wrSeeds.indexOf(it.url) < 0) wrSeeds.push(it.url); }
              else if (wrCand.indexOf(it.url) < 0 && lineList.indexOf(it.url) < 0) wrCand.push(it.url);
            }
          }
        } catch (eWr) {}
        await chrome.scripting.executeScript({
          target: { tabId: state.tabId }, world: "MAIN", func: tencentPickM3u8Start,
          args: [JSON.stringify(lineList), JSON.stringify(wrCand.slice(0, 16)), JSON.stringify(wrSeeds.slice(0, 8))]
        });
        const t0m = Date.now();
        while (Date.now() - t0m < 45000) {
          await new Promise((res2) => setTimeout(res2, 500));
          const pr = await chrome.scripting.executeScript({
            target: { tabId: state.tabId }, world: "MAIN", func: tencentPickM3u8Poll
          });
          const raw = (pr && pr[0] && pr[0].result) || null;
          if (raw) {
            const j = JSON.parse(raw);
            if (j.ok) { segs = j.segs; }
            else throw new Error(j.error);
            break;
          }
        }
        if (!segs) throw new Error("线路校验超时（45 秒）");
      } catch (ePage) {
        throw new Error("无可用线路：" + ((ePage && ePage.message) || ePage) +
          "——自构造的片源 URL 会被 CDN 标记（只给 16KB 就断流），请让视频多播放几秒后重试");
      }
      await tencentRelayDownload(state.tabId, segs, pageTitle + ".mp4", setS);
    } catch (eInner) {
      throw eInner;
    }
  } catch (e) {
    setS("腾讯视频下载失败：" + String((e && e.message) || e) + _vdmDiag(diag), "err");
  } finally {
    btn.disabled = false;
    btn.textContent = oldLabel;
  }
}

// 收集「直接下载」所需的候选清单 URL：webRequest 会话 + 页面缓存响应体 + 资源时序表。
// 按"最像有效清单"排序并截断，避免逐个拉大文件浪费时间。
async function tencentCollectCandidates(tabId) {
  const set = new Set();
  const push = (u) => { if (u && /^https?:/i.test(u)) set.add(u); };
  try {
    const wr = await chrome.runtime.sendMessage({ type: "GET_WR_MEDIA", tabId: tabId });
    if (wr && wr.ok && Array.isArray(wr.items)) for (const it of wr.items) if (it && it.url) push(it.url);
  } catch (e) {}
  try {
    const pr = await chrome.scripting.executeScript({
      target: { tabId }, world: "MAIN",
      func: () => (window.__vdm_hls_body__ || []).map(function (b) { return b.url; })
    });
    const arr = JSON.parse((pr && pr[0] && pr[0].result) || "[]") || [];
    arr.forEach(push);
  } catch (e) {}
  try {
    const pr2 = await chrome.scripting.executeScript({
      target: { tabId }, world: "MAIN",
      func: () => {
        const out = [];
        const es = performance.getEntriesByType("resource") || [];
        for (const e of es) {
          const u = e.name;
          if (/m3u8|manifest|playlist|\.mpd|getvinfo|vinfo|getinfo|hls|dash/i.test(u)) out.push(u);
        }
        return out;
      }
    });
    const arr2 = JSON.parse((pr2 && pr2[0] && pr2[0].result) || "[]") || [];
    arr2.forEach(push);
  } catch (e) {}
  const list = Array.from(set);
  const pri = (u) => {
    let s = 0;
    if (/m3u8|playlist|manifest/i.test(u)) s += 100;
    if (/getvinfo|vinfo|getinfo/i.test(u)) s += 60;
    if (/smtcdns|tc\.qq\.com|moviets|myqcloud|qcloudcdn/i.test(u)) s += 40;
    if (/\.ts(\?|#|$)|fmp4|m4s/i.test(u)) s -= 30;
    if (/\.(js|css|png|json)(\?|#|$)/i.test(u)) s -= 50;
    return s;
  };
  list.sort((a, b) => pri(b) - pri(a));
  return list.slice(0, 40);
}

// 主路径：点一下直接并发下全片（猫抓同款思路）。
// ① 收集候选清单 URL → ② 主世界重新拉取有效签名清单并解析 → ③ 主世界 8 并发下载并保存。
async function tencentDirectDownload() {
  const btn = $("tqBtn");
  const $status = $("tqStatus");
  const setS = (t, cls) => { $status.textContent = t; $status.className = "tq-status" + (cls ? " " + cls : ""); };
  if (!state.tabId) { setS("未找到页面标签，请刷新页面后重试", "err"); return; }
  btn.disabled = true;
  const oldLabel = btn.textContent;
  btn.textContent = "解析清单…";
  try {
    setS("读取播放会话已发出的请求…");
    const cands = await tencentCollectCandidates(state.tabId);
    if (!cands.length) {
      setS("未抓到任何候选清单 URL。\n请先打开腾讯视频并播放几秒（让播放器发出 m3u8 请求），再点本按钮。", "err");
      return;
    }
    setS("已锁定 " + cands.length + " 个候选，主世界重新拉取有效签名清单…");
    const r = await chrome.scripting.executeScript({
      target: { tabId: state.tabId }, world: "MAIN",
      func: (c) => window.__vdm_resolve_playlist__(c), args: [cands]
    });
    const res = (r && r[0] && r[0].result) || null;
    if (!res || !res.ok) {
      setS("重新拉取清单失败：" + ((res && res.error) || "未知") + "\n可改试「嗅探兜底」或「边播边存」。", "err");
      return;
    }
    const vN = res.video ? res.video.segs.length : 0;
    const aN = res.audio ? res.audio.segs.length : 0;
    setS("清单就绪（" + res.via + "）：视频 " + vN + " 片" + (aN ? " + 音频 " + aN + " 片" : "") + "\n立即 8 并发下载并保存…", "ok");
    const d = await chrome.scripting.executeScript({
      target: { tabId: state.tabId }, world: "MAIN",
      func: (pl) => window.__vdm_direct_download__(pl), args: [res]
    });
    const out = (d && d[0] && d[0].result) || null;
    if (out && out.ok) {
      const detail = out.files.map(f => f.name + "（" + f.mb + "MB，" + f.done + "/" + f.total + "）").join(" + ");
      setS("下载完成：" + detail + "\n已保存到浏览器下载目录。", "ok");
      toast("腾讯视频下载完成：" + out.files.map(f => f.name).join(" + "));
    } else {
      setS("下载中断：" + ((out && out.error) || "未知") + "。可改试「边播边存」。", "err");
    }
  } catch (e) {
    setS("直接下载异常：" + ((e && e.message) || e) + "。可试「边播边存」兜底。", "err");
  } finally {
    btn.disabled = false;
    btn.textContent = oldLabel;
  }
}

async function tencentSeekEnd() {
  const btn = $("tqSeekBtn");
  if (btn) btn.disabled = true;
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId: state.tabId }, world: "MAIN", func: () => window.__vdm_tq_seek_end__()
    });
    const res = (r && r[0] && r[0].result) || null;
    toast(res && res.ok ? "已快进到片尾，正在捕获末尾分片…" : "快进失败：" + ((res && res.error) || "无 video"));
  } catch (e) { toast("快进异常：" + ((e && e.message) || e)); }
  finally { if (btn) btn.disabled = false; }
}

async function tencentMseSave() {
  const btn = $("tqSaveBtn");
  if (btn) btn.disabled = true;
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId: state.tabId }, world: "MAIN", func: () => window.__vdm_mse_save__()
    });
    const res = (r && r[0] && r[0].result) || null;
    if (res && res.ok) {
      toast("已保存录制：" + res.files.map(f => f.name + "（" + f.mb + "MB）").join(" + "));
    } else {
      toast("保存失败：" + ((res && res.error) || "未知"));
    }
  } catch (e) { toast("保存异常：" + ((e && e.message) || e)); }
  finally { if (btn && state._mseSize > 0) btn.disabled = false; }
}


// 给「当前站点 + 媒体资源所在 host」安装一条 Referer 伪装规则：
// 爱奇艺 / 腾讯 / 优酷等 CDN 只认站点来源，扩展 origin 的 fetch 常被 403/405 拒绝。
// 规则由 background 用 DNR 装，且只在扩展自身发起的请求上生效（不影响页面）。
// extraHosts: MPD/HLS 内部解析出的真实分片 host 列表（爱奇艺 MPD 在 meta-cdn.* 但
//             分片在 data.video.* / cache.video.* 等其他 host）。
async function armMediaRefererRule(m, extraHosts) {
  try {
    const hosts = new Set();
    const addHost = (u) => {
      try {
        const h = new URL(u).hostname.replace(/^www\./, "");
        if (!h) return;
        hosts.add(h);
        // 再补父域（data.video.iqiyi.com → iqiyi.com），覆盖同站其他 CDN 子域
        const parts = h.split(".");
        if (parts.length >= 3) hosts.add(parts.slice(-2).join("."));
      } catch (e) {}
    };
    if (extraHosts && extraHosts.length) extraHosts.forEach(addHost);
    addHost(m && m.url);
    addHost(state.page && state.page.url);
    const referer = (state.page && state.page.url) || null;
    if (!hosts.size || !referer) return false;
    const resp = await chrome.runtime.sendMessage({
      type: "SET_REFERER_RULE",
      hosts: Array.from(hosts),
      referer: referer
    });
    return !!(resp && resp.ok);
  } catch (e) {
    return false;
  }
}

// 主世界回退下载：扩展页 fetch 被 CDN 拒绝（403/405/Origin 白名单）时，
// 把分片列表交给页面主世界去拉（带站点 cookie + referrer），拿回 blob URL。
// rep 结构：{ init: {url, range?}|string|null, segments: [{url, range?}|string], mime }
async function mainWorldDownloadTrack(rep, kind, show, asUrl) {
  if (!state.tabId) throw new Error("未找到页面标签，无法回退到页面下载");
  const norm = (s) => (typeof s === "string" ? { url: s, range: null } : s);
  const initSpec = rep && rep.init ? norm(rep.init) : null;
  const segments = (rep && rep.segments ? rep.segments : []).map(norm);
  if (!initSpec && !segments.length) throw new Error("该轨道没有可下载的分片");
  if (show) show("改用页面下载" + (kind === "audio" ? "音轨" : "视频") + "…");
  const resp = await chrome.tabs.sendMessage(state.tabId, {
    type: "MAIN_TRACK_DOWNLOAD",
    kind: kind || "video",
    initSpec: initSpec,
    segments: segments,
    mime: (rep && rep.mime) || (kind === "audio" ? "audio/mp4" : "video/mp4")
  });
  if (!resp || !resp.ok || !resp.blobUrl) {
    throw new Error((resp && resp.error) || "页面下载失败");
  }
  // asUrl=true：不把内容读进 popup 内存，直接拿 blobUrl 交给 chrome.downloads 落盘
  // （大文件走这条，省掉一次「popup fetch → Blob」的内存翻倍）
  if (asUrl) return { blobUrl: resp.blobUrl, size: resp.size || 0 };
  const r = await fetch(resp.blobUrl);
  if (!r.ok) throw new Error("读取页面下载结果失败 HTTP " + r.status);
  return await r.blob();
}

function guessExt(u) {
  // 黑名单防御：网页类扩展名（htm/html/php/asp/...）一律回退 .mp4，
  // 避免 Edge「增强安全性 → 下载」按 HTML 类别拦截（提示「无法下载 - 没有权限」）。
  return safeExtFromUrl(u);
}

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url: url, filename: name, saveAs: !!state.settings.askPath }, () => {
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    if (chrome.runtime.lastError) toast("下载失败：" + chrome.runtime.lastError.message);
  });
}

// ---------- 事件绑定 ----------
$("retry").onclick = load;

$("tabs").querySelectorAll(".tab").forEach((t) => {
  t.onclick = () => {
    $("tabs").querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    state.tab = t.dataset.tab;
    renderList();
  };
});

$("quick").querySelectorAll(".qbtn").forEach((b) => {
  b.onclick = () => quickDownload(b.dataset.quick);
});

$("dlSub").onclick = onDownloadSubtitle;
$("dlThumb").onclick = onDownloadThumb;
$("dlJson").onclick = onDownloadJson;
$("dlChapters").onclick = onDownloadChapters;

$("iqBtn").onclick = doIqiyiDownload;
$("tqBtn").onclick = tencentDirectDownload;       // 主路径：点一下直接并发下全片
$("tqSniffBtn").onclick = doTencentDownload;       // 嗅探兜底（旧线路，慢/易失效）
$("tqSeekBtn").onclick = tencentSeekEnd;           // 边播边存兜底：快进捕获末尾分片
$("tqSaveBtn").onclick = tencentMseSave;           // 边播边存兜底：导出录制字节

$("tpl").value = state.settings.template;
$("tpl").oninput = () => { state.settings.template = $("tpl").value; saveSettings(); };
$("subFmt").value = state.settings.subFmt || "srt";
$("subFmt").onchange = () => { state.settings.subFmt = $("subFmt").value; saveSettings(); };
$("askPath").checked = !!state.settings.askPath;
$("askPath").onchange = () => { state.settings.askPath = $("askPath").checked; saveSettings(); };

// 切换数据源（默认 auto：自动挑可用高清；也可手动指定某客户端）后重新拉取
$("clientSel").onchange = () => {
  state.settings.client = $("clientSel").value;
  saveSettings();
  load();
};

loadSettings().then(load);

// B 站主世界下载进度：content.js 转发 BILI_DASH_PROGRESS → 刷新 show 文案。
// state._dashSink 由 downloadMedia 的 B 站分支挂载/清除；无活动下载时消息直接忽略。
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== "BILI_DASH_PROGRESS") return;
  if (typeof state._dashSink === "function") {
    try { state._dashSink(msg.kind || "video", msg); } catch (e) {}
  }
});
