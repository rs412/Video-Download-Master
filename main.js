// main.js — world:"MAIN"，唯一职责：读取页面主世界的全局变量并回传给隔离世界中枢。
// 与隔离世界的桥接用 window.postMessage（非脚本执行，不受页面/扩展 CSP 限制）。
//
// 新增能力：在「页面主世界」内请求其他 InnerTube 客户端（tv / tv_simply / mweb / android_vr）。
// 为什么必须在这里做而不是 popup 里做？
//   - 这里 fetch youtubei 是「同域」请求，不受 YouTube 页面 CSP 的 connect-src 限制；
//   - 这里自动携带 YouTube 登录 cookie，InnerTube 会返回完整的、带 PO Token（pot 参数）
//     的高清格式 URL；而 popup 是扩展页面，无 cookie 且 sts 缺失，请求会被拒/被限。
//   这正是「在 popup 里换客户端没用、只有 360p 能下」的根因。
(function () {
  // ---- 捕获页面播放器的 GVS 媒体请求（PO Token 抓取）----
  // 页面播放器正常播放时会请求 googlevideo.com/videoplayback?...&pot=<PO Token>。
  // pot 绑定「访客+视频」而非 itag，把 pot 拼到 ytInitialPlayerResponse 的高清格式 URL
  // 上即可绕过 web 客户端的 PO Token 校验（比换 InnerTube 客户端更可靠、不依赖客户端政策）。
  var _gvsPot = null;
  var _gvsUrls = {};
  function noteGvsUrl(u) {
    try {
      if (!u || u.indexOf("googlevideo.com/videoplayback") === -1) return;
      var url = new URL(u, location.href);
      var itag = url.searchParams.get("itag");
      var p = url.searchParams.get("pot");
      if (p && !_gvsPot) _gvsPot = p;
      if (itag && !_gvsUrls[itag]) {
        // 去掉分段请求参数，保留其余签名参数（含 pot/clen/lmt 等）
        url.searchParams.delete("rn");
        url.searchParams.delete("rbuf");
        _gvsUrls[itag] = url.toString();
      }
    } catch (e) {}
  }
  (function hookGvs() {
    try { performance.setResourceTimingBufferSize(4096); } catch (e) {}
    // buffered:true 会把注入前已发生的 resource 请求一次性回放 —— 覆盖「打开弹窗前已在播放」的场景
    try {
      var po = new PerformanceObserver(function (list) {
        var es = list.getEntries() || [];
        for (var i = 0; i < es.length; i++) noteGvsUrl(es[i].name);
      });
      po.observe({ type: "resource", buffered: true });
    } catch (e) {}
    if (!window.__yt_dl_fetch_hooked__) {
      window.__yt_dl_fetch_hooked__ = true;
      var _of = window.fetch;
      if (_of) {
        window.fetch = function (input, init) {
          try {
            var u = typeof input === "string" ? input : (input && input.url) || "";
            noteGvsUrl(u);
          } catch (e) {}
          return _of.apply(this, arguments);
        };
      }
      try {
        var _oo = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function (method, u) {
          try { noteGvsUrl(typeof u === "string" ? u : String(u)); } catch (e) {}
          return _oo.apply(this, arguments);
        };
      } catch (e) {}
    }
  })();
  function snapshotGvs() {
    return { pot: _gvsPot, urls: Object.assign({}, _gvsUrls) };
  }

  // ---- 读取播放数据 ----
  function readYtcfg() {
    try {
      const c = window.ytcfg && (window.ytcfg.data_ || window.ytcfg);
      if (!c) return null;
      const get = (k) => {
        if (typeof c.get === "function") {
          try { return c.get(k); } catch (e) {}
        }
        return c[k];
      };
      const ctx = get("INNERTUBE_CONTEXT") || {};
      const cl = ctx.client || {};
      return {
        apiKey: get("INNERTUBE_API_KEY") || null,
        clientVersion: cl.clientVersion || get("INNERTUBE_CLIENT_VERSION") || null,
        hl: cl.hl || get("HL") || "zh-CN",
        gl: cl.gl || get("GL") || "CN",
        pageClient: cl.clientName || null,
        context: ctx
      };
    } catch (e) {
      return null;
    }
  }

  // ---- 登录态签名（对标 yt-dlp _generate_cookie_auth_headers / _make_sid_authorization）----
  function readCookie(name) {
    const parts = document.cookie ? document.cookie.split(";") : [];
    for (let i = 0; i < parts.length; i++) {
      const kv = parts[i].trim();
      const eq = kv.indexOf("=");
      if (eq > 0 && kv.slice(0, eq) === name) return kv.slice(eq + 1);
    }
    return null;
  }

  function sha1Hex(str) {
    return crypto.subtle
      .digest("SHA-1", new TextEncoder().encode(str))
      .then(function (buf) {
        const v = new Uint8Array(buf);
        const out = [];
        for (let i = 0; i < v.length; i++) out.push(("0" + v[i].toString(16)).slice(-2));
        return out.join("");
      });
  }

  // SAPISIDHASH <ts>_<sha1("<ts> <sid> <origin>")>；SAPISID 缺失时回退 __Secure-3PAPISID（与 yt-dlp 一致）
  async function buildAuthHeaders() {
    const c = window.ytcfg && (window.ytcfg.data_ || window.ytcfg);
    const get = function (k) {
      try { if (c && typeof c.get === "function") return c.get(k); } catch (e) {}
      return c ? c[k] : undefined;
    };
    const origin = "https://www.youtube.com";
    const sapisid = readCookie("SAPISID") || readCookie("__Secure-3PAPISID");
    const sapisid1p = readCookie("__Secure-1PAPISID");
    const sapisid3p = readCookie("__Secure-3PAPISID");
    if (!sapisid && !sapisid1p && !sapisid3p) return null;

    const ts = String(Math.floor(Date.now() / 1000));
    const mk = function (scheme, sid) {
      if (!sid) return Promise.resolve(null);
      return sha1Hex(ts + " " + sid + " " + origin).then(function (h) {
        return scheme + " " + ts + "_" + h;
      });
    };
    const auths = [];
    const a1 = await mk("SAPISIDHASH", sapisid);
    const a2 = await mk("SAPISID1PHASH", sapisid1p);
    const a3 = await mk("SAPISID3PHASH", sapisid3p);
    if (a1) auths.push(a1);
    if (a2) auths.push(a2);
    if (a3) auths.push(a3);
    if (!auths.length) return null;

    const headers = { Authorization: auths.join(" "), "X-Origin": origin };
    const pageId = get("DELEGATED_SESSION_ID");
    if (pageId) headers["X-Goog-PageId"] = pageId;
    const sessionIndex = get("SESSION_INDEX");
    if (pageId || sessionIndex != null) {
      headers["X-Goog-AuthUser"] = sessionIndex != null ? String(sessionIndex) : "0";
    }
    if (get("LOGGED_IN") === true) headers["X-Youtube-Bootstrap-Logged-In"] = "true";
    return headers;
  }

  // 读取 visitorData：yt-dlp 所有客户端请求都带 X-Goog-Visitor-Id 头，缺失会被判为不可信会话
  function readVisitorData() {
    try {
      const c = window.ytcfg && (window.ytcfg.data_ || window.ytcfg);
      const get = (k) => {
        if (typeof c.get === "function") { try { return c.get(k); } catch (e) {} }
        return c ? c[k] : undefined;
      };
      let v =
        get("VISITOR_DATA") ||
        ((get("INNERTUBE_CONTEXT") || {}).client || {}).visitorData ||
        null;
      if (typeof v === "string" && v.charAt(0) === '"') {
        try { v = JSON.parse(v); } catch (e) {}
      }
      return v || null;
    } catch (e) {
      return null;
    }
  }

  // 读取 sts（signatureTimestamp）：某些客户端/老格式解密 sig 需要，缺失则尝试从 ytplayer 配置取
  function readSts() {
    try {
      const ytc = window.ytplayer && window.ytplayer.config;
      if (ytc) {
        if (ytc.args && ytc.args.sts) return parseInt(ytc.args.sts, 10);
        if (ytc.sts) return parseInt(ytc.sts, 10);
      }
    } catch (e) {}
    return 0;
  }

  function getJsUrl() {
    let jsUrl = null;
    try {
      const cfg = window.ytplayer && window.ytplayer.config;
      if (cfg && cfg.assets) jsUrl = cfg.assets.js || null;
    } catch (e) {}
    if (!jsUrl) {
      const scripts = document.scripts;
      for (let i = 0; i < scripts.length; i++) {
        const src = scripts[i].src || "";
        if (/player\/.+\/base\.js/.test(src)) { jsUrl = src; break; }
      }
    }
    if (jsUrl) {
      try { jsUrl = new URL(jsUrl.replace(/\\u002f/g, "/"), location.href).href; }
      catch (e) { jsUrl = null; }
    }
    return jsUrl;
  }

  function readPlayerData() {
    const pr = window.ytInitialPlayerResponse || null;
    return { pr: pr, jsUrl: getJsUrl(), ytcfg: readYtcfg(), gvs: snapshotGvs() };
  }

  // ---- 在页面主世界请求其他 InnerTube 客户端 ----
  // 关键（对标 yt-dlp）：① context.client 用「干净」的客户端身份（不继承 web 页面的 context，
  // 否则身份字段污染被识破 →「需要重新加载此页面」）；② 客户端 UA 写在 body 的 context.client.userAgent
  // （HTTP 头的 User-Agent 浏览器禁改，body 字段可以）；③ 登录态带 SAPISIDHASH 等签名头。
  async function requestClientVideo(spec) {
    const pr0 = window.ytInitialPlayerResponse;
    const videoId = pr0 && pr0.videoDetails && pr0.videoDetails.videoId;
    if (!videoId) return { ok: false, error: "页面未找到 videoId" };

    spec = spec || {};
    const pageCfg = readYtcfg() || {};
    const pageCl = pageCfg.context && pageCfg.context.client ? pageCfg.context.client : {};
    const cl = Object.assign(
      { hl: pageCl.hl || pageCfg.hl || "zh-CN", gl: pageCl.gl || pageCfg.gl || "CN" },
      spec.ctx || {},
      { clientName: spec.clientName || "VISIONOS", clientVersion: spec.clientVersion || "1.02" }
    );

    const body = {
      context: {
        client: cl,
        user: { lockedSafetyMode: false },
        request: { useSsl: true }
      },
      videoId: videoId,
      contentCheckOk: true,
      racyCheckOk: true
    };
    // web_embedded：embedUrl 必须为任意「非 YouTube」URL（yt-dlp _fix_embedded_ytcfg 同款）
    if (spec.embedUrl) body.context.thirdParty = { embedUrl: spec.embedUrl };
    const sts = readSts();
    if (sts) body.playbackContext = { contentPlaybackContext: { signatureTimestamp: sts } };

    const visitor = readVisitorData();
    const headers = {
      "Content-Type": "application/json",
      "X-Youtube-Client-Name": String(spec.clientId || 101),
      "X-Youtube-Client-Version": cl.clientVersion,
      Accept: "application/json"
    };
    if (visitor) {
      headers["X-Goog-Visitor-Id"] = visitor;
      cl.visitorData = visitor;
    }
    if (spec.auth) {
      const ah = await buildAuthHeaders();
      if (ah) Object.assign(headers, ah);
    }

    const url = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";
    let r;
    try {
      r = await fetch(url, {
        method: "POST",
        credentials: spec.auth ? "include" : "omit",
        headers: headers,
        body: JSON.stringify(body)
      });
    } catch (e) {
      return { ok: false, error: "页面请求失败：" + String((e && e.message) || e) };
    }
    if (!r.ok) return { ok: false, error: "HTTP " + r.status };

    let pr;
    try { pr = await r.json(); } catch (e) { return { ok: false, error: "响应 JSON 解析失败" }; }

    if (!pr.streamingData) {
      return {
        ok: false,
        error: "无 streamingData（" +
          ((pr.playabilityStatus && pr.playabilityStatus.status) || "未知") + "：" +
          ((pr.playabilityStatus && pr.playabilityStatus.reason) || "无原因") + "）"
      };
    }
    return { ok: true, pr: pr, jsUrl: getJsUrl() };
  }

  // ---- 消息桥接 ----
  window.addEventListener("message", function (e) {
    const d = e.data;
    if (!d) return;

    // 1) 读取播放数据（popup 首拉）
    if (d.__yt_dl_req__ === true) {
      let payload;
      try { payload = readPlayerData(); }
      catch (err) { payload = { pr: null, jsUrl: null, error: String(err) }; }
      try {
        window.postMessage({ __yt_dl_data__: payload }, "*");
      } catch (err) {
        try {
          window.postMessage({ __yt_dl_data_json__: JSON.stringify(payload) }, "*");
        } catch (err2) {
          window.postMessage({ __yt_dl_data__: { pr: null, jsUrl: null, error: "clone failed" } }, "*");
        }
      }
      return;
    }

    // 2) 在页面主世界请求其他客户端（绕 web 客户端 PO Token）
    if (d.__yt_dl_client_req__ === true) {
      requestClientVideo(d.client)
        .then((res) => {
          const payload = res.ok
            ? { pr: res.pr, jsUrl: res.jsUrl, error: null }
            : { pr: null, jsUrl: null, error: res.error };
          try {
            window.postMessage({ __yt_dl_client_data__: payload }, "*");
          } catch (err) {
            window.postMessage({ __yt_dl_client_data__: { pr: null, jsUrl: null, error: "clone failed" } }, "*");
          }
        })
        .catch((err) => {
          try {
            window.postMessage({ __yt_dl_client_data__: { pr: null, jsUrl: null, error: String((err && err.message) || err) } }, "*");
          } catch (e2) {}
        });
      return;
    }
  });
})();
