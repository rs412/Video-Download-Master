// lib/tencent.js — 腾讯视频（v.qq.com）片源解析，运行于页面 MAIN world（window.YTTencent）。
// 路线：与爱奇艺一致走「HLS 逐片合并」，但签名算法不同：
//   getvinfo 接口需要 ckey（AES-CBC + whitespace padding，key/iv 来自 yt-dlp 硬编码）→ 返回 ul.ui[].hls（m3u8 链）
//   → 拿到 m3u8 后逐片下载合并（offscreen 内完成，避免整文件直链被 CDN 截断）。
// ckey 算法已验证与 yt-dlp 的 Python 实现逐字节一致。
(function () {
  var APP_VERSION = "3.5.57";
  var PLATFORM = "10901";
  var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";
  // 腾讯 ckey 的 AES 密钥/IV（来自 yt-dlp tencent.py，硬编码）
  var KEY = new Uint8Array([0x4f,0x6b,0xda,0xa3,0x9e,0x2f,0x8c,0xb0,0x7f,0x5e,0x72,0x2d,0x9e,0xde,0xf3,0x14]);
  var IV  = new Uint8Array([0x01,0x50,0x4a,0xf3,0x56,0xe6,0x19,0xcf,0x2e,0x42,0xbb,0xa6,0x8c,0x3f,0x70,0xf9]);

  // 生成 16 位 guid / 32 位 flowid（小写字母+数字）
  function rnd(n) {
    var s = "0123456789abcdefghijklmnopqrstuvwxyz";
    var o = "";
    for (var i = 0; i < n; i++) o += s[Math.floor(Math.random() * s.length)];
    return o;
  }

  // ckey：AES-128-CBC 加密，whitespace(0x20) 补齐到 16 字节整数倍
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
    for (var j = 0; j < pad; j++) padded[bytes.length + j] = 0x20; // whitespace padding
    var ck = await crypto.subtle.importKey("raw", KEY, { name: "AES-CBC" }, false, ["encrypt"]);
    var out = await crypto.subtle.encrypt({ name: "AES-CBC", iv: IV }, ck, padded);
    var u = new Uint8Array(out);
    var hex = "";
    for (var k = 0; k < u.length; k++) hex += ("0" + u[k].toString(16)).slice(-2);
    return hex.toUpperCase();
  }

  // 主世界取 vid：页面初始化数据（__PINIA__/__INITIAL_STATE__/__NUXT__/QZoutputJSON 等）最可靠，
  // 兜底页面 HTML 正则，最后兜底 URL 末段。
  // 注意：腾讯部分页面 URL 末段是「页面 id」而非视频 vid（如 w0010KhTfom 是 pageId，
  // 真 vid 形如 s00242sxrne），故 URL 仅作兜底，真实 vid 优先从页面状态树取。
  function getVid() {
    var re = /["']?vid["']?\s*[:=]\s*["']?([A-Za-z0-9_]{6,})/;
    // 1) 常见全局状态树（腾讯页面初始化数据多注入其中）
    var globals = [window.__PINIA__, window.__INITIAL_STATE__, window.__NUXT__, window.__NEXT_DATA__, window.QZoutputJSON];
    for (var i = 0; i < globals.length; i++) {
      try {
        if (globals[i]) {
          var gm = re.exec(JSON.stringify(globals[i]));
          if (gm && gm[1]) return gm[1];
        }
      } catch (e) {}
    }
    // 2) 页面 HTML 初始化脚本（内联 <script> 含 vid 时）
    try {
      var mh = re.exec(document.documentElement.innerHTML || "");
      if (mh && mh[1]) return mh[1];
    } catch (e) {}
    // 3) 兜底：URL 末段（仅当上面都没拿到）
    try {
      var href = location.href || (window.top && window.top.location && window.top.location.href) || "";
      var um = /\/x\/(?:cover|page)\/[^/]+\/([A-Za-z0-9_]{6,})\.html/i.exec(href)
            || /\/x\/(?:cover|page)\/([A-Za-z0-9_]{6,})\.html/i.exec(href);
      if (um && um[1]) return um[1];
    } catch (e) {}
    return null;
  }

  // 调 getvinfo 换 m3u8（单 vid 尝试）。host 在扩展内 fetch 需 DNR 注入 Referer（由 background 完成）。
  async function tryGetVinfo(vid, pageUrl) {
    var guid = rnd(16);
    var flowid = rnd(32);
    var ck = await ckey(vid, pageUrl, guid);
    var q = new URLSearchParams({
      vid: vid,
      cid: "",
      cKey: ck,
      encryptVer: "8.1",
      sphls: "2",
      dtype: "3",
      defn: "hd",
      spsrt: "2",
      sphttps: "1",
      otype: "json",
      spwm: "1",
      hevclv: "28",
      drm: "40",
      spvideo: "4",
      spsfrhdr: "100",
      host: "v.qq.com",
      referer: "v.qq.com",
      ehost: pageUrl,
      appVer: APP_VERSION,
      platform: PLATFORM,
      guid: guid,
      flowid: flowid
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
    } finally {
      if (to) clearTimeout(to);
    }
    if (!r.ok) throw new Error("getvinfo HTTP " + r.status);
    var txt = await r.text();
    var i = txt.indexOf("{");
    if (i < 0) throw new Error("getvinfo 无 JSON 返回");
    var j = txt.lastIndexOf("}");
    if (i < 0 || j <= i) throw new Error("getvinfo 无 JSON 返回");
    // 返回为 QZOutputJson={...}; 形式 —— 截取首 { 到末 } 之间的纯 JSON
    var d = JSON.parse(txt.slice(i, j + 1));
    if (d.code !== "0.0" && d.code !== 0 && String(d.code) !== "0") {
      throw new Error("腾讯接口拒绝：" + (d.msg || "未知") + "（code=" + d.code + "）");
    }
    var vi = d.vl.vi[0];
    if (!vi || !vi.ul || !vi.ul.ui) throw new Error("无可用片源");
    var ui = vi.ul.ui;
    for (var x = 0; x < ui.length; x++) {
      var u = ui[x];
      if (u.hls || (u.url && /\.m3u8(\?|#|$)/i.test(u.url))) {
        var m3u8 = u.url + (u.hls ? u.hls.pt : "");
        return { m3u8: m3u8, br: vi.br, vw: vi.vw, vh: vi.vh, fn: vi.fn, vid: vid };
      }
    }
    // 无 HLS 源（非会员账号常见）：走 fn+fvkey 渐进式 mp4 直链（与 yt-dlp else 分支同款）
    if (vi.fn && vi.fvkey && ui.length && ui[0].url) {
      return { direct: ui[0].url + vi.fn + "?vkey=" + vi.fvkey, br: vi.br, vw: vi.vw, vh: vi.vh, fn: vi.fn, vid: vid };
    }
    throw new Error("该视频无 HLS 片源且无直链（可能需登录或 VIP）");
  }

  // resolve：自动尝试多个 vid 候选（页面数据提取的真 vid 优先；失败再用 URL 末段兜底），
  // 谁过鉴权/版权墙就用谁，避免单一点提取失败就整体报错。
  async function resolve(vid, pageUrl) {
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
        var rr = await tryGetVinfo(candidates[c], pageUrl);
        if (rr) return rr;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error("未解析到可用片源（vid 候选均失败）");
  }

  window.YTTencent = { ckey: ckey, getVid: getVid, resolve: resolve };
})();
