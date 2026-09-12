// media-main.js — 通用媒体嗅探引擎（MAIN 世界，全站注入）
//
// 思路：不做「每站一个解析器」（维护量无限），而是抓住所有站点都要做的同一件事——
// 播放器必须向网络请求媒体数据。只要把请求的 URL 抓出来，就能下载。
// 三路互补，覆盖「打开扩展之前/之后」和「不同加载方式」：
//   1) PerformanceObserver(buffered:true)：回放页面已发生的所有资源请求（含打开弹窗之前的）
//   2) hook fetch / XHR：捕获之后发出的实时请求
//   3) 扫描 <video> 元素：拿到 src / currentSrc（直链站点的主要来源）
// 最后按扩展名分类去重，通过 postMessage 交给隔离世界的 content.js。
(function () {
  if (window.__vdm_injected__) return;
  window.__vdm_injected__ = true;

  // ===== 腾讯视频 / 通用 MSE 录制：hook MediaSource 截获播放器 append 的媒体字节 =====
  // 思路来自猫抓(cat-catch)：不重新下载、不碰带签名的分片 URL，而是播放器每往 SourceBuffer
  // 塞一片「已用有效签名拉下来」的解码后数据，我们就复制一份存下来。这样拿到的是真实字节，
  // 彻底绕开腾讯分片「签名过期 / 自构造 URL 被 CDN 标记」的死穴。
  // 注意：这是 document_start 即安装的常驻 hook；只在页面真用了 MSE 时才产生数据。
  (function () {
    try {
      if (!window.MediaSource || window.__vdm_mse) return;
      var mse = window.__vdm_mse = {
        tracks: [], size: 0, complete: false, active: true, _last: 0
      };
      // 复制为独立 buffer：播放器可能 transfer/detach 原 chunk，必须快照
      function cloneChunk(chunk) {
        try {
          if (chunk instanceof ArrayBuffer) return chunk.slice(0);
          if (chunk && chunk.buffer && chunk.byteLength != null) {
            var u = (chunk instanceof Uint8Array) ? chunk
              : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
            return u.slice().buffer;
          }
        } catch (e) {}
        return null;
      }
      function notify() {
        var now = Date.now();
        if (now - mse._last < 400) return; // 节流，避免每条分片都发消息
        mse._last = now;
        try { chrome.runtime.sendMessage({ type: "VM_SE_MSE_PROG", size: mse.size, tracks: mse.tracks.length, complete: mse.complete }); } catch (e) {}
      }
      var OrigAdd = window.MediaSource.prototype.addSourceBuffer;
      window.MediaSource.prototype.addSourceBuffer = function (mimeType) {
        var sb = OrigAdd.apply(this, arguments);
        var track = { mimeType: mimeType, buffers: [], size: 0, index: mse.tracks.length };
        mse.tracks.push(track);
        try {
          var OrigAppend = sb.appendBuffer.bind(sb);
          sb.appendBuffer = function (chunk) {
            try {
              var copy = cloneChunk(chunk);
              if (copy && copy.byteLength) { track.buffers.push(copy); track.size += copy.byteLength; mse.size += copy.byteLength; notify(); }
            } catch (e) {}
            return OrigAppend(chunk);
          };
          // 部分内核用 append(ArrayBuffer) 别名
          if (typeof sb.append === "function") {
            var OrigAppend2 = sb.append.bind(sb);
            sb.append = function (chunk) {
              try {
                var c = cloneChunk(chunk);
                if (c && c.byteLength) { track.buffers.push(c); track.size += c.byteLength; mse.size += c.byteLength; notify(); }
              } catch (e) {}
              return OrigAppend2(chunk);
            };
          }
        } catch (e) {}
        return sb;
      };
      var OrigEnd = window.MediaSource.prototype.endOfStream;
      window.MediaSource.prototype.endOfStream = function () {
        try { mse.complete = true; chrome.runtime.sendMessage({ type: "VM_SE_MSE_DONE" }); } catch (e) {}
        return OrigEnd.apply(this, arguments);
      };
    } catch (e) {}
  })();

  // ===== 腾讯 MSE 录制导出 / 快进捕获（兜底用，主路径是「直接下载」）=====
  // 把 hook 截到的各轨字节拼成 Blob 存盘；视频轨 .mp4、音频轨 .m4a。
  window.__vdm_mse_save__ = function () {
    var mse = window.__vdm_mse;
    if (!mse || !mse.tracks.length) return { ok: false, error: "尚未捕获到录制字节（请先播放视频）" };
    var hasData = mse.tracks.some(function (t) { return t.buffers && t.buffers.length; });
    if (!hasData) return { ok: false, error: "已建轨但无数据（播放器还没缓冲）" };
    var name = (document.title || "tencent_rec").replace(/[\\/:*?"<>|]/g, "_").slice(0, 80) || "tencent_rec";
    var files = [], vCount = 0;
    mse.tracks.forEach(function (tk) {
      if (!tk.buffers || !tk.buffers.length) return;
      var isAudio = /audio/i.test(tk.mimeType || "");
      if (!isAudio) vCount++;
      var blob = new Blob(tk.buffers, { type: isAudio ? "audio/mp4" : "video/mp4" });
      var fname = isAudio
        ? (name + "_音频.m4a")
        : (vCount > 1 ? (name + "_v" + vCount + ".mp4") : (name + ".mp4"));
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url; a.download = fname;
      (document.body || document.documentElement).appendChild(a); a.click(); a.remove();
      setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} }, 5000);
      files.push({ name: fname, mb: (blob.size / 1048576).toFixed(1), total: tk.buffers.length });
    });
    return { ok: true, files: files };
  };

  // 快进到片尾，逼迫播放器把末尾分片也 append 进 SourceBuffer（MSE 录制兜底用）
  window.__vdm_tq_seek_end__ = function () {
    var v = document.querySelector("video");
    if (!v) return { ok: false, error: "页面无 <video> 元素" };
    try {
      try { v.muted = true; } catch (e) {}
      try { v.playbackRate = Math.min(16, (v.playbackRate || 1) * 4) || 4; } catch (e) {}
      var guard = 0;
      var t = setInterval(function () {
        try {
          guard++;
          if (!isFinite(v.duration) || v.duration <= 0) { clearInterval(t); return; }
          if (v.currentTime < v.duration - 1.5) v.currentTime = v.duration - 1.5;
          else clearInterval(t);
        } catch (e) { clearInterval(t); }
        if (guard > 220) clearInterval(t);
      }, 400);
      setTimeout(function () { try { clearInterval(t); } catch (e) {} }, 90000);
      return { ok: true };
    } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
  };

  // ===== 腾讯「直接下载」：重新请求播放列表拿有效签名，一次性并发下全部分片 =====
  // 与猫抓点下载同一思路：拿到清单 URL → 立即重新请求清单（此时签名有效）→ 解析出全部分片
  // URL → 在主世界用 omit 凭据并发下载（主世界即播放器网络环境，签名有效）→ 拼接 fmp4 存盘。
  // 不依赖播放进度，点一下直接下完；绕开「自构造 URL 被标记 / 签名过期」。
  window.__vdm_resolve_playlist__ = function (cands) {
    // cands: [{url, text?}, ...]  text 为页面已缓存的响应体，优先用它避免重新 fetch 签名失效
    cands = cands || [];
    function abs(u, base) { try { return new URL(u, base).href; } catch (e) { return u; } }
    function get(u, ms) {
      return new Promise(function (resolve, reject) {
        var c = ("AbortController" in window) ? new AbortController() : null;
        var t = c ? setTimeout(function () { try { c.abort(); } catch (e) {} }, ms || 8000) : null;
        fetch(u, { credentials: "omit", referrer: location.href, signal: c ? c.signal : undefined })
          .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.text(); })
          .then(function (txt) { if (t) clearTimeout(t); resolve(txt); })
          .catch(function (e) { if (t) clearTimeout(t); reject(e); });
      });
    }
    function looksLikeM3u8(txt) { return /^#EXTM3U/.test((txt || "").trim()); }
    function parseMedia(txt, base) {
      var lines = txt.split(/\r?\n/), segs = [], map = null;
      for (var i = 0; i < lines.length; i++) {
        var l = (lines[i] || "").trim();
        if (l.indexOf("#EXT-X-MAP") === 0) { var mm = l.match(/URI="([^"]+)"/); if (mm) map = abs(mm[1], base); continue; }
        if (l && l[0] !== "#") segs.push(abs(l, base));
      }
      return { segs: segs, map: map };
    }
    function parseAsync(txt, base) {
      return (async function () {
        var lines = txt.split(/\r?\n/), video = null, audio = null;
        var hasMaster = lines.some(function (l) { return /#EXT-X-STREAM-INF/.test(l) || /#EXT-X-MEDIA/.test(l); });
        if (hasMaster) {
          for (var i = 0; i < lines.length; i++) {
            var l = (lines[i] || "").trim();
            if (/#EXT-X-MEDIA/i.test(l) && /TYPE="audio"/i.test(l)) {
              var au = l.match(/URI="([^"]+)"/);
              if (au) { try { var at = await get(abs(au[1], base), 8000); var ap = parseMedia(at, abs(au[1], base)); if (ap.segs.length) audio = ap; } catch (e) {} }
            }
          }
          for (var j = 0; j < lines.length; j++) {
            var l2 = (lines[j] || "").trim();
            if (l2.indexOf("#EXT-X-STREAM-INF") === 0) {
              var sub = (lines[j + 1] || "").trim();
              if (sub && sub[0] !== "#") { try { var vt = await get(abs(sub, base), 8000); var vp = parseMedia(vt, abs(sub, base)); if (vp.segs.length) video = vp; } catch (e) {} }
              break;
            }
          }
          return { video: video, audio: audio };
        }
        var pm = parseMedia(txt, base);
        return { video: pm, audio: null };
      })();
    }
    // 从一段文本里抽出所有 https?://... 链接，尝试当 m3u8 解析
    async function tryLinksInText(text, sourceUrl) {
      if (!text) return null;
      var links = [];
      var re = /https?:\/\/[^"'\s\\<>{}]+/ig, m;
      while ((m = re.exec(text)) !== null) {
        var u = m[0].replace(/[.,;:!?)\]}$]+$/, ""); // 去掉常见标点尾随
        if (u.indexOf("http") === 0 && links.indexOf(u) < 0) links.push(u);
      }
      for (var i = 0; i < links.length; i++) {
        try {
          var t = await get(links[i], 8000);
          if (looksLikeM3u8(t)) {
            var pl = await parseAsync(t, links[i]);
            if (pl.video && pl.video.segs.length) return { pl: pl, via: "link-in:" + sourceUrl };
          }
        } catch (e) {}
      }
      return null;
    }
    return (async function () {
      // 阶段 1：优先用缓存 text 直接解析（不重新 fetch，最可能成功）
      for (var n = 0; n < cands.length; n++) {
        var c = cands[n] || {};
        if (c.text && looksLikeM3u8(c.text)) {
          try {
            var pl = await parseAsync(c.text, c.url);
            if (pl.video && pl.video.segs.length) return { ok: true, video: pl.video, audio: pl.audio, via: "cache:" + c.url };
          } catch (e) {}
        }
      }
      // 阶段 2：重新 fetch 候选 URL（有 .m3u8 字样的优先）
      var tryList = cands.slice().sort(function (a, b) {
        var pa = /\.m3u8|m3u8|playlist|manifest/i.test(a.url || "");
        var pb = /\.m3u8|m3u8|playlist|manifest/i.test(b.url || "");
        return (pb ? 1 : 0) - (pa ? 1 : 0);
      });
      for (var n2 = 0; n2 < tryList.length; n2++) {
        try {
          var txt = await get(tryList[n2].url, 8000);
          if (looksLikeM3u8(txt)) {
            var pl2 = await parseAsync(txt, tryList[n2].url);
            if (pl2.video && pl2.video.segs.length) return { ok: true, video: pl2.video, audio: pl2.audio, via: "m3u8:" + tryList[n2].url };
          }
        } catch (e) {}
      }
      // 阶段 3：在缓存 text / fetch 到的响应体里搜所有 https?:// 链接（不限 .m3u8 扩展名）
      for (var m = 0; m < cands.length; m++) {
        var c2 = cands[m] || {};
        var body = c2.text;
        if (!body) {
          try { body = await get(c2.url, 8000); } catch (e) { continue; }
        }
        var found = await tryLinksInText(body, c2.url);
        if (found) return { ok: true, video: found.pl.video, audio: found.pl.audio, via: found.via };
      }
      return { ok: false, error: "候选里未找到有效 m3u8 清单（请确认视频已开始播放并加载，或改用「边播边存」兜底）" };
    })();
  };

  window.__vdm_direct_download__ = function (playlist) {
    function fullList(track) {
      if (!track) return [];
      return (track.map ? [track.map].concat(track.segs) : track.segs.slice());
    }
    function fetchOne(u, ms) {
      return new Promise(function (resolve, reject) {
        var c = ("AbortController" in window) ? new AbortController() : null;
        var t = c ? setTimeout(function () { try { c.abort(); } catch (e) {} }, ms || 15000) : null;
        fetch(u, { credentials: "omit", referrer: location.href, signal: c ? c.signal : undefined })
          .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.arrayBuffer(); })
          .then(function (b) { if (t) clearTimeout(t); if (!b || !b.byteLength) throw new Error("empty"); resolve(b); })
          .catch(function (e) { if (t) clearTimeout(t); reject(e); });
      });
    }
    function dlTrack(track, thread, tag) {
      var segs = fullList(track);
      return new Promise(function (resolve) {
        var bufs = new Array(segs.length), done = 0, fails = 0, i = 0, last = Date.now();
        var stop = false;
        function prog() {
          var now = Date.now();
          if (now - last > 600) {
            last = now;
            try { chrome.runtime.sendMessage({ type: "VM_SE_MSE_PROG", size: 0, tracks: 1, complete: false, direct: tag + " " + done + "/" + segs.length + (fails ? " 失败" + fails : "") }); } catch (e) {}
          }
        }
        function fetchWithRetry(my, retries) {
          fetchOne(segs[my], 15000)
            .then(function (b) { bufs[my] = b; done++; prog(); worker(); })
            .catch(function (e) {
              if ((retries || 0) < 2) { setTimeout(function () { fetchWithRetry(my, (retries || 0) + 1); }, 400); return; }
              fails++; bufs[my] = null; prog(); worker();
            });
        }
        function worker() {
          if (stop) return;
          if (i >= segs.length) { if (done + fails >= segs.length) { stop = true; resolve({ bufs: bufs, done: done, total: segs.length, fails: fails }); } return; }
          // 连续失败过多则提前收尾，避免空转
          if (fails > 0 && fails >= Math.max(5, Math.floor(done * 0.1) + 3)) { stop = true; resolve({ bufs: bufs, done: done, total: segs.length, fails: fails }); return; }
          var my = i++;
          fetchWithRetry(my, 0);
        }
        var t = Math.min(thread || 8, segs.length) || 1;
        for (var k = 0; k < t; k++) worker();
      });
    }
    return (async function () {
      var name = (document.title || "tencent").replace(/[\\/:*?"<>|]/g, "_").slice(0, 80) || "tencent";
      var files = [];
      if (playlist.video && playlist.video.segs.length) {
        var rv = await dlTrack(playlist.video, 8, "视频");
        if (rv.done < rv.total * 0.5) throw new Error("视频轨下载失败过多（" + rv.fails + "/" + rv.total + "），请刷新后重试或改用「边播边存」");
        files.push({ blob: new Blob(rv.bufs.filter(Boolean), { type: "video/mp4" }), name: name + ".mp4", done: rv.done, total: rv.total });
      }
      if (playlist.audio && playlist.audio.segs.length) {
        var ra = await dlTrack(playlist.audio, 8, "音频");
        if (ra.done < ra.total * 0.5) throw new Error("音频轨下载失败过多（" + ra.fails + "/" + ra.total + "）");
        files.push({ blob: new Blob(ra.bufs.filter(Boolean), { type: "audio/mp4" }), name: name + "_音频.m4a", done: ra.done, total: ra.total });
      }
      files.forEach(function (it) {
        var url = URL.createObjectURL(it.blob);
        var a = document.createElement("a");
        a.href = url; a.download = it.name;
        (document.body || document.documentElement).appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
      });
      return { ok: true, files: files.map(function (f) { return { name: f.name, done: f.done, total: f.total, mb: (f.blob.size / 1048576).toFixed(1) }; }) };
    })();
  };

  var MANIFEST = /\.(m3u8|mpd)(\?|#|$)/i;                       // HLS / DASH 清单
  var PROGRESSIVE = /\.(mp4|webm|ogv|mov|flv|mkv)(\?|#|$)/i;    // 可直接播放的完整文件
  var AUDIO = /\.(m4a|mp3|aac|oga|opus|wav)(\?|#|$)/i;
  var SEGMENT = /\.(ts|m4s|aac|mp4\?.*range=)(\?|#|$)/i;        // MSE 分片（需站点适配）
  var ANY = /\.(m3u8|mpd|mp4|webm|ogv|mov|flv|mkv|m4a|mp3|aac|oga|opus|wav|ts|m4s)(\?|#|$)/i;
  // 网页类扩展名黑名单：B 站页面常夹杂 .htm/.html 子请求（分享页/iframe/错误页），
  // 若被误捕为「other」类型会进入下载列表，点击后 Edge 会按 HTML 类别拦截下载
  // （提示「无法下载 - 没有权限」）。defense in depth：无论 classify 与否都直接剔除。
  var WEB_EXT = /\.(htm|html|php|asp|aspx|jsp|cgi|do|action)(\?|#|$)/i;
  // 遥测/埋点端点（B 站 data.bilibili.com/log/web?…、各站 /report 系）永远不是媒体
  var TELEMETRY = /\/\/[^/]*\/(log|report|data\/report)\//i;

  var found = Object.create(null); // url -> entry
  var mseUsed = false;
  var bilibiliAdapter = null; // B 站专属：调 playurl API 拿完整 dash 描述

  function classify(url) {
    if (MANIFEST.test(url)) return /\.mpd(\?|#|$)/i.test(url) ? "dash" : "hls";
    if (PROGRESSIVE.test(url)) return "video";
    if (AUDIO.test(url)) return "audio";
    if (/\.m4s(\?|#|$)/i.test(url)) return "m4s";
    if (/\.ts(\?|#|$)/i.test(url)) return "ts";
    if (/m3u8/i.test(url)) return "hls"; // 无 .m3u8 扩展名的清单 URL 兜底（腾讯等用查询串携带）
    return null;
  }

  // 响应体缓存：播放器的清单/片源数据可能不是 .m3u8（甚至是 getvinfo JSON），
  // 故放宽接收：含 #EXTM3U，或含播放器会话特征（m3u8/.ts 链接/smtcdns/vkey）一律入缓存
  var hlsBodies = []; // {url, text, t}
  function cacheHlsBody(url, text) {
    if (!url || !text || text.length > 5242880) return;
    var interesting = text.indexOf("#EXTM3U") >= 0 ||
      /\.m3u8|\.ts\?|smtcdns|tc\.qq\.com|vkey/i.test(text);
    if (!interesting) return;
    for (var i = 0; i < hlsBodies.length; i++) {
      if (hlsBodies[i].url === url) { hlsBodies[i].text = text; hlsBodies[i].t = Date.now(); return; }
    }
    hlsBodies.push({ url: url, text: text, t: Date.now() });
    if (hlsBodies.length > 12) hlsBodies.shift();
  }
  try {
    Object.defineProperty(window, "__vdm_hls_body__", {
      get: function () { return hlsBodies; },
      configurable: true
    });
  } catch (e) {
    window.__vdm_hls_body__ = hlsBodies;
  }

  function host(u) {
    try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return ""; }
  }

  function add(url, size) {
    if (!url || typeof url !== "string") return;
    if (!/^https?:/i.test(url) && !url.startsWith("//")) return;
    if (url.indexOf("blob:") === 0) return;
    if (WEB_EXT.test(url)) return; // 网页类扩展名永不进嗅探列表
    if (TELEMETRY.test(url)) return; // 遥测/埋点端点永不进嗅探列表
    var kind = classify(url);
    if (!kind && !ANY.test(url)) return;

    var e = found[url];
    if (!e) {
      e = found[url] = { url: url, type: kind || "other", size: 0, host: host(url), mse: false };
      notify();
    }
    if (!kind && e.type === "other") e.type = "other";
    if (size && !e.size) { e.size = size; notify(); }
  }

  // ---- 1) 回放已发生的资源请求 ----
  function scanTiming() {
    try {
      var entries = performance.getEntriesByType("resource") || [];
      for (var i = 0; i < entries.length; i++) {
        add(entries[i].name, entries[i].transferSize || entries[i].encodedBodySize || 0);
      }
    } catch (e) {}
  }
  scanTiming();
  try {
    new PerformanceObserver(function (list) {
      var es = list.getEntries() || [];
      for (var i = 0; i < es.length; i++) add(es[i].name, es[i].transferSize || es[i].encodedBodySize || 0);
    }).observe({ type: "resource", buffered: true });
  } catch (e) {}

  // ---- 2) hook 实时请求（含 m3u8 响应体捕获）----
  // 捕获判定：URL 像清单 / content-type 是 mpegurl / 小体积 octet-stream·text（改名清单）。
  // 腾讯等播放器的清单 URL 可能不含 "m3u8" 字样，只按 URL 过滤会漏——故加内容启发式。
  function looksLikeManifest(u, ct, cl) {
    if (u && /m3u8|\.mpd(\?|#|$)|playlist|manifest/i.test(String(u))) return true;
    // 腾讯播放器会话的 getvinfo/getinfo JSON 响应里带未标记的 m3u8/分片 URL——必抓
    if (u && /getvinfo|getinfo|vinfo/i.test(String(u))) return true;
    ct = String(ct || "");
    if (/mpegurl|dash\+xml|\/mpd/i.test(ct)) return true;
    if (/json/i.test(ct)) return true; // JSON 由 cacheHlsBody 按内容特征自过滤
    var n = parseInt(cl, 10);
    if ((isNaN(n) || n < 524288) && /octet-stream|text\/plain|text\/html/i.test(ct)) return true;
    return false;
  }
  var _fetch = window.fetch;
  if (typeof _fetch === "function") {
    window.fetch = function (input, init) {
      var u = "";
      try {
        u = typeof input === "string" ? input : input && input.url || "";
        add(u, 0);
      } catch (e) {}
      var p = _fetch.apply(this, arguments);
      if (u) {
        try {
          p.then(function (resp) {
            try {
              if (!resp || resp.type === "opaque") return;
              var ct = "", cl = "";
              try { ct = resp.headers.get("content-type") || ""; } catch (e3) {}
              try { cl = resp.headers.get("content-length") || ""; } catch (e3) {}
              if (!looksLikeManifest(u, ct, cl)) return;
              resp.clone().text().then(function (txt) {
                try { cacheHlsBody(String(resp.url || u), txt); } catch (e2) {}
              }).catch(function () {});
            } catch (e2) {}
          }).catch(function () {});
        } catch (e2) {}
      }
      return p;
    };
  }
  if (window.XMLHttpRequest && XMLHttpRequest.prototype.open) {
    var _open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      try { add(url, 0); } catch (e) {}
      return _open.apply(this, arguments);
    };
    var _send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function () {
      var self = this;
      try {
        self.addEventListener("load", function () {
          try {
            var rt = self.responseType;
            if (!(rt === "" || rt === "text")) return;
            var txt = self.responseText;
            // XHR 的 responseText 已在内存，直接交 cacheHlsBody 按内容特征判定
            // （#EXTM3U 清单 或 getvinfo JSON——后者含播放器未标记的 m3u8/分片 URL）
            if (txt && txt.length < 5242880) {
              var u = "";
              try { u = self.responseURL || self.__vdm_url || ""; } catch (e) {}
              cacheHlsBody(u, txt);
            }
          } catch (e) {}
        });
      } catch (e) {}
      return _send.apply(this, arguments);
    };
  }

  // ---- 3) 扫描 <video> / <audio> 元素 ----
  function scanElements() {
    try {
      var els = document.querySelectorAll("video, audio");
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        add(el.src, 0);
        add(el.currentSrc, 0);
        var srcs = el.querySelectorAll && el.querySelectorAll("source");
        if (srcs) for (var j = 0; j < srcs.length; j++) add(srcs[j].src, 0);
      }
    } catch (e) {}
  }
  scanElements();
  setInterval(scanElements, 1500);

  // ---- 4) MSE 检测：用了 MediaSource 说明是「分片拼装」类站点（B站/爱奇艺等） ----
  if (window.MediaSource) {
    var OM = window.MediaSource;
    try {
      var Wrapped = function () {
        mseUsed = true;
        return new OM();
      };
      Wrapped.prototype = OM.prototype;
      Object.getOwnPropertyNames(OM).forEach(function (k) {
        try { Wrapped[k] = OM[k]; } catch (e) {}
      });
      window.MediaSource = Wrapped;
    } catch (e) {}
  }

  // ---- 5) 对外接口：content.js 通过 postMessage 索取 ----
  function list() {
    var arr = [];
    for (var k in found) {
      var e = found[k];
      e.mse = mseUsed && (e.type === "m4s" || e.type === "ts");
      arr.push(e);
    }
    // B 站专属的 dash 整包数据（如果适配器已拿到）
    if (bilibiliAdapter && bilibiliAdapter.playurl) {
      arr.unshift({
        url: "bilibili://playurl",
        type: "dash",
        size: 0,
        host: host(location.href),
        mse: true,
        bilibili: true,
        playurl: bilibiliAdapter.playurl,
        label: bilibiliAdapter.label || "B 站 DASH"
      });
    }
    // 清单优先、大文件优先
    var order = { hls: 0, dash: 1, video: 2, audio: 3, m4s: 4, ts: 5, other: 6 };
    arr.sort(function (a, b) {
      return (order[a.type] - order[b.type]) || (b.size - a.size);
    });
    return arr;
  }

  // ---- B 站适配器：识别播放页 → 调 /x/player/playurl 拿 dash → 缓存 ----
  function parseRange(s) {
    var m = /(\d+)-(\d+)/.exec(s || "");
    return m ? [parseInt(m[1], 10), parseInt(m[2], 10)] : null;
  }

  // 取番剧当前集/默认集（epInfo 优先，否则 mediaInfo.episodes 第一集）
  function bilibiliPickDefaultEpisode(init) {
    if (!init) return null;
    try {
      if (init.epInfo && init.epInfo.id) {
        return {
          epId: String(init.epInfo.id),
          cid: init.epInfo.cid != null ? String(init.epInfo.cid) : null,
          bvid: init.epInfo.bvid || null,
          aid: init.epInfo.aid != null ? String(init.epInfo.aid) : null
        };
      }
      var eps = (init.mediaInfo && (init.mediaInfo.episodes || init.mediaInfo.epList)) || [];
      if (eps.length) {
        var e0 = eps[0];
        return {
          epId: String(e0.id),
          cid: e0.cid != null ? String(e0.cid) : null,
          bvid: e0.bvid || null,
          aid: e0.aid != null ? String(e0.aid) : null
        };
      }
    } catch (e) {}
    return null;
  }

  function bilibiliGetVideoMeta() {
    try {
      var path = location.pathname;
      var bvid = null, aid = null, cid = null, epId = null, ssId = null;
      var isBangumi = /\/bangumi\/play\//.test(path);

      // 解析 __INITIAL_STATE__（可能是对象，部分场景是 JSON 字符串）
      var init = null;
      try {
        init = window.__INITIAL_STATE__ || window.__INITIAL_DATA__ || null;
        if (typeof init === "string") init = JSON.parse(init);
      } catch (e) { init = null; }

      if (isBangumi) {
        // 番剧页：ssxxxx = season_id，epxxxx = ep_id（二者不同）
        var ep = path.match(/\/bangumi\/play\/ep(\d+)/);
        var ss = path.match(/\/bangumi\/play\/ss(\d+)/);
        if (ep) epId = ep[1];
        if (ss) ssId = ss[1];

        // 番剧页无 ep_id（只有 ss）时，从全局状态取当前集/默认集
        if (!epId) {
          var def = bilibiliPickDefaultEpisode(init);
          if (def) {
            epId = def.epId;
            if (!cid) cid = def.cid;
            if (!bvid) bvid = def.bvid;
            if (!aid) aid = def.aid;
          }
        } else if (init && init.epInfo) {
          // 指定了 ep：优先用 epInfo 里的 cid
          if (!cid && init.epInfo.cid != null) cid = String(init.epInfo.cid);
          if (!bvid && init.epInfo.bvid) bvid = init.epInfo.bvid;
          if (!aid && init.epInfo.aid != null) aid = String(init.epInfo.aid);
        }

        // 仍缺 cid 但有 ep_id：从 mediaInfo.episodes 按 ep_id 匹配
        if (!cid && epId && init && init.mediaInfo) {
          var eps = init.mediaInfo.episodes || init.mediaInfo.epList || [];
          for (var ei = 0; ei < eps.length; ei++) {
            if (String(eps[ei].id) === String(epId)) {
              cid = String(eps[ei].cid);
              if (!bvid) bvid = eps[ei].bvid || null;
              if (!aid) aid = eps[ei].aid != null ? String(eps[ei].aid) : null;
              break;
            }
          }
        }
      } else {
        // 普通视频页 /video/BVxxx 或 /video/avxxx
        var m = path.match(/\/video\/(BV[1-9A-HJ-NP-Za-km-z]+|\d+)/);
        if (m) {
          if (m[1].indexOf("BV") === 0) bvid = m[1];
          else aid = m[1];
        }
        if (init && init.videoData) {
          if (init.videoData.bvid) bvid = init.videoData.bvid;
          if (init.videoData.aid) aid = String(init.videoData.aid);
          if (init.videoData.cid != null) cid = String(init.videoData.cid);
        }
      }

      // 从 URL 参数兜底
      if (!cid) {
        var qs = location.search.slice(1).split("&");
        for (var i = 0; i < qs.length; i++) {
          var kv = qs[i].split("=");
          if (kv[0] === "cid" || kv[0] === "p") cid = decodeURIComponent(kv[1] || "");
        }
      }

      // 普通视频靠 bvid/aid，番剧靠 ep_id 或 season_id
      var ok = bvid || aid || (isBangumi && (epId || ssId));
      return ok
        ? { bvid: bvid, aid: aid, cid: cid, epId: epId, ssId: ssId, isBangumi: isBangumi }
        : null;
    } catch (e) { return null; }
  }

  // ---------- B 站 wbi 签名（pgc playurl 强制要求） ----------
  // 紧凑 MD5（输入视为 UTF-8 字符串），返回 32 位小写 hex（blueimp 标准实现）
  function bilibiliMd5Hex(str) {
    function safe_add(x, y) {
      var lsw = (x & 0xFFFF) + (y & 0xFFFF);
      var msw = (x >> 16) + (y >> 16) + (lsw >> 16);
      return (msw << 16) | (lsw & 0xFFFF);
    }
    function bit_rol(num, cnt) { return (num << cnt) | (num >>> (32 - cnt)); }
    function cmn(q, a, b, x, s, t) { return safe_add(bit_rol(safe_add(safe_add(a, q), safe_add(x, t)), s), b); }
    function ff(a,b,c,d,x,s,t){ return cmn((b & c) | (~b & d), a, b, x, s, t); }
    function gg(a,b,c,d,x,s,t){ return cmn((b & d) | (c & ~d), a, b, x, s, t); }
    function hh(a,b,c,d,x,s,t){ return cmn(b ^ c ^ d, a, b, x, s, t); }
    function ii(a,b,c,d,x,s,t){ return cmn(c ^ (b | ~d), a, b, x, s, t); }
    function cycle(x, k) {
      var a = x[0], b = x[1], c = x[2], d = x[3];
      a = ff(a, b, c, d, k[0], 7, -680876936);  d = ff(d, a, b, c, k[1], 12, -389564586);  c = ff(c, d, a, b, k[2], 17, 606105819);   b = ff(b, c, d, a, k[3], 22, -1044525330);
      a = ff(a, b, c, d, k[4], 7, -176418897);  d = ff(d, a, b, c, k[5], 12, 1200080426);  c = ff(c, d, a, b, k[6], 17, -1473231341);  b = ff(b, c, d, a, k[7], 22, -45705983);
      a = ff(a, b, c, d, k[8], 7, 1770035416);  d = ff(d, a, b, c, k[9], 12, -1958414417); c = ff(c, d, a, b, k[10], 17, -42063);       b = ff(b, c, d, a, k[11], 22, -1990404162);
      a = ff(a, b, c, d, k[12], 7, 1804603682); d = ff(d, a, b, c, k[13], 12, -40341101);   c = ff(c, d, a, b, k[14], 17, -1502002290); b = ff(b, c, d, a, k[15], 22, 1236535329);
      a = gg(a, b, c, d, k[1], 5, -165796510);  d = gg(d, a, b, c, k[6], 9, -1069501632);  c = gg(c, d, a, b, k[11], 14, 643717713);   b = gg(b, c, d, a, k[0], 20, -373897302);
      a = gg(a, b, c, d, k[5], 5, -701558691);  d = gg(d, a, b, c, k[10], 9, 38016083);     c = gg(c, d, a, b, k[15], 14, -660478335);  b = gg(b, c, d, a, k[4], 20, -405537848);
      a = gg(a, b, c, d, k[9], 5, 568446438);   d = gg(d, a, b, c, k[14], 9, -1019803690);  c = gg(c, d, a, b, k[3], 14, -187363961);   b = gg(b, c, d, a, k[8], 20, 1163531501);
      a = gg(a, b, c, d, k[13], 5, -1444681467);d = gg(d, a, b, c, k[2], 9, -51403784);     c = gg(c, d, a, b, k[7], 14, 1735328473);   b = gg(b, c, d, a, k[12], 20, -1926607734);
      a = hh(a, b, c, d, k[5], 4, -378558);     d = hh(d, a, b, c, k[8], 11, -2022574463);  c = hh(c, d, a, b, k[11], 16, 1839030562);  b = hh(b, c, d, a, k[14], 23, -35309556);
      a = hh(a, b, c, d, k[1], 4, -1530992060); d = hh(d, a, b, c, k[4], 11, 1272893353);   c = hh(c, d, a, b, k[7], 16, -155497632);   b = hh(b, c, d, a, k[10], 23, -1094730640);
      a = hh(a, b, c, d, k[13], 4, 681279174);  d = hh(d, a, b, c, k[0], 11, -358537222);   c = hh(c, d, a, b, k[3], 16, -722521979);   b = hh(b, c, d, a, k[6], 23, 76029189);
      a = hh(a, b, c, d, k[9], 4, -640364487);  d = hh(d, a, b, c, k[12], 11, -421815835);  c = hh(c, d, a, b, k[15], 16, 530742520);   b = hh(b, c, d, a, k[2], 23, -995338651);
      a = ii(a, b, c, d, k[0], 6, -198630844);  d = ii(d, a, b, c, k[7], 10, 1126891415);   c = ii(c, d, a, b, k[14], 15, -1416354905); b = ii(b, c, d, a, k[5], 21, -57434055);
      a = ii(a, b, c, d, k[12], 6, 1700485571); d = ii(d, a, b, c, k[3], 10, -1894986606);  c = ii(c, d, a, b, k[10], 15, -1051523);    b = ii(b, c, d, a, k[1], 21, -2054922799);
      a = ii(a, b, c, d, k[8], 6, 1873313359);  d = ii(d, a, b, c, k[15], 10, -30611744);   c = ii(c, d, a, b, k[6], 15, -1560198380);  b = ii(b, c, d, a, k[13], 21, 1309151649);
      a = ii(a, b, c, d, k[4], 6, -145523070);  d = ii(d, a, b, c, k[11], 10, -1120210379); c = ii(c, d, a, b, k[2], 15, 718787259);    b = ii(b, c, d, a, k[9], 21, -343485551);
      x[0] = safe_add(a, x[0]); x[1] = safe_add(b, x[1]); x[2] = safe_add(c, x[2]); x[3] = safe_add(d, x[3]);
      return x;
    }
    function blk(s) {
      var b = [], i;
      for (i = 0; i < 64; i += 4) {
        b[i >> 2] = s.charCodeAt(i) + (s.charCodeAt(i+1) << 8) + (s.charCodeAt(i+2) << 16) + (s.charCodeAt(i+3) << 24);
      }
      return b;
    }
    function utf8(string) {
      string = string.replace(/\r\n/g, "\n");
      var utftext = "", n, c;
      for (n = 0; n < string.length; n++) {
        c = string.charCodeAt(n);
        if (c < 128) utftext += String.fromCharCode(c);
        else if (c > 127 && c < 2048) utftext += String.fromCharCode((c >> 6) | 192, (c & 63) | 128);
        else utftext += String.fromCharCode((c >> 12) | 224, ((c >> 6) & 63) | 128, (c & 63) | 128);
      }
      return utftext;
    }
    function rhex(n) {
      var h = "0123456789abcdef".split(""), o = "", j;
      for (j = 0; j < 4; j++) o += h[(n >> (j*8+4)) & 0xF] + h[(n >> (j*8)) & 0xF];
      return o;
    }
    function hex(x) { var s = "", i; for (i = 0; i < x.length; i++) s += rhex(x[i]); return s; }
    var n = utf8(str).length, state = [1732584193, -271733879, -1732584194, 271733878], i;
    var sb = utf8(str);
    for (i = 64; i <= sb.length; i += 64) state = cycle(state, blk(sb.substring(i - 64, i)));
    sb = sb.substring(i - 64);
    var tail = [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0];
    var length = sb.length;
    for (i = 0; i < length; i++) tail[i >> 2] |= sb.charCodeAt(i) << ((i % 4) << 3);
    tail[i >> 2] |= 0x80 << ((i % 4) << 3);
    if (i > 55) { state = cycle(state, tail); for (i = 0; i < 16; i++) tail[i] = 0; }
    tail[14] = n * 8;
    state = cycle(state, tail);
    return hex(state);
  }

  // wbi 混排表（B 站官方固定）
  var BILI_WBI_TAB = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
  var _wbiMixinKey = null, _wbiExpiry = 0;

  function bilibiliGetMixinKey() {
    // 缓存 10 分钟，避免每次请求都打 nav
    if (_wbiMixinKey && Date.now() < _wbiExpiry) return Promise.resolve(_wbiMixinKey);
    return fetch("https://api.bilibili.com/x/web-interface/nav", { credentials: "include", referrer: location.href })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j.data || !j.data.wbi_img) throw new Error("nav 无 wbi_img (code=" + j.code + ")");
        var img = (j.data.wbi_img.img_url || "").split("/").pop().split(".")[0];
        var sub = (j.data.wbi_img.sub_url || "").split("/").pop().split(".")[0];
        var orig = img + sub, mixin = [];
        for (var i = 0; i < 64; i++) mixin.push(orig[BILI_WBI_TAB[i]]);
        _wbiMixinKey = mixin.slice(0, 32).join("");
        _wbiExpiry = Date.now() + 10 * 60 * 1000;
        return _wbiMixinKey;
      });
  }

  // 给参数字典加 w_rid + wts（失败则原样返回，退回无签名请求）
  function bilibiliSignParams(params) {
    return bilibiliGetMixinKey().then(function (mixinKey) {
      var p = {}, k;
      for (k in params) {
        // wbi 签名要求过滤值中的特殊字符（与 yt-dlp / B 站官方一致）
        p[k] = String(params[k]).replace(/[!'()*]/g, "");
      }
      p.wts = Math.floor(Date.now() / 1000);
      var keys = Object.keys(p).sort();
      var query = keys.map(function (k) { return encodeURIComponent(k) + "=" + encodeURIComponent(p[k]); }).join("&");
      p.w_rid = bilibiliMd5Hex(query + mixinKey);
      return p;
    }).catch(function (e) {
      console.warn("[vdm] bilibili wbi 签名失败，改用无签名请求：", e && e.message);
      return params;
    });
  }

  async function bilibiliFetchPlayurl(meta) {
    var base = meta.isBangumi
      ? "https://api.bilibili.com/pgc/player/web/v2/playurl"
      : "https://api.bilibili.com/x/player/playurl";
    // 参数严格对齐 yt-dlp：只传必要字段，多传 type/otype/platform/fnver/fourk 等
    // 会触发 B 站返回「业务信息包裹」(video_info/view_info/...) 而非 dash。
    var params;
    if (meta.isBangumi) {
      params = { ep_id: meta.epId || "", fnval: 12240 };
    } else {
      params = { cid: meta.cid || "", fnval: 4048 };
      if (meta.bvid) params.bvid = meta.bvid;
      else params.avid = meta.aid;
    }
    // 加 wbi 签名（番剧接口强制要求，普通视频加上也无害）
    params = await bilibiliSignParams(params);
    var qs = Object.keys(params).map(function (k) { return encodeURIComponent(k) + "=" + encodeURIComponent(params[k]); }).join("&");
    var url = base + "?" + qs;
    var r = await fetch(url, { credentials: "include", referrer: location.href });
    if (!r.ok) throw new Error("playurl HTTP " + r.status);
    var j = await r.json();
    if (j.code !== 0) throw new Error("playurl 业务错误 code=" + j.code + ": " + (j.message || ""));
    // 返回整包信封，便于上层诊断（j.code / j.message / j.data）
    return j;
  }

  // 普通视频兜底：cid 缺失时通过 web-interface/view 拿完整元数据（含 cid + bvid + 多分页）
  async function bilibiliFetchView(bvid, aid) {
    var url = "https://api.bilibili.com/x/web-interface/view"
      + (bvid ? "?bvid=" + encodeURIComponent(bvid) : "?aid=" + encodeURIComponent(aid));
    var r = await fetch(url, { credentials: "include", referrer: location.href });
    if (!r.ok) throw new Error("web-interface/view HTTP " + r.status);
    var j = await r.json();
    if (j.code !== 0) throw new Error("view 业务错误 code=" + j.code + ": " + (j.message || ""));
    return j.data || {};
  }

  // 番剧/电影兜底：cid 缺失时通过 pgc/view/web/season 找当前集 cid
  // 关键：电影页 URL 往往只带 ep_id 不带 ss，必须用 ep_id 查（与 yt-dlp bilibili.py:1044 一致）；
  // 否则 season_id 为空会返回 -404「啥都木有」。ssId 仅在仅有 ss 页时作兜底。
  async function bilibiliFetchSeason(ssId, epId) {
    var url;
    if (epId) {
      url = "https://api.bilibili.com/pgc/view/web/season?ep_id=" + encodeURIComponent(epId);
    } else if (ssId) {
      url = "https://api.bilibili.com/pgc/view/web/season?season_id=" + encodeURIComponent(ssId);
    } else {
      throw new Error("season 查询缺少 ep_id 与 season_id");
    }
    var r = await fetch(url, { credentials: "include", referrer: location.href });
    if (!r.ok) throw new Error("season HTTP " + r.status);
    var j = await r.json();
    if (j.code !== 0) throw new Error("season 业务错误 code=" + j.code + ": " + (j.message || ""));
    var res = j.result || {};
    // 电影/番剧 season 返回结构不一：episodes / main_section.episodes / epList 都兜底
    var episodes = res.episodes || (res.main_section && res.main_section.episodes) || res.epList || [];
    for (var i = 0; i < episodes.length; i++) {
      if (String(episodes[i].id) === String(epId)) {
        return {
          epId: String(episodes[i].id),
          cid: String(episodes[i].cid),
          aid: String(episodes[i].aid || ""),
          bvid: episodes[i].bvid || ""
        };
      }
    }
    // 没指定 ep 时取第一集
    if (episodes.length && !epId) {
      return {
        epId: String(episodes[0].id),
        cid: String(episodes[0].cid),
        aid: String(episodes[0].aid || ""),
        bvid: episodes[0].bvid || ""
      };
    }
    throw new Error("season 中未找到对应集的 cid");
  }

  async function bilibiliProbe() {
    if (!/\/video\/|\/bangumi\/play\//.test(location.pathname)) return;

    var meta = bilibiliGetVideoMeta();
    if (!meta) return;

    // cid 缺失兜底：普通视频走 web-interface/view；番剧走 pgc/view/web/season
    if (!meta.cid) {
      try {
        if (meta.isBangumi) {
          var s = await bilibiliFetchSeason(meta.ssId, meta.epId);
          if (s && s.cid) {
            meta.cid = s.cid;
            meta.bvid = meta.bvid || s.bvid;
            meta.aid = meta.aid || s.aid;
            if (s.epId) meta.epId = s.epId; // 纯 ss 页：补回第一集 ep_id
          }
        } else if (meta.bvid || meta.aid) {
          var view = await bilibiliFetchView(meta.bvid, meta.aid);
          if (view && view.cid) {
            meta.cid = String(view.cid);
            meta.bvid = meta.bvid || view.bvid;
            meta.aid = meta.aid || String(view.aid);
            if (view.pages && view.pages.length) {
              meta.cid = String(view.pages[0].cid || meta.cid);
            }
          }
        }
      } catch (e) {
        console.warn("[vdm] bilibili 兜底获取 cid 失败：", e && e.message);
      }
    }

    // 番剧 playurl 需要 ep_id；普通视频需要 cid。二者都没则放弃。
    if (meta.isBangumi && !meta.epId) {
      console.warn("[vdm] bilibili 番剧缺 ep_id，跳过 playurl");
      return;
    }
    if (!meta.isBangumi && !meta.cid) {
      console.warn("[vdm] bilibili 仍缺 cid，跳过 playurl");
      return;
    }

    try {
      var j = await bilibiliFetchPlayurl(meta);
      var env = j.data || j.result || j; // yt-dlp 先降一层 data
      // 番剧 v2 把 dash/durl 包在 env.video_info（或 env.result.video_info）里；
      // 普通视频则直接在 env 顶层。统一取出承载媒体流的容器 pd。
      var pd = env.video_info || (env.result && env.result.video_info) || env;
      // 权限诊断：play_check.play_detail = PLAY_WHOLE 表示账号有完整播放权；
      // 其他值（如 PLAY_VIP / 试看标志）说明当前拿的是预览/低清流（会员限制）。
      var playDetail = (env.play_check && env.play_check.play_detail) ||
                       (pd && pd.play_check && pd.play_check.play_detail) || "";
      var limited = playDetail && playDetail !== "PLAY_WHOLE";
      var permNote = limited ? "｜当前账号无完整权限（play_detail=" + playDetail + "），下载的是预览/低清流，需大会员账号登录后重试" : "";
      var dash = pd && pd.dash;
      if (!dash || !dash.video || !dash.video.length) {
        // 旧的 durl 模式（FLV）也兜底
        if (pd && pd.durl && pd.durl.length) {
          bilibiliAdapter = {
            playurl: { durl: pd.durl, accept_quality: pd.accept_quality },
            label: "B 站 durl（FLV 合并格式）" + (limited ? "｜受限：" + playDetail + "，可能仅为预览片段" : "")
          };
          notify();
        } else {
          var keys = env ? Object.keys(env) : null;
          var snippet = env ? JSON.stringify(env).slice(0, 400) : null;
          console.warn("[vdm] bilibili playurl 无 dash/durl：",
            "code=", j.code, "message=", j.message,
            "play_detail=", playDetail,
            "dataKeys=", keys,
            "dataSnippet=", snippet,
            "｜若提示登录/大会员，请在当前浏览器登录 bilibili.com 后刷新重试");
        }
        return;
      }
      // 清晰度诊断：非会员看会员内容时 dash 只会给低清（通常 ≤480p）
      var maxH = 0;
      for (var vi = 0; vi < dash.video.length; vi++) {
        if (dash.video[vi].height > maxH) maxH = dash.video[vi].height;
      }
      if (limited || maxH <= 480) {
        permNote = "｜最高 " + maxH + "p" + (limited ? "（play_detail=" + playDetail + "，需大会员解锁高清晰度）" : "（非会员清晰度上限）");
      }
      bilibiliAdapter = {
        playurl: {
          dash: dash,
          accept_quality: pd.accept_quality || []
        },
        label: (meta.isBangumi ? "B 站番剧 DASH（最优画质 + 音轨合并）" : "B 站 DASH（最优画质 + 音轨合并）") + permNote
      };
      notify();
    } catch (e) {
      console.warn("[vdm] bilibili adapter failed:", e && e.message);
    }
  }

  // 仅在 B 站页触发
  if (/bilibili\.com/.test(location.hostname) && /\/video\/|\/bangumi\/play\//.test(location.pathname)) {
    bilibiliProbe();
  }

  var seq = 0;
  function notify() {
    try {
      window.postMessage({ __vdm_media__: list(), __vdm_seq__: ++seq }, "*");
    } catch (e) {}
  }

  window.addEventListener("message", function (e) {
    var d = e.data;
    if (!d) return;
    if (d.__vdm_req__) {
      scanElements();
      scanTiming();
      notify();
    }
    if (d.__vdm_durl_req__) {
      // popup → content → main：B 站 durl 在 page origin 下并发下载并拼接
      downloadDurl(d.durls, d.__vdm_id__)
        .then(function (ab) {
          // transferable ArrayBuffer 零拷贝传给 content.js
          window.postMessage({
            __vdm_durl_done__: true,
            __vdm_id__: d.__vdm_id__,
            buffer: ab
          }, "*", [ab]);
        })
        .catch(function (err) {
          window.postMessage({
            __vdm_durl_done__: true,
            __vdm_id__: d.__vdm_id__,
            error: String((err && err.message) || err)
          }, "*");
        });
    }
    if (d.__vdm_bili_dash_track_req__) {
      // popup → content → main：B 站 dash 视频/音轨逐段下载，逐片 transferable 回传
      // 原因：bilivideo CDN 不响应非 bilibili.com 来源的请求，
      //       popup.js 直接 fetch → 403；必须走 page origin（带 SESSDATA + referrer）
      // noCreds: 腾讯等 CDN 返回 ACAO:*，带凭据的跨域 fetch 会被 CORS 拦截 → 需 omit（与播放器一致）
      var jobId = d.__vdm_id__;
      downloadDashTrack(d.initSpec || null, d.segments || [], jobId, !!d.noCreds, !!d.rangeChain)
        .then(function (tally) {
          // tally：{ok, fail, total}——部分成功时让上层知道真实片数，避免静默产出残片
          window.postMessage({
            __vdm_bili_dash_track_done__: true, __vdm_id__: jobId, ok: true, tally: tally || null
          }, "*");
        })
        .catch(function (err) {
          window.postMessage({
            __vdm_bili_dash_track_done__: true,
            __vdm_id__: jobId,
            ok: false,
            error: String((err && err.message) || err)
          }, "*");
        });
    }
    if (d.__vdm_iq_tvid_req__) {
      // 爱奇艺：取当前视频的 tvid（新链路用它去换片源直链）
      iqiyiGetTvid()
        .then(function (tvid) {
          window.postMessage({ __vdm_iq_tvid_res__: true, __vdm_id__: d.__vdm_id__, tvid: tvid }, "*");
        })
        .catch(function (err) {
          window.postMessage({
            __vdm_iq_tvid_res__: true, __vdm_id__: d.__vdm_id__,
            error: String((err && err.message) || err)
          }, "*");
        });
    }
  });

  // 爱奇艺：取当前视频的 tvid（新链路用它去换片源直链）
  // 提取顺序：① 播放器注入全局变量 → ② DOM 属性 → ③ 页面 HTML 正则
  //          → ④ 拉加速器脚本（带 AbortController 超时，避免扩展 origin 被服务器挂起导致永久卡死）
  // 注意：绝不依赖「不返回也不报错」的网络请求——任何一步都必须能在超时内产出结果或抛错。
  var ACC_URL = "https://mesh.if.iqiyi.com/player/lw/lwplay/accelerator.js?apiVer=3";
  async function iqiyiGetTvid() {
    function fromText(t) {
      if (!t) return null;
      var m = /["']?tvi[dD]["']?\s*[:=]\s*["']?(\d{6,})/.exec(t);
      return m ? m[1] : null;
    }
    // 在对象里找 tvid / tvId（支持常见嵌套路径 + 受限广搜，避免大对象卡死）
    function deepTvid(obj) {
      if (!obj || typeof obj !== "object") return null;
      var paths = [
        ["tvid"], ["tvId"], ["video", "tvid"], ["video", "tvId"],
        ["currentVideoInfo", "tvid"], ["currentVideoInfo", "tvId"],
        ["playInfo", "tvid"], ["album", "tvId"], ["data", "tvid"]
      ];
      for (var i = 0; i < paths.length; i++) {
        var cur = obj, ok = true;
        for (var j = 0; j < paths[i].length; j++) {
          if (cur == null) { ok = false; break; }
          cur = cur[paths[i][j]];
        }
        if (ok && cur && /^\d{6,}$/.test(String(cur))) return String(cur);
      }
      var stack = [obj], seen = 0;
      while (stack.length && seen < 3000) {
        var node = stack.pop(); seen++;
        if (node && typeof node === "object") {
          for (var k in node) {
            if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
            var v = node[k];
            if (k === "tvid" || k === "tvId") {
              if (v && /^\d{6,}$/.test(String(v))) return String(v);
            } else if (v && typeof v === "object" && seen < 3000) {
              stack.push(v);
            }
          }
        }
      }
      return null;
    }
    // ① 播放器注入的全局变量
    try {
      var t = deepTvid(window.QiyiPlayerProphetData);
      if (t) return t;
    } catch (e) {}
    try {
      var t2 = deepTvid(window.__INITIAL_STATE__);
      if (t2) return t2;
    } catch (e) {}
    try {
      var pi = window.playerInstance;
      if (pi) {
        var pt = pi.tvid || (pi.video && (pi.video.tvid || pi.video.tvId));
        if (pt && /^\d{6,}$/.test(String(pt))) return String(pt);
      }
    } catch (e) {}
    // ② DOM 属性
    try {
      var el = document.querySelector("[data-player-tvid],[data-shareplattrigger-tvid]");
      if (el) {
        var dv = el.getAttribute("data-player-tvid") || el.getAttribute("data-shareplattrigger-tvid");
        if (dv && /^\d+$/.test(dv)) return dv;
      }
    } catch (e) {}
    // ③ 页面 HTML 正则
    try {
      var html = document.documentElement.innerHTML || "";
      var hit = fromText(html);
      if (hit) return hit;
    } catch (e) {}
    // ④ 拉加速器脚本（带超时；不用 credentials，避免触发带凭据的 CORS 预检把连接挂死）
    try {
      var ctrl = ("AbortController" in window) ? new AbortController() : null;
      var to = ctrl ? setTimeout(function () { ctrl.abort(); }, 12000) : null;
      var r = await fetch(ACC_URL, {
        credentials: "omit",
        referrer: location.href,
        referrerPolicy: "unsafe-url",
        signal: ctrl ? ctrl.signal : undefined
      });
      if (to) clearTimeout(to);
      if (r.ok) {
        var txt = await r.text();
        var m2 = /"tvid":\s*(\d+)/.exec(txt);
        if (m2) return m2[1];
        var m3 = /tvid\s*[:=]\s*(\d{6,})/.exec(txt);
        if (m3) return m3[1];
      }
    } catch (e) {}
    throw new Error("未能获取 tvid（请刷新页面后重试）");
  }

  // 并发下载 durl 段 + 拼接（保留第一段、跳过后续段 13 字节 FLV header）
  async function downloadDurl(durls, jobId) {
    if (!durls || !durls.length) throw new Error("durls 为空");
    var segs = [];
    var fetched = 0;
    for (var i = 0; i < durls.length; i++) {
      var durl = durls[i];
      // B 站会校验 referrer；fetch 默认带当前页 referrer，刚好符合要求
      var r = await fetch(durl.url, { credentials: "include", referrer: location.href });
      if (!r.ok) throw new Error("FLV 第 " + (i + 1) + " 段下载失败 HTTP " + r.status);
      var buf = await r.arrayBuffer();
      var start = i === 0 ? 0 : 13; // 第一段保留全；后续段跳过头部 13 字节
      var len = buf.byteLength - start;
      segs.push(new Uint8Array(buf, start, len));
      fetched++;
      window.postMessage({
        __vdm_durl_prog__: true, __vdm_id__: jobId,
        done: fetched, total: durls.length
      }, "*");
    }
    var total = segs.reduce(function (s, u) { return s + u.length; }, 0);
    var out = new Uint8Array(total);
    var off = 0;
    for (var k = 0; k < segs.length; k++) {
      out.set(segs[k], off);
      off += segs[k].length;
    }
    return out.buffer;
  }

  // B 站 dash 视频/音轨逐段拉取（page origin 带 SESSDATA + referrer，bilivideo CDN 才能下到）
  // initSpec: null 或 {url, range:[a,b]}（fMP4 init 段）
  // segments:  [{url, range:[a,b]}] 或 [string]（单完整文件 URL，形态②）
  // jobId: 与 content.js 的 reqId 对应
  // 流程：每片 fetch 完立刻 transferable ArrayBuffer 经 postMessage 推给 content.js，
  //       若任意一片 HTTP 非 2xx，抛错终止（content.js 收完所有已发片段后建 blob）
  async function downloadDashTrack(initSpec, segments, jobId, noCreds, rangeChain) {
    var total = (initSpec ? 1 : 0) + (segments ? segments.length : 0);
    if (!total) throw new Error("B 站 dash track 没有可下载段（init 与 segments 都为空）");
    var idx = 0; // 段序号（init 为 0，segments 从 1 起）
    function postProg(thisIdx, bytes, cl) {
      window.postMessage({
        __vdm_bili_dash_track_prog__: true, __vdm_id__: jobId,
        done: thisIdx, total: total,
        bytes: bytes, contentLength: cl
      }, "*");
    }
    // Range 链式模式：CDN 对普通请求切流（腾讯 16KB 断）时，用 Range 小步请求逐段续传。
    // 每步 64KB：读到 64KB 即 cancel 剩余（防挂起），短于 64KB = 到达文件尾。
    async function fetchOneRangeChained(url, thisIdx) {
      const STEP = 65536;
      const chunks = [];
      let got = 0, rounds = 0, lastPost = 0;
      for (;;) {
        const ctrl = ("AbortController" in window) ? new AbortController() : null;
        const timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 20000) : null;
        let gotThis = 0, doneThis = false;
        try {
          const resp = await fetch(url, {
            credentials: noCreds ? "omit" : "include",
            referrer: location.href,
            headers: { Range: "bytes=" + got + "-" + (got + STEP - 1) },
            signal: ctrl ? ctrl.signal : undefined
          });
          if (!resp.ok && resp.status !== 206) throw new Error("Range HTTP " + resp.status);
          const rd = (resp.body && resp.body.getReader) ? resp.body.getReader() : null;
          if (!rd) {
            const ab = await resp.arrayBuffer();
            if (ab.byteLength) chunks.push(new Uint8Array(ab));
            gotThis = ab.byteLength; doneThis = true;
          } else {
            for (;;) {
              const res = await rd.read();
              if (res.done) { doneThis = true; break; }
              chunks.push(res.value);
              gotThis += res.value.length; got += res.value.length;
              const now = Date.now();
              if (now - lastPost > 300) { lastPost = now; postProg(thisIdx, got, 0); }
              if (gotThis >= STEP) { try { rd.cancel(); } catch (e) {} break; }
            }
          }
        } finally { if (timer) clearTimeout(timer); }
        if (gotThis === 0) {
          if (rounds === 0) throw new Error("第 " + thisIdx + " 段 Range 下载空响应");
          break; // 服务器确认越过文件尾：正常结束
        }
        rounds++;
        if (gotThis < STEP || doneThis) break; // 短读 = 文件尾
        if (rounds > 8192) throw new Error("第 " + thisIdx + " 段 Range 轮次超限（" + Math.round(got / 1048576) + "MB）");
      }
      const sum = chunks.reduce(function (s, c) { return s + c.length; }, 0);
      const out = new Uint8Array(sum);
      let off2 = 0;
      for (let k3 = 0; k3 < chunks.length; k3++) { out.set(chunks[k3], off2); off2 += chunks[k3].length; }
      return out.buffer;
    }
    // 流式下载一段：body.getReader() 逐块读，每 300ms 报一次已收字节。
    // 必须流式——缺 IndexRange 的影片整条视频是单个巨型分片，
    // 若等 arrayBuffer() 全部缓冲完才报进度，popup 会"永久卡 0%"。
    async function fetchOneStreamed(partSpec, thisIdx) {
      if (rangeChain) return await fetchOneRangeChained(typeof partSpec === "string" ? partSpec : partSpec.url, thisIdx);
      var url = typeof partSpec === "string" ? partSpec : partSpec.url;
      var range = typeof partSpec === "string" ? null : (partSpec.range || null);
      var headers = {};
      if (range && range.length === 2) headers.Range = "bytes=" + range[0] + "-" + range[1];
      // 硬超时 15s（一片正常 1~3s 内完成；25s 太长会让失败路径卡得像死机）
      var segCtrl = ("AbortController" in window) ? new AbortController() : null;
      var segTimer = segCtrl ? setTimeout(function () { try { segCtrl.abort(); } catch (e) {} }, 15000) : null;
      var r;
      try {
        r = await fetch(url, { credentials: noCreds ? "omit" : "include", referrer: location.href, headers: headers, signal: segCtrl ? segCtrl.signal : undefined });
      } finally { if (segTimer) clearTimeout(segTimer); }
      if (!r.ok) throw new Error("第 " + thisIdx + " 段下载失败 HTTP " + r.status);
      var cl = parseInt(r.headers.get("content-length") || "0", 10) || 0;
      postProg(thisIdx, 0, cl);
      if (!r.body || !r.body.getReader) {
        var ab = await r.arrayBuffer();
        postProg(thisIdx, ab.byteLength, cl);
        return ab;
      }
      var reader = r.body.getReader();
      var chunks = [], lastPost = 0, lastBytes = 0, stallStart = Date.now();
      for (;;) {
        var res = await reader.read();
        if (res.done) break;
        chunks.push(res.value);
        var now = Date.now();
        if (now - lastPost > 300) { lastPost = now; postProg(thisIdx, (chunks.reduce(function (s, c) { return s + c.length; }, 0)), cl); }
        // 15s 字节停滞 = 死流（CDN 标记后通常给 16KB 就掐）
        var totNow = chunks.reduce(function (s, c) { return s + c.length; }, 0);
        if (totNow > lastBytes) { lastBytes = totNow; stallStart = now; }
        else if (now - stallStart > 15000) { try { reader.cancel(); } catch (e) {} throw new Error("第 " + thisIdx + " 段下载停滞 15s（已收 " + Math.round(totNow / 1024) + "KB）"); }
      }
      var sum = chunks.reduce(function (s, c) { return s + c.length; }, 0);
      var out = new Uint8Array(sum), off = 0;
      for (var k = 0; k < chunks.length; k++) { out.set(chunks[k], off); off += chunks[k].length; }
      return out.buffer;
    }
    function postPart(buf, thisIdx) {
      // transferable：第三个参数指定要转移（而非复制）的对象；之后 buf 在本侧为 detached
      window.postMessage({
        __vdm_bili_dash_track_part__: true,
        __vdm_id__: jobId,
        index: thisIdx,
        total: total,
        buffer: buf
      }, "*", [buf]);
    }
    if (initSpec) {
      var buf0 = await fetchOneStreamed(initSpec, idx);
      postPart(buf0, idx++);
    }
    // 逐片下载：带重试 + 片间节流。腾讯 CDN 对「短时密集的同目录请求」会限流，
    // 表现为后续分片全部返回 200 + 空 body（不是超时，是立刻空）→ 拼出残片。
    // 快速失败策略：单片最多 2 次尝试、单次 ≤15s（之前 25s × 3 次重试 = 一片卡 75s+，
    // 用户看起来像死机）；连续 3 片失败即收尾——CDN 决定拒绝后重试再多也没用。
    var MIN_SEG_BYTES = 1024;
    var _failTally = { ok: 0, fail: 0 };
    var _consecFail = 0;
    var _failSamples = [];
    for (var i = 0; i < segments.length; i++) {
      var bufi = null, lastErr = null;
      for (var attempt = 0; attempt < 2 && !bufi; attempt++) {
        if (attempt > 0) await new Promise(function (rs) { setTimeout(rs, 350); });
        try {
          var cand = await fetchOneStreamed(segments[i], idx);
          if (cand && cand.byteLength >= MIN_SEG_BYTES) { bufi = cand; break; }
          lastErr = "响应过小（" + (cand ? cand.byteLength : 0) + "B）";
        } catch (eOne) { lastErr = String((eOne && eOne.message) || eOne); }
      }
      if (!bufi) {
        _failTally.fail++;
        _consecFail++;
        if (_failSamples.length < 3) _failSamples.push("#" + (idx + 1) + " " + lastErr);
        if (_consecFail >= 3) {
          _failTally.stoppedAt = idx + 1;
          _failTally.samples = _failSamples;
          break;
        }
        continue;
      }
      _failTally.ok++;
      _consecFail = 0;
      postPart(bufi, idx++);
      postProg(idx, bufi.byteLength, 0);
      await new Promise(function (rs) { setTimeout(rs, 60); }); // 节流，降低被限流概率
    }
    _failTally.total = total;
    return _failTally;
  }

  // 初始广播一次（content 注入晚于本脚本时也能拿到）
  setTimeout(notify, 300);
})();
