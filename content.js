// content.js — 隔离世界「消息中枢」：接收 popup 请求 → 向主世界索取播放数据 → 回传原始格式。
// 分工原则：
// 1) 消息监听留在隔离世界（world:"MAIN" 的脚本收不到 popup 的 sendMessage）。
// 2) 读页面全局变量靠 world:"MAIN" 的 main.js，用 window.postMessage 桥接（非脚本，不受 CSP 限制）。
// 3) nsig 解密（new Function）不在这里做——沙箱 iframe 由 popup 承载，
//    若塞进 YouTube 页面会被其 frame-src CSP 拦截，导致签名从未解密、下载到纯文本错误页。
(function () {
  let _pageResolver = null;

  function requestPageData(timeoutMs) {
    return new Promise((resolve) => {
      let last = { pr: null, jsUrl: null };
      let settled = false;

      function finish(v) {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        clearTimeout(t);
        if (_pageResolver === onData) _pageResolver = null;
        resolve(v || last);
      }
      function onData(d) {
        last = d;
        if (d.pr && d.pr.streamingData) finish(d);
      }

      _pageResolver = onData;
      const timer = setInterval(() => window.postMessage({ __yt_dl_req__: true }, "*"), 400);
      window.postMessage({ __yt_dl_req__: true }, "*");
      const t = setTimeout(() => finish(null), timeoutMs);
    });
  }

  window.addEventListener("message", function (e) {
    const d = e.data;
    if (!d) return;

    if (d.__yt_dl_data__) {
      if (_pageResolver) _pageResolver(d.__yt_dl_data__);
      return;
    }
    if (d.__yt_dl_client_data__ && _clientResolver) {
      _clientResolver(d.__yt_dl_client_data__);
      return;
    }
    if (typeof d.__yt_dl_data_json__ === "string") {
      let obj;
      try { obj = JSON.parse(d.__yt_dl_data_json__); }
      catch (err) { obj = { pr: null, jsUrl: null }; }
      if (_pageResolver) _pageResolver(obj);
    }
  });

  // 让「页面主世界」去请求其他 InnerTube 客户端（绕 web 客户端 PO Token），再取回 playerResponse
  let _clientResolver = null;
  function requestClientViaPage(client, timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      // 注意：全局监听器路由过来的是【内层 payload】（{pr, jsUrl, error}），不是原始 message 事件
      function onPayload(p) {
        if (!p || typeof p !== "object") return;
        if (p.pr === undefined && p.error === undefined) return; // 尚不是客户端响应
        settled = true;
        clearTimeout(t);
        _clientResolver = null;
        resolve({ ok: !!p.pr, error: p.error || null, pr: p.pr, jsUrl: p.jsUrl || null });
      }
      _clientResolver = onPayload;
      window.postMessage({ __yt_dl_client_req__: true, client: client }, "*");
      const t = setTimeout(() => {
        if (!settled) {
          _clientResolver = null;
          resolve({ ok: false, error: "页面客户端请求超时（" + timeoutMs + "ms）" });
        }
      }, timeoutMs);
    });
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "GET_VIDEO") {
      (async () => {
        try {
          const data = await requestPageData(5000);
          const pr = data && data.pr;
          const jsUrl = (data && data.jsUrl) || null;

          if (!pr || !pr.streamingData) {
            sendResponse({ ok: false, error: "当前不是 YouTube 视频页或视频不可用（请确认在 /watch 视频页并刷新后再试）" });
            return;
          }

          const parsed = ParseYT.parseFormats(pr);
          ParseYT.normalizeCiphers(parsed.formats);

          parsed.playerJsUrl = jsUrl; // 交给 popup 用于解密 n / sig 签名
          parsed.ytcfg = (data && data.ytcfg) || null; // 换客户端绕过 PO Token 时用
          parsed.gvs = (data && data.gvs) || null; // 页面播放器捕获的 GVS URL 与 PO Token
          sendResponse({ ok: true, data: parsed });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
      })();
      return true; // 异步响应
    }

    if (msg.type === "GET_CLIENT_VIDEO") {
      (async () => {
        try {
          const res = await requestClientViaPage(msg.client, 8000);
          if (!res.ok || !res.pr) {
            sendResponse({ ok: false, error: res.error || "客户端请求无数据" });
            return;
          }
          const parsed = ParseYT.parseFormats(res.pr);
          ParseYT.normalizeCiphers(parsed.formats);
          parsed.playerJsUrl = res.jsUrl;
          parsed.ytcfg = msg.ytcfg || null;
          // web_safari 等客户端返回的 HLS 清单（免 PO Token 的高清来源）
          parsed.hlsManifestUrl =
            (res.pr.streamingData && res.pr.streamingData.hlsManifestUrl) || null;
          sendResponse({ ok: true, data: parsed });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
      })();
      return true; // 异步响应
    }

    return false;
  });
})();
