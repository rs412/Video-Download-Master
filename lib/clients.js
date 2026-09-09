// clients.js — InnerTube 多客户端（逐字段对标 yt-dlp INNERTUBE_CLIENTS，2026-09 源码版）
//
// 背景：web 客户端的高清流走 SABR（无直链）+ GVS PO Token，只有 360p(itag 18) 免签。
// 客户端身份识别主要靠 POST body 的 context.client JSON（浏览器 fetch 禁设 HTTP User-Agent 头，
// 但 body 里的 userAgent 字段可以设 —— yt-dlp 的客户端 UA 就定义在 INNERTUBE_CONTEXT.client 里）。
// 当前 yt-dlp 默认：BASE_CLIENTS = ('tv','web','mweb','android','ios') 已过时，
// 实际 _DEFAULT_CLIENTS = ('visionos','web')，登录时 _DEFAULT_AUTHED_CLIENTS = ('web_embedded','tv_downgraded','web')。

(function (global) {
  // 顺序即自动回退优先级
  const CLIENTS = [
    {
      // yt-dlp 当前默认主力：免 PO Token、REQUIRE_JS_PLAYER=False（URL 预签名）
      id: "visionos", label: "Vision OS", clientName: "VISIONOS",
      clientVersion: "1.02", clientId: 101,
      ctx: {
        deviceMake: "Apple",
        deviceModel: "RealityDevice17,1",
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
        osName: "visionOS",
        osVersion: "26.5.23O471"
      },
      omitCookies: true,
      note: "yt-dlp 当前默认主力：免 PO Token、免 JS player"
    },
    {
      // 登录态主力：降级版 TVHTML5，必须带 cookie + SAPISIDHASH 等签名头
      id: "tv_downgraded", label: "TV 降级版", clientName: "TVHTML5",
      clientVersion: "5.20260707", clientId: 7,
      ctx: { userAgent: "Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version" },
      auth: true,
      note: "yt-dlp 登录时主力：需 cookie + SAPISIDHASH 签名头"
    },
    {
      // 免 PO Token，仅可嵌入视频；embedUrl 可以是任意非 YouTube URL（yt-dlp 用 reddit）
      id: "web_embedded", label: "Web Embedded", clientName: "WEB_EMBEDDED_PLAYER",
      clientVersion: "2.20260708.00.00", clientId: 56,
      embedUrl: "https://www.reddit.com/",
      auth: true,
      note: "免 PO Token，仅可嵌入视频可用"
    },
    {
      // WEB + Safari 身份：返回预合并音视频的 HLS(m3u8)，HLS 流免 PO Token
      id: "web_safari", label: "Web Safari (HLS)", clientName: "WEB",
      clientVersion: "2.20260708.00.00", clientId: 1,
      ctx: {
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.5 Safari/605.1.15,gzip(gfe)"
      },
      auth: true, hls: true,
      note: "返回预合并 HLS 清单（含音轨），免 PO Token，逐段拼接下载"
    },
    {
      id: "web", label: "WEB (网页自带)", clientName: "WEB",
      clientVersion: null, clientId: 1,
      note: "需 GVS PO Token，高清为 SABR 无直链，常 403"
    }
  ];

  function getClient(id) {
    return CLIENTS.find((c) => c.id === id) || null;
  }

  // 探测直链是否可下载（403 = 缺 PO Token / 签名无效）
  // cache:"no-store" 是关键：页面播放器刚请求过这些 URL，若命中 HTTP 缓存会假 200，
  // 导致「探测通过但真实下载 403」的误判。
  async function probe(url) {
    try {
      const r = await fetch(url, { headers: { Range: "bytes=0-1" }, cache: "no-store" });
      return { ok: r.status === 200 || r.status === 206, status: r.status };
    } catch (e) {
      return { ok: false, status: 0, error: String((e && e.message) || e) };
    }
  }

  // 双档探测：最高分辨率 2 档全部通过才算该数据源可用（防单条 URL 偶然通过）
  async function probeMulti(formats, n) {
    const cands = formats
      .filter((f) => f.url && f.hasVideo && !f.isHls)
      .sort((a, b) => (b.height || 0) - (a.height || 0))
      .slice(0, n || 2);
    if (!cands.length) return { ok: false, detail: "无可探测直链" };
    const statuses = [];
    for (const f of cands) {
      const p = await probe(f.url);
      statuses.push((f.height || f.itag) + ":" + p.status);
      if (!p.ok) return { ok: false, detail: statuses.join(" ") };
    }
    return { ok: true, detail: statuses.join(" ") };
  }

  // 从格式列表挑一条用于探测的 URL：优先最高分辨率的自适应视频流
  function pickProbeUrl(formats) {
    const cands = formats
      .filter((f) => f.url && f.hasVideo && f.type === "adaptive")
      .sort((a, b) => (b.height || 0) - (a.height || 0));
    if (cands.length) return cands[0].url;
    const any = formats.filter((f) => f.url);
    return any.length ? any[0].url : null;
  }

  global.YTClients = {
    CLIENTS: CLIENTS,
    getClient: getClient,
    probe: probe,
    probeMulti: probeMulti,
    pickProbeUrl: pickProbeUrl
  };
})(window);
