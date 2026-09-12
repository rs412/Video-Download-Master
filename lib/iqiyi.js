// iqiyi.js — 爱奇艺片源解析（纯 MD5 签名，无需 PhantomJS / cmd5x）
//
// 背景：爱奇艺 DASH 分片（data.video.iqiyi.com）带鉴权，通用下载器拿不到签名，
//       直接请求会返回 HTTP 405 + {"code":"D2102"}（yt-dlp 为此需要 PhantomJS 跑 cmd5x）。
//
// 解法：爱奇鉴权接口 cache.video.iqiyi.com/dash 的签名 vf 其实是可算的——
//       vf = md5( path?query + 32 位固定后缀 )
//       该后缀由一组确定的算术式生成，与账号/时间无关，可直接固化。
//       拿到 /dash 响应后走 m3u8（ff=ts）链路：分片 URL 上已带 start/end 字节区间，
//       把这些参数去掉即可一次性拉到整文件，交给浏览器原生下载栈落盘。
(function (global) {
  // ---------- 紧凑 MD5（UTF-8，32 位小写 hex） ----------
  function md5hex(str) {
    function safe_add(x, y) {
      var lsw = (x & 0xffff) + (y & 0xffff);
      var msw = (x >> 16) + (y >> 16) + (lsw >> 16);
      return (msw << 16) | (lsw & 0xffff);
    }
    function rol(num, cnt) { return (num << cnt) | (num >>> (32 - cnt)); }
    function cmn(q, a, b, x, s, t) { return safe_add(rol(safe_add(safe_add(a, q), safe_add(x, t)), s), b); }
    function ff(a, b, c, d, x, s, t) { return cmn((b & c) | (~b & d), a, b, x, s, t); }
    function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & ~d), a, b, x, s, t); }
    function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
    function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | ~d), a, b, x, s, t); }
    function cycle(x, k) {
      var a = x[0], b = x[1], c = x[2], d = x[3];
      a = ff(a, b, c, d, k[0], 7, -680876936);   d = ff(d, a, b, c, k[1], 12, -389564586);  c = ff(c, d, a, b, k[2], 17, 606105819);   b = ff(b, c, d, a, k[3], 22, -1044525330);
      a = ff(a, b, c, d, k[4], 7, -176418897);   d = ff(d, a, b, c, k[5], 12, 1200080426);  c = ff(c, d, a, b, k[6], 17, -1473231341);  b = ff(b, c, d, a, k[7], 22, -45705983);
      a = ff(a, b, c, d, k[8], 7, 1770035416);   d = ff(d, a, b, c, k[9], 12, -1958414417); c = ff(c, d, a, b, k[10], 17, -42063);      b = ff(b, c, d, a, k[11], 22, -1990404162);
      a = ff(a, b, c, d, k[12], 7, 1804603682);  d = ff(d, a, b, c, k[13], 12, -40341101);  c = ff(c, d, a, b, k[14], 17, -1502002290); b = ff(b, c, d, a, k[15], 22, 1236535329);
      a = gg(a, b, c, d, k[1], 5, -165796510);   d = gg(d, a, b, c, k[6], 9, -1069501632);  c = gg(c, d, a, b, k[11], 14, 643717713);  b = gg(b, c, d, a, k[0], 20, -373897302);
      a = gg(a, b, c, d, k[5], 5, -701558691);   d = gg(d, a, b, c, k[10], 9, 38016083);    c = gg(c, d, a, b, k[15], 14, -660478335); b = gg(b, c, d, a, k[4], 20, -405537848);
      a = gg(a, b, c, d, k[9], 5, 568446438);    d = gg(d, a, b, c, k[14], 9, -1019803690); c = gg(c, d, a, b, k[3], 14, -187363961);  b = gg(b, c, d, a, k[8], 20, 1163531501);
      a = gg(a, b, c, d, k[13], 5, -1444681467); d = gg(d, a, b, c, k[2], 9, -51403784);    c = gg(c, d, a, b, k[7], 14, 1735328473);  b = gg(b, c, d, a, k[12], 20, -1926607734);
      a = hh(a, b, c, d, k[5], 4, -378558);      d = hh(d, a, b, c, k[8], 11, -2022574463); c = hh(c, d, a, b, k[11], 16, 1839030562); b = hh(b, c, d, a, k[14], 23, -35309556);
      a = hh(a, b, c, d, k[1], 4, -1530992060);  d = hh(d, a, b, c, k[4], 11, 1272893353);  c = hh(c, d, a, b, k[7], 16, -155497632);  b = hh(b, c, d, a, k[10], 23, -1094730640);
      a = hh(a, b, c, d, k[13], 4, 681279174);   d = hh(d, a, b, c, k[0], 11, -358537222);  c = hh(c, d, a, b, k[3], 16, -722521979);  b = hh(b, c, d, a, k[6], 23, 76029189);
      a = hh(a, b, c, d, k[9], 4, -640364487);   d = hh(d, a, b, c, k[12], 11, -421815835); c = hh(c, d, a, b, k[15], 16, 530742520);  b = hh(b, c, d, a, k[2], 23, -995338651);
      a = ii(a, b, c, d, k[0], 6, -198630844);   d = ii(d, a, b, c, k[7], 10, 1126891415);  c = ii(c, d, a, b, k[14], 15, -1416354905); b = ii(b, c, d, a, k[5], 21, -57434055);
      a = ii(a, b, c, d, k[12], 6, 1700485571);  d = ii(d, a, b, c, k[3], 10, -1894986606); c = ii(c, d, a, b, k[10], 15, -1051523);   b = ii(b, c, d, a, k[1], 21, -2054922799);
      a = ii(a, b, c, d, k[8], 6, 1873313359);   d = ii(d, a, b, c, k[15], 10, -30611744);  c = ii(c, d, a, b, k[6], 15, -1560198380); b = ii(b, c, d, a, k[13], 21, 1309151649);
      a = ii(a, b, c, d, k[4], 6, -145523070);   d = ii(d, a, b, c, k[11], 10, -1120210379); c = ii(c, d, a, b, k[2], 15, 718787259);  b = ii(b, c, d, a, k[9], 21, -343485551);
      x[0] = safe_add(a, x[0]); x[1] = safe_add(b, x[1]); x[2] = safe_add(c, x[2]); x[3] = safe_add(d, x[3]);
      return x;
    }
    function blk(s) {
      var b = [], i;
      for (i = 0; i < 64; i += 4) {
        b[i >> 2] = s.charCodeAt(i) + (s.charCodeAt(i + 1) << 8) +
                    (s.charCodeAt(i + 2) << 16) + (s.charCodeAt(i + 3) << 24);
      }
      return b;
    }
    function utf8(s) {
      s = s.replace(/\r\n/g, "\n");
      var out = "", n, c;
      for (n = 0; n < s.length; n++) {
        c = s.charCodeAt(n);
        if (c < 128) out += String.fromCharCode(c);
        else if (c > 127 && c < 2048) out += String.fromCharCode((c >> 6) | 192, (c & 63) | 128);
        else out += String.fromCharCode((c >> 12) | 224, ((c >> 6) & 63) | 128, (c & 63) | 128);
      }
      return out;
    }
    function rhex(n) {
      var h = "0123456789abcdef", o = "", j;
      for (j = 0; j < 4; j++) o += h[(n >> (j * 8 + 4)) & 0xf] + h[(n >> (j * 8)) & 0xf];
      return o;
    }
    function hex(x) { var s = "", i; for (i = 0; i < x.length; i++) s += rhex(x[i]); return s; }
    var sb = utf8(String(str));
    var n = sb.length, state = [1732584193, -271733879, -1732584194, 271733878], i;
    for (i = 64; i <= sb.length; i += 64) state = cycle(state, blk(sb.substring(i - 64, i)));
    sb = sb.substring(i - 64);
    var tail = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    var len = sb.length;
    for (i = 0; i < len; i++) tail[i >> 2] |= sb.charCodeAt(i) << ((i % 4) << 3);
    tail[i >> 2] |= 0x80 << ((i % 4) << 3);
    if (i > 55) { state = cycle(state, tail); for (i = 0; i < 16; i++) tail[i] = 0; }
    tail[14] = n * 8;
    state = cycle(state, tail);
    return hex(state);
  }

  // ---------- 签名 ----------
  // 固定 32 位后缀：由确定的算术式生成，与账号/时间无关（等价于 videodl 的 addChar）
  var VF_SUFFIX = (function () {
    var s = "";
    for (var t = 0; t < 4; t++) {
      for (var i = 0; i < 2; i++) {
        for (var n = 0; n < 4; n++) {
          var v = (70 * t + 677 * i + 21 * n + 87 * t * i * n + 59) % 30;
          s += String.fromCharCode(v + (v < 9 ? 48 : 88));
        }
      }
    }
    return s;
  })();

  function calcVf(pathAndQuery) {
    return md5hex(pathAndQuery + VF_SUFFIX);
  }
  function authKey(tm, tvid) {
    return md5hex(md5hex("") + String(tm) + String(tvid));
  }
  function deviceId() {
    var s = "";
    for (var i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
    return md5hex(s + String(Date.now()));
  }

  var DASH_HOST = "https://cache.video.iqiyi.com";
  var BID_LABEL = {
    800: "4K/杜比", 600: "1080P", 500: "超清 720P",
    300: "高清 480P", 200: "流畅 360P", 100: "标清 240P"
  };

  function buildDashQuery(tvid, bid, tm, bopEncoded) {
    var p = {
      tvid: tvid, bid: bid, vid: "", src: "01010031010000000000", vt: 0, rs: 1,
      uid: "", ori: "pcw", ps: 1, k_uid: deviceId(), pt: 0, d: 0, s: "", lid: 0,
      cf: 0, ct: 0, authKey: authKey(tm, tvid), k_tag: 1, dfp: "", locale: "zh_cn",
      pck: "", k_err_retries: 0, up: "", qd_v: "a1", tm: tm,
      k_ft1: "706436220846084", k_ft4: "1162321298202628",
      k_ft5: "150994945", k_ft7: "4",
      bop: bopEncoded, sr: 1, ost: 0, ut: 0
    };
    var q = Object.keys(p).map(function (k) {
      return encodeURIComponent(k) + "=" + encodeURIComponent(p[k]);
    }).join("&");
    return q + "&vf=" + calcVf("/dash?" + q);
  }

  // 从 m3u8 文本里取分片 URL
  function segsOfM3u8(text) {
    return String(text || "").split("\n")
      .map(function (l) { return l.trim(); })
      .filter(function (l) { return l && l.charAt(0) !== "#"; });
  }

  // 去掉 start/end/contentlength/sd 四个分片参数 → 得到「整文件」直链。
  // 实测：爱奇艺 CDN 支持整文件单请求（Accept-Ranges: bytes），可交给原生下载栈。
  function toWholeFileUrl(segUrl) {
    try {
      var u = new URL(segUrl);
      ["start", "end", "contentlength", "sd"].forEach(function (k) {
        u.searchParams.delete(k);
      });
      return u.href;
    } catch (e) {
      return String(segUrl).replace(/([?&])(start|end|contentlength|sd)=[^&]*/g, function (m, p1) {
        return p1 === "?" ? "?" : "";
      }).replace(/\?&/, "?").replace(/[?&]$/, "");
    }
  }

  function extOf(url) {
    var m = /\.([a-z0-9]{2,4})(?:[?#]|$)/i.exec(String(url).split("?")[0]);
    if (m && /^(ts|mp4|m4s|flv|f4v|m4a)$/i.test(m[1])) return "." + m[1].toLowerCase();
    return ".ts";
  }

  // 响应用码流挑选：只要非 dash 封装（dash 分片带鉴权，拿不到），取 bid 最高的
  function pickBest(streams) {
    var cands = (streams || []).filter(function (s) {
      return s && s.ff !== "dash" && s.segments && s.segments.length;
    });
    if (!cands.length) return null;
    return cands.slice().sort(function (a, b) {
      return (b.bid || 0) - (a.bid || 0);
    })[0];
  }

  function parseDash(json) {
    var data = (json && json.data) || {};
    var list = (data.program && data.program.video) || [];
    var streams = list.map(function (v) {
      var segs = segsOfM3u8(v.m3u8);
      return {
        bid: parseInt(v.bid, 10) || 0,
        ff: v.ff || "",
        name: v.name || "",
        scrsz: v.scrsz || "",
        duration: parseFloat(v.duration) || 0,
        label: BID_LABEL[parseInt(v.bid, 10)] || v.name || ("bid " + v.bid),
        segments: segs
      };
    });
    var best = pickBest(streams);
    if (best) {
      best.ext = extOf(best.segments[0]);
      best.count = best.segments.length;
      // 真实总大小：逐分片 contentlength 之和（CDN 对「无 start/end 参数的整文件直链」
      // 会截断大文件，所以必须逐分片下载后再合并，这里提前算出总字节用于进度显示）
      best.totalBytes = best.segments.reduce(function (a, u) {
        var m = /[?&]contentlength=(\d+)/.exec(u);
        return a + (m ? parseInt(m[1], 10) : 0);
      }, 0);
    }
    return { code: json && json.code, st: data.st, streams: streams, best: best };
  }

  // 入口：给定 tvid → 请求 /dash → 返回可选码流与「整文件直链」
  // bop 参数服务端校验较松，双编码/单编码都试一次，取第一个有可用码流的响应。
  async function resolve(tvid) {
    var tm = Date.now();
    var bopRaw = '{"version":"10.0","dfp":"","b_ft1":28}';
    var variants = [
      encodeURIComponent(encodeURIComponent(bopRaw)), // 与已验证实现一致（双重编码）
      encodeURIComponent(bopRaw)
    ];
    var last = null;
    for (var i = 0; i < variants.length; i++) {
      var url = DASH_HOST + "/dash?" + buildDashQuery(tvid, 800, tm + i, variants[i]);
      let r;
      try {
        // 12s 超时：避免在扩展 origin 下被服务器挂起导致永久等待
        var ctrl = ("AbortController" in window) ? new AbortController() : null;
        var to = ctrl ? setTimeout(function () { ctrl.abort(); }, 12000) : null;
        r = await fetch(url, { credentials: "omit", signal: ctrl ? ctrl.signal : undefined });
        if (to) clearTimeout(to);
      } catch (e) {
        last = e; continue;
      }
      if (!r.ok) { last = new Error("片源接口 HTTP " + r.status); continue; }
      let json;
      try { json = await r.json(); } catch (e) { last = e; continue; }
      var parsed = parseDash(json);
      if (parsed.best) return parsed;
      last = new Error("片源接口无可用码流（code=" + parsed.code + " st=" + parsed.st + "）");
    }
    throw new Error((last && last.message) || "爱奇艺片源解析失败");
  }

  global.YTIqiyi = { resolve: resolve, md5hex: md5hex, calcVf: calcVf, authKey: authKey, VF_SUFFIX: VF_SUFFIX };
})(window);
