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
  settings: { template: "{title} [{quality}]", askPath: false, subFmt: "srt", client: "auto" }
};

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
  if (!_active.size) { box.classList.add("hidden"); box.innerHTML = ""; return; }
  box.classList.remove("hidden");
  let html = "";
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
  if (msg.type === "MERGE_PROGRESS") {
    $err.textContent =
      "后台合并 " + Math.round((msg.pct || 0) * 100) + "%：" + (msg.stage || "") +
      "（可关闭本弹窗）";
    $err.style.display = "block";
    $err.style.cursor = "default";
  } else if (msg.type === "MERGE_DONE") {
    resetErrStyle();
    toast("后台合并完成，已保存到浏览器下载：" + (msg.name || ""));
  } else if (msg.type === "MERGE_FAIL") {
    resetErrStyle();
    toast("后台合并失败：" + (msg.error || "未知原因"));
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
  setErr("");
  resetErrStyle();
  state._probeNote = null;
  state._potNote = null;
  $list.innerHTML = '<div class="empty">解析中…</div>';
  ["meta", "quick", "tabs", "filters", "extra", "srcbar"].forEach((id) => $(id).classList.add("hidden"));

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/youtube\.com\/watch/.test(tab.url || "")) {
    $list.innerHTML = '<div class="empty">请在 YouTube 视频页（/watch）打开本插件</div>';
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
