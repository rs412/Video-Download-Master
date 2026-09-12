// dash.js — DASH (MPD) 清单解析与分段下载
// 支持常见的两种分段描述方式：
//   1) SegmentTemplate（$Number$ / $Time$ / initialization 模板）
//   2) SegmentList（SegmentURL 列表）
// 输出：选定 Representation 的分片 URL 数组 → 并发下载 → init + 分片顺序拼接为 fMP4 Blob。
// 说明：拼接得到的是 fragmented MP4，主流播放器可直接播放；
//      若浏览器/播放器不认，再经 YTMerge（mediabunny）规范化为普通 mp4。
(function (global) {
  function abs(base, u) {
    try { return new URL(u, base).href; } catch (e) { return u; }
  }

  function textOf(node, tag) {
    if (!node) return null;
    var el = node.getElementsByTagName(tag)[0];
    return el ? el.textContent : null;
  }

  // 解析 MPD 文本 → { period, reps: [{id, mime, codecs, width, height, bandwidth, init, segments:[url]}] }
  function parse(mpdText, mpdUrl) {
    var doc = new DOMParser().parseFromString(mpdText, "application/xml");
    if (!doc || doc.getElementsByTagName("parsererror").length) {
      throw new Error("MPD 解析失败（不是合法 XML）");
    }
    var reps = [];
    var period = doc.getElementsByTagName("Period")[0] || doc;
    var duration = null;
    var durAttr = period.getAttribute && period.getAttribute("duration");
    if (durAttr) duration = parseDuration(durAttr);

    var adapt = period.getElementsByTagName("AdaptationSet");
    for (var a = 0; a < adapt.length; a++) {
      var as = adapt[a];
      var mime = as.getAttribute("mimeType") || as.getAttribute("contentType") || "";
      var baseMime = mime;
      var repsNodes = as.getElementsByTagName("Representation");
      for (var r = 0; r < repsNodes.length; r++) {
        var rn = repsNodes[r];
        var item = {
          id: rn.getAttribute("id") || "",
          mime: baseMime || (rn.getAttribute("mimeType") || ""),
          codecs: rn.getAttribute("codecs") || "",
          bandwidth: parseInt(rn.getAttribute("bandwidth"), 10) || 0,
          width: parseInt(rn.getAttribute("width"), 10) || 0,
          height: parseInt(rn.getAttribute("height"), 10) || 0,
          audioRate: parseInt(rn.getAttribute("audioSamplingRate"), 10) || 0,
          init: null,
          segments: []
        };

        var segTpl = rn.getElementsByTagName("SegmentTemplate")[0] ||
                     as.getElementsByTagName("SegmentTemplate")[0] || null;
        var segList = rn.getElementsByTagName("SegmentList")[0] ||
                      as.getElementsByTagName("SegmentList")[0] || null;
        var baseUrl = textOf(rn, "BaseURL") || textOf(as, "BaseURL") || "";

        if (segTpl) {
          var media = segTpl.getAttribute("media");
          var initAttr = segTpl.getAttribute("initialization");
          var start = parseInt(segTpl.getAttribute("startNumber"), 10);
          if (isNaN(start)) start = 1;
          var timescale = parseInt(segTpl.getAttribute("timescale"), 10) || 1;
          var segDur = parseInt(segTpl.getAttribute("duration"), 10) || 0;
          var base = abs(mpdUrl, baseUrl);
          if (initAttr) item.init = abs(mpdUrl, initAttr.replace(/\$RepresentationID\$/g, item.id).replace(/\$Bandwidth\$/g, item.bandwidth));

          var segTimeline = segTpl.getElementsByTagName("SegmentTimeline")[0];
          if (segTimeline) {
            // $Time$ 模式：按 S 元素展开时间轴
            var t = start, cur = 0;
            var Ss = segTimeline.getElementsByTagName("S");
            for (var s = 0; s < Ss.length; s++) {
              var S = Ss[s];
              var st = parseInt(S.getAttribute("t"), 10);
              var d = parseInt(S.getAttribute("d"), 10);
              var cnt = parseInt(S.getAttribute("r"), 10);
              if (!isNaN(st)) cur = st;
              if (isNaN(cnt) || cnt < 0) cnt = 0;
              for (var k = 0; k <= cnt; k++) {
                item.segments.push(expand(media, item, cur));
                cur += d;
              }
            }
          } else if (duration && segDur) {
            // $Number$ 模式：按时长推算段数
            var total = Math.ceil((duration * timescale) / segDur);
            for (var i = 0; i < total; i++) {
              item.segments.push(expand(media, item, start + i, i));
            }
          } else {
            // 段数未知：给一个保守上限，下载时遇到 404 即停
            for (var n = 0; n < 8000; n++) {
              item.segments.push(expand(media, item, start + n, n));
            }
          }
          if (baseUrl && !media) {
            item.segments = [abs(mpdUrl, baseUrl)];
          }
        } else if (segList) {
          var urls = segList.getElementsByTagName("SegmentURL");
          var listBase = abs(mpdUrl, textOf(segList, "BaseURL") || baseUrl || mpdUrl);
          for (var u = 0; u < urls.length; u++) {
            item.segments.push(abs(listBase, urls[u].getAttribute("media") || ""));
          }
          var initEl = segList.getElementsByTagName("Initialization")[0];
          if (initEl) {
            item.init = abs(listBase, initEl.getAttribute("sourceURL") || textOf(segList, "BaseURL") || "");
          }
        } else if (baseUrl) {
          item.segments = [abs(mpdUrl, baseUrl)];
        }
        reps.push(item);
      }
    }
    return { duration: duration, reps: reps };
  }

  // 从一段 MPD 文本里把「所有 init + segment URL」的 hostname 抽出来。
  // MPD 里 BaseURL/SegmentTemplate 指向的 host 经常和 MPD 自身 host 不同
  // （爱奇艺 MPD 在 meta-cdn.video.iqiyi.com，分片却在 data.video.iqiyi.com），
  // 派 Referer 伪装规则时必须把两者都覆盖。
  function extractHostsFromMpdText(mpdText, mpdUrl) {
    const doc = new DOMParser().parseFromString(mpdText, "application/xml");
    if (!doc || doc.getElementsByTagName("parsererror").length) return [];
    const hosts = new Set();
    const addUrl = (u) => {
      if (!u) return;
      try {
        const h = new URL(u, mpdUrl).hostname;
        if (h) hosts.add(h);
      } catch (e) {}
    };
    doc.querySelectorAll && doc.querySelectorAll("BaseURL").forEach((n) => addUrl(n.textContent));
    const segTpls = doc.querySelectorAll ? doc.querySelectorAll("SegmentTemplate") : [];
    segTpls.forEach((t) => {
      addUrl(t.getAttribute("media"));
      addUrl(t.getAttribute("initialization"));
    });
    const segLists = doc.querySelectorAll ? doc.querySelectorAll("SegmentURL") : [];
    segLists.forEach((u) => addUrl(u.getAttribute("media")));
    return Array.from(hosts);
  }

  function expand(media, item, numberOrTime, index) {
    return media
      .replace(/\$RepresentationID\$/g, item.id)
      .replace(/\$Number\$/g, numberOrTime)
      .replace(/\$Bandwidth\$/g, item.bandwidth)
      .replace(/\$\$|\$Number%0\d+d\$/g, numberOrTime);
  }

  function parseDuration(s) {
    var m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(s || "");
    if (!m) return null;
    return (
      (parseInt(m[1] || 0, 10) * 86400) +
      (parseInt(m[2] || 0, 10) * 3600) +
      (parseInt(m[3] || 0, 10) * 60) +
      parseFloat(m[4] || 0)
    );
  }

  function isVideo(r) { return /video/.test(r.mime) || r.height > 0; }
  function isAudio(r) { return /audio/.test(r.mime) || (!r.height && /mp4a|opus|aac|ac-3|ec-3/i.test(r.codecs)); }

  // 解析 sidx box（MP4 标准的 Segment Index Box）
  // 给出每个分片的 offset（相对文件）和 size。配合 baseUrl 即可用 Range 请求下载每个分片。
  function parseSidx(buf) {
    var v = new DataView(buf);
    var size = v.getUint32(0), type = "";
    type = String.fromCharCode(v.getUint8(4)) + String.fromCharCode(v.getUint8(5)) +
           String.fromCharCode(v.getUint8(6)) + String.fromCharCode(v.getUint8(7));
    if (type !== "sidx") return [];
    var p = 8, version = v.getUint8(p); p += 4; // version + flags
    p += 4; // reference_ID
    var timescale = v.getUint32(p); p += 4;
    var ep, firstOffset;
    if (version === 0) { ep = v.getUint32(p); p += 4; firstOffset = v.getUint32(p); p += 4; }
    else { ep = v.getUint64(p); p += 8; firstOffset = v.getUint64(p); p += 8; }
    p += 2; // reserved
    var n = v.getUint16(p); p += 2;
    var entries = [], curOffset = firstOffset;
    for (var i = 0; i < n; i++) {
      var typeSize = v.getUint32(p); p += 4;
      var segSize = typeSize & 0x7FFFFFFF;
      var dur = v.getUint32(p); p += 4;
      p += 2; // SAP
      entries.push({ offset: curOffset, size: segSize, duration: dur / timescale });
      curOffset += segSize;
    }
    return entries;
  }

  // 下载 sidx 并解析：返回 [{start, end}] 数组
  async function fetchSidxRanges(baseUrl, initRange, indexRange) {
    var r = await fetch(baseUrl, { headers: { Range: "bytes=" + indexRange[0] + "-" + indexRange[1] } });
    if (!r.ok) throw new Error("sidx 下载失败 HTTP " + r.status);
    var buf = await r.arrayBuffer();
    var entries = parseSidx(buf);
    if (!entries.length) throw new Error("sidx box 解析失败");
    // first media segment starts after IndexRange end + init range offset
    var firstMedia = indexRange[1] + 1;
    var ranges = entries.map(function (e) {
      return { start: firstMedia + e.offset, end: firstMedia + e.offset + e.size - 1 };
    });
    return { init: initRange, ranges: ranges, duration: entries.reduce(function (s, e) { return s + e.duration; }, 0) };
  }

  // 从 B 站 playurl 响应里挑一个视频+音轨表示，返回 dash.js 兼容的 rep 结构
  // segments 数组里每项是 {url, range:[a,b]} 对象，downloadSegments 会识别并用 Range 请求
  // 兼容两种 B 站 DASH 形态：
  //   ① 含 SegmentBase.IndexRange → 字节区间分段（一文件多分片），downloadSegments 用 Range 请求拉 sidx
  //   ② 缺 SegmentBase.IndexRange → baseUrl 本身就是完整 m4s 文件，单 URL 直下
  async function fromBilibili(playurl, opts) {
    var dash = playurl && playurl.dash;
    if (!dash || !dash.video || !dash.video.length) throw new Error("B 站响应无 dash 字段");
    var qn = (opts && opts.qn) || 80;

    var v = dash.video
      .filter(function (x) { return !qn || (x.id || 0) <= qn; })
      .sort(function (a, b) { return (b.height || 0) - (a.height || 0); })[0] || dash.video[0];
    var a = dash.audio && dash.audio.length
      ? dash.audio.slice().sort(function (x, y) { return (y.bandwidth || 0) - (x.bandwidth || 0); })[0]
      : null;

    if (!v) throw new Error("B 站 dash 视频轨道为空");

    async function buildRep(repr, kind) {
      if (!repr) return null;
      if (!repr.baseUrl) return null;
      var init = (repr.SegmentBase && parseRange(repr.SegmentBase.Initialization)) || null;
      var idx = (repr.SegmentBase && parseRange(repr.SegmentBase.IndexRange)) || null;
      var mime = repr.mimeType || (kind === "v" ? "video/mp4" : "audio/mp4");
      if (init && idx) {
        // 形态①：sidx 字节区间
        var res = await fetchSidxRanges(repr.baseUrl, init, idx);
        return {
          id: "bilibili-" + kind + "-" + (repr.id || ""),
          mime: mime,
          codecs: repr.codecs || "",
          bandwidth: repr.bandwidth || 0,
          width: repr.width || 0,
          height: repr.height || 0,
          init: { url: repr.baseUrl, range: res.init },
          segments: res.ranges.map(function (r) { return { url: repr.baseUrl, range: r }; }),
          duration: res.duration || 0,
          isBilibili: true
        };
      }
      // 形态②：单完整文件（部分番剧 / 不带 sidx 的旧 DASH 形态）
      return {
        id: "bilibili-" + kind + "-" + (repr.id || ""),
        mime: mime,
        codecs: repr.codecs || "",
        bandwidth: repr.bandwidth || 0,
        width: repr.width || 0,
        height: repr.height || 0,
        init: null,
        segments: [repr.baseUrl],
        duration: 0,
        isBilibili: true
      };
    }

    var videoRep = await buildRep(v, "v");
    if (!videoRep) throw new Error("B 站 dash 视频轨道缺 baseUrl，无法下载");
    var audioRep = a ? await buildRep(a, "a") : null;

    return { video: videoRep, audio: audioRep, duration: videoRep.duration };
  }

  function hostOf(u) {
    try { return new URL(u, (typeof location !== "undefined" ? location.href : "https://x/")).hostname; }
    catch (e) { return ""; }
  }

  function parseRange(s) {
    var m = /(\d+)-(\d+)/.exec(s || "");
    return m ? [parseInt(m[1], 10), parseInt(m[2], 10)] : null;
  }

  function pickBest(reps) {
    var v = reps.filter(isVideo).sort(function (a, b) {
      return (b.height - a.height) || (b.bandwidth - a.bandwidth);
    })[0] || null;
    var a = reps.filter(isAudio).sort(function (x, y) {
      return (x.bandwidth || 0) === 0 || (y.bandwidth || 0) === 0
        ? (x.codecs.indexOf("mp4a") >= 0 ? -1 : 1)
        : (y.bandwidth - x.bandwidth);
    })[0] || null;
    return { video: v, audio: a };
  }

  // 并发下载分片：init + 全部媒体分片 → 顺序拼接（fMP4），返回 Blob
  // segments 中每项可以是：
  //   string：直接 URL；或 { url, range:[a,b] }：对 url 发 Range 请求（用于 B 站同 baseUrl 多段）
  async function downloadSegments(rep, baseUrl, onProg) {
    var segs = rep.segments.map(function (s) {
      return typeof s === "string" ? { url: abs(baseUrl, s), range: null } : s;
    });
    var urls = [];
    if (rep.init) {
      var init = typeof rep.init === "string" ? { url: abs(baseUrl, rep.init), range: null } : rep.init;
      urls.push(init);
    }
    urls = urls.concat(segs);
    if (!urls.length) throw new Error("该表示没有可下载的分片");
    var out = new Array(urls.length);
    var done = 0, next = 0;
    var CONC = 6;
    async function worker() {
      for (;;) {
        var i = next++;
        if (i >= urls.length) return;
        var ok = false, lastErr = null;
        // 部分 CDN（爱奇艺等）不接受 Range 请求，会回 405/400 —— 首次失败后自动去掉 Range 重试
        var useRange = !!urls[i].range;
        for (var t = 0; t < 3 && !ok; t++) {
          try {
            var headers = {};
            if (useRange && urls[i].range) headers.Range = "bytes=" + urls[i].range[0] + "-" + urls[i].range[1];
            var r = await fetch(urls[i].url, { headers: headers, credentials: "include" });
            if (!r.ok) {
              // 把 CDN 拒绝的真实原因带出来（body 片段 + 关键响应头），便于定位
              var why = "HTTP " + r.status;
              try {
                var ct = r.headers.get("content-type") || "";
                if (/text|json|xml/i.test(ct)) {
                  var body = (await r.text()).slice(0, 160).replace(/\s+/g, " ");
                  if (body) why += " [" + body + "]";
                }
                var sv = r.headers.get("server");
                if (sv) why += " server=" + sv;
              } catch (e) {}
              lastErr = new Error(why);
              if (r.status === 404) break;
              if (/^(405|400|501)$/.test(String(r.status))) useRange = false; // 不支持 Range → 整段拉取
              continue;
            }
            out[i] = await r.arrayBuffer();
            ok = true;
          } catch (e) { lastErr = e; }
        }
        if (!ok) {
          if (lastErr && /404/.test(String(lastErr.message)) && i > 1) { out.length = i; break; }
          throw new Error("分片下载失败（第 " + (i + 1) + " 片）：" +
            (lastErr && lastErr.message) + " · host=" + hostOf(urls[i].url));
        }
        done++;
        if (onProg) onProg(done / urls.length, i);
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONC, urls.length) }, worker));
    return new Blob(out.filter(Boolean), { type: "video/mp4" });
  }

  // 入口：给定 mpd URL → 下载并解析 → 返回可选表示清单
  async function resolve(mpdUrl) {
    const r = await fetch(mpdUrl, { credentials: "include" });
    if (!r.ok) throw new Error("MPD 下载失败 HTTP " + r.status);
    const txt = await r.text();
    const parsed = parse(txt, mpdUrl);
    parsed.url = mpdUrl;
    parsed.pickBest = pickBest;
    // 把 MPD 内部所有 BaseURL/SegmentTemplate 引用的 host 一并返回，
    // 让上层给它们也装上 Referer 伪装（爱奇艺 MPD→分片 host 经常跨域）
    parsed.hosts = extractHostsFromMpdText(txt, mpdUrl);
    return parsed;
  }

  global.YTDash = {
    resolve: resolve,
    parse: parse,
    pickBest: pickBest,
    downloadSegments: downloadSegments,
    fromBilibili: fromBilibili,
    parseSidx: parseSidx
  };
})(window);
