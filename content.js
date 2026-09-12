// content.js — 隔离世界「消息中枢」：接收 popup 请求 → 向主世界索取播放数据 → 回传原始格式。
// 分工原则：
// 1) 消息监听留在隔离世界（world:"MAIN" 的脚本收不到 popup 的 sendMessage）。
// 2) 读页面全局变量靠 world:"MAIN" 的 main.js，用 window.postMessage 桥接（非脚本，不受 CSP 限制）。
// 3) nsig 解密（new Function）不在这里做——沙箱 iframe 由 popup 承载，
//    若塞进 YouTube 页面会被其 frame-src CSP 拦截，导致签名从未解密、下载到纯文本错误页。
(function () {
  // 防重复注入：manifest 规则可能同时匹配同一页面，重复注册监听器会导致消息被处理两次
  if (window.__vdm_content_injected__) return;
  window.__vdm_content_injected__ = true;

  let _pageResolver = null;
  let _mediaResolver = null;

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
    if (d.__vdm_media__) {
      if (_mediaResolver) {
        _mediaResolver(d.__vdm_media__);
        _mediaResolver = null;
      }
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

  // 通用媒体嗅探：向主世界的 media-main.js 索取捕获到的媒体 URL 列表
  function requestMedia(timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      function onList(arr) {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        clearInterval(timer);
        _mediaResolver = null;
        resolve(Array.isArray(arr) ? arr : []);
      }
      _mediaResolver = onList;
      window.postMessage({ __vdm_req__: true }, "*");
      // 页面可能还没播（无媒体请求），重复索取一段时间以便捕获后到的
      const timer = setInterval(() => window.postMessage({ __vdm_req__: true }, "*"), 600);
      const t = setTimeout(() => onList([]), timeoutMs);
    });
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // 仅顶层 frame 应答扩展消息：iframe 里的 content.js 抢答会污染站点判定
    // （tabs.sendMessage 不带 frameId 会广播到所有 frame，先回包者赢）
    if (window !== window.top) return;
    // 通用站点：返回嗅探到的媒体列表
    if (msg.type === "GET_MEDIA") {
      (async () => {
        try {
          const list = await requestMedia(msg.timeout || 2500);
          sendResponse({
            ok: true,
            media: list,
            page: { title: document.title || "", url: location.href, host: location.hostname }
          });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
      })();
      return true;
    }

    // B 站 durl 下载：主世界在 page origin 拉段拼接（带 SESSDATA + referrer），
    // ArrayBuffer transfer 回本脚本 → blob URL → chrome.downloads 保存
    if (msg.type === "BILI_DURL_DOWNLOAD") {
      const id = "__bili_" + Date.now() + "_" + Math.floor(Math.random() * 1e6);
      const onMsg = (ev) => {
        const d = ev.data;
        if (!d || d.__vdm_id__ !== id) return;
        if (d.__vdm_durl_done__) {
          window.removeEventListener("message", onMsg);
          if (d.error) { sendResponse({ ok: false, error: d.error }); return; }
          try {
            const blob = new Blob([d.buffer], { type: "video/x-flv" });
            const url = URL.createObjectURL(blob);
            chrome.downloads.download(
              { url: url, filename: msg.filename || "video.flv", saveAs: !!msg.saveAs },
              (dlId) => {
                setTimeout(() => URL.revokeObjectURL(url), 60000);
                if (chrome.runtime.lastError) sendResponse({ ok: false, error: chrome.runtime.lastError.message });
                else sendResponse({ ok: true, downloadId: dlId });
              }
            );
          } catch (e) {
            sendResponse({ ok: false, error: e.message });
          }
        }
      };
      window.addEventListener("message", onMsg);
      window.postMessage({ __vdm_durl_req__: true, __vdm_id__: id, durls: msg.durls }, "*");
      return true;
    }

    // B 站 dash 视频/音轨逐段下载：主世界在 page origin 拉各片（带 SESSDATA + referrer），
    // 每个片段 transferable ArrayBuffer 回传 → 拼为 fMP4 Blob → 返 blob URL 给 popup
    // 通用「主世界分片下载」：任何站点的 DASH/HLS 分片只要扩展页 fetch 被拒
    // （403/405/跨域 Origin 白名单），都下沉到页面主世界拉（带站点 cookie + referrer）。
    // BILI_DASH_TRACK_DOWNLOAD 是历史名字，保留兼容。
    if (msg.type === "BILI_DASH_TRACK_DOWNLOAD" || msg.type === "MAIN_TRACK_DOWNLOAD") {
      const id = "__bili_dash_" + Date.now() + "_" + Math.floor(Math.random() * 1e6);
      const kind = msg.kind || "video"; // video / audio（仅用于 popup 进度文案）
      const parts = [];   // index → ArrayBuffer
      const mime = msg.mime || "video/mp4";
      let total = (msg.initSpec ? 1 : 0) + (msg.segments ? msg.segments.length : 0);
      let done = false;
      const onMsg = (ev) => {
        const d = ev.data;
        if (!d || d.__vdm_id__ !== id) return;
        if (done) return;
        if (d.__vdm_bili_dash_track_part__) {
          // 按 index 落位，避免乱序到达时也兼容
          parts[d.index] = d.buffer;
          return;
        }
        if (d.__vdm_bili_dash_track_prog__) {
          // 实时进度 → 转发给 popup（fire-and-forget；popup 未监听时静默失败）
          try {
            chrome.runtime.sendMessage({
              type: "BILI_DASH_PROGRESS",
              kind: kind,
              done: d.done,
              total: d.total,
              bytes: d.bytes || 0,
              contentLength: d.contentLength || 0
            }).catch(() => {});
          } catch (e) {}
          return;
        }
        if (d.__vdm_bili_dash_track_done__) {
          done = true;
          window.removeEventListener("message", onMsg);
          if (!d.ok) {
            sendResponse({ ok: false, error: d.error || "B 站 dash track 下载失败" });
            return;
          }
          try {
            const blob = new Blob(parts.filter(Boolean), { type: mime });
            const url = URL.createObjectURL(blob);
            // 回报 size：上层可据此判断「是不是只拿到一份错误响应」（如 1KB 的 JSON）
            sendResponse({ ok: true, blobUrl: url, size: blob.size });
          } catch (e) {
            sendResponse({ ok: false, error: e.message });
          }
        }
      };
      window.addEventListener("message", onMsg);
      window.postMessage({
        __vdm_bili_dash_track_req__: true,
        __vdm_id__: id,
        initSpec: msg.initSpec || null,
        segments: msg.segments || []
      }, "*");
      return true;
    }

    // 爱奇艺：取 tvid（主世界读播放器全局变量 / DOM，兜底拉加速器脚本）
    // popup 不读页面 DOM，需经此桥接；拿到 tvid 后由 popup 用纯 MD5 签名换片源直链。
    if (msg.type === "IQ_GET_TVID") {
      const id = "__iq_tvid_" + Date.now() + "_" + Math.floor(Math.random() * 1e6);
      const onMsg = (ev) => {
        const d = ev.data;
        if (!d || d.__vdm_iq_tvid_res__ !== true) return;
        if (d.__vdm_id__ !== id) return;
        window.removeEventListener("message", onMsg);
        if (d.error) { sendResponse({ ok: false, error: d.error }); return; }
        sendResponse({ ok: true, tvid: d.tvid });
      };
      window.addEventListener("message", onMsg);
      window.postMessage({ __vdm_iq_tvid_req__: true, __vdm_id__: id }, "*");
      return true;
    }

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
