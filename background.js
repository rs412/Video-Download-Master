// background.js — MV3 service worker：
// 1) 管理 offscreen 合并文档生命周期（单例）：popup 发 MERGE_START → 转发 MERGE_JOB；
// 2) 保存：offscreen 没有 chrome.downloads API，合并完成后发 MERGE_SAVE（带 blob URL），
//    这里调 chrome.downloads 落盘，监听 onChanged，完成后广播 MERGE_DONE / MERGE_FAIL，
//    并关闭 offscreen 释放内存（blob URL 随之销毁）。

let _creating = null;
let _closeTimer = null;
let _mergeBusy = false;
let _biliJob = false; // 当前任务是 B 站后台下载（完成后要撤掉 DNR Referer 规则）
let _iqiyiJob = false; // 当前任务是爱奇艺后台下载（完成后要撤掉 DNR Referer 规则）
const REFERER_RULE_ID = 9901;

// 通用「站点 CDN 伪装」：给**扩展自身**发出的 CDN 请求注入页面 Referer、去掉 Origin。
// 很多视频站 CDN（bilivideo、爱奇艺 cache.video.iqiyi.com 等）只认站点来源，
// 扩展 origin 的 fetch 会被 403/405 拒绝。条件 initiatorDomains 锁定扩展自身，
// 不影响页面自己的请求。
async function setRefererRule(hosts, referer) {
  const list = (hosts || []).filter(Boolean).map((h) =>
    String(h).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") // 正则元字符转义
  );
  if (!list.length || !referer) return false;
  const condition = {
    initiatorDomains: [chrome.runtime.id],
    resourceTypes: ["xmlhttprequest"]
  };
  // hosts 含通配 "*" → 不限制目标 host（腾讯等分片 CDN 跨多域名，统一加 Referer）
  if (!(list.length === 1 && list[0] === "\\*")) {
    condition.regexFilter = "^https?://([a-z0-9-]+\\.)*(" + list.join("|") + ")/";
  }
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [REFERER_RULE_ID],
    addRules: [{
      id: REFERER_RULE_ID,
      priority: 1,
      condition: condition,
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          { header: "Referer", operation: "set", value: referer },
          { header: "Origin", operation: "remove" }
        ]
      }
    }]
  });
  return true;
}

function clearRefererRule() {
  chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [REFERER_RULE_ID]
  }).catch(() => {});
}

// B 站专用：bilivideo / akamaized CDN
async function setBiliRefererRule() {
  await setRefererRule(["bilivideo\\.com", "akamaized\\.net"], "https://www.bilibili.com/");
}

async function ensureOffscreen() {
  let has = false;
  try { has = await chrome.offscreen.hasDocument(); } catch (e) {}
  if (has) return;
  if (_creating) { await _creating; return; }
  _creating = chrome.offscreen.createDocument({
    url: "offscreen/merge.html",
    reasons: ["BLOBS"],
    justification: "在后台合并音视频流为单个 mp4 文件并保存下载"
  });
  try { await _creating; } finally { _creating = null; }
}

function closeOffscreen(delayMs) {
  clearTimeout(_closeTimer);
  _closeTimer = setTimeout(() => {
    _closeTimer = null;
    chrome.offscreen.closeDocument().catch(() => {});
  }, delayMs || 0);
}

// ---- webRequest 观察级嗅探（猫抓同款，但比猫抓更宽：记录全部非静态请求）----
// 关键点：腾讯的清单 URL 常常既没有 .m3u8 字样、Content-Type 也不是 mpegurl，
// 只靠 URL/CT 猜必然漏（历史诊断：清单 0 / 分片 4）。所以这里把**所有**非静态资源请求
// 连同 Content-Type 与 Content-Length 一起录下来，交给弹窗按「响应内容」判定，
// 而不是在这里下结论。代价是候选变多，收益是再也不会漏掉播放器真正拉的那条清单。
const _wrMedia = new Map(); // tabId -> [{url, kind, ct, cl, t}]；-1 为跨标签页全局桶（worker 请求兜底）
// MV3 service worker 闲置 ~30 秒会被杀，内存嗅探结果全丢——猫抓的做法是每次抓到即写
// chrome.storage.session，SW 重启后回灌内存。不持久化就会出现「播放时抓到了、点下载时全没了」。
const WR_STORAGE_KEY = "vdm_wr_media";
let _wrLoaded = false;
async function _wrPersist() {
  try {
    const plain = [];
    _wrMedia.forEach(function (arr, tabId) {
      for (const it of arr) plain.push([tabId, it]);
    });
    await chrome.storage.session.set({ [WR_STORAGE_KEY]: plain.slice(-600) });
  } catch (e) {}
}
// 现在记录的是「全部非静态请求」，量大——每次请求都写 storage 会拖慢页面，做 800ms 防抖。
// （SW 仍可能被杀，所以额外在 visibility/pagehide 时用同步式兜底：SW 无页面事件，
//   这里改用定时 5 秒落一次盘，保证最多丢 5 秒内的记录。）
let _wrPersistTimer = null;
function _wrPersistSoon() {
  if (_wrPersistTimer) return;
  _wrPersistTimer = setTimeout(() => { _wrPersistTimer = null; _wrPersist(); }, 800);
}
setInterval(() => { if (_wrPersistTimer) { clearTimeout(_wrPersistTimer); _wrPersistTimer = null; _wrPersist(); } }, 5000);
async function _wrHydrate() {
  if (_wrLoaded) return;
  try {
    const o = await chrome.storage.session.get(WR_STORAGE_KEY);
    const plain = o && o[WR_STORAGE_KEY];
    if (Array.isArray(plain)) {
      for (const [tabId, it] of plain) {
        const arr = _wrMedia.get(tabId) || [];
        if (!arr.some((x) => x.url === it.url)) arr.push(it);
        _wrMedia.set(tabId, arr);
      }
    }
  } catch (e) {}
  _wrLoaded = true;
}
// kind 只做「粗分」用于排序：真清单可能是任何 kind（含 other）
function _wrClassify(u, ct) {
  const p = String(u).split(/[?#]/)[0];
  const ext = ((p.match(/\.([a-z0-9]{2,5})$/i) || [])[1] || "").toLowerCase();
  const ctl = String(ct || "").toLowerCase();
  if (/m3u8/i.test(u) || /mpegurl/i.test(ctl) || /dash\+xml/i.test(ctl)) return "m3u8";
  if (/^(video|audio)\//i.test(ctl)) return "seg";
  if (/\.(ts|m4s|f4v|mp4|m4a|aac|flv|mkv|webm|mov)$/.test(ext)) return "seg";
  return "other";
}
function _wrPush(tabId, item) {
  const arr = _wrMedia.get(tabId) || [];
  for (let i = 0; i < arr.length; i++) {
    if (arr[i].url === item.url) { arr[i].t = item.t; arr[i].ct = item.ct || arr[i].ct; return; }
  }
  arr.push(item);
  // 播放器若用 Web Worker（腾讯的 txhlsjs-kernel 就是），请求会落到 -1 全局桶，量更大。
  const CAP = tabId === -1 ? 800 : 320;
  while (arr.length > CAP) {
    // 淘汰顺序：先丢「大响应」（分片/媒体，成百上千条且不需要留全），
    // 再丢 other，m3u8 永不淘汰。清单被误分成 other 又很小，绝不能先丢它——
    // 上一版按 kind 淘汰，把小体积的 other（真清单）先挤掉了，这是漏抓的关键。
    let idx = arr.findIndex((x) => x.kind === "seg" || (x.cl && x.cl > 200000));
    if (idx < 0) idx = arr.findIndex((x) => x.kind === "other");
    if (idx < 0) idx = arr.findIndex((x) => x.kind === "m3u8");
    if (idx < 0) idx = 0;
    arr.splice(idx, 1);
  }
  _wrMedia.set(tabId, arr);
  _wrPersistSoon(); // 防抖写穿到 session storage（fire-and-forget）
}
chrome.webRequest.onResponseStarted.addListener(function (data) {
  try {
    const u = String(data.url || "");
    if (!/^https?:/i.test(u)) return;
    const ty = String(data.type || "");
    // 静态资源与文档本身一律不录（量大且绝不可能是清单）
    if (["image", "stylesheet", "script", "font", "ping", "csp_report", "main_frame"].indexOf(ty) >= 0) return;
    if (typeof data.statusCode === "number" && data.statusCode >= 400) return;
    let ct = "", cl = 0;
    (data.responseHeaders || []).forEach(function (h) {
      const n = String(h.name || "").toLowerCase();
      if (n === "content-type") ct = String(h.value || "");
      else if (n === "content-length") cl = parseInt(h.value, 10) || 0;
    });
    const item = { url: u, kind: _wrClassify(u, ct), ct: ct, cl: cl, t: Date.now() };
    _wrPush(data.tabId, item);
    if (data.tabId !== -1) _wrPush(-1, item); // 全局桶兜底（跨标签页/worker）
  } catch (e) {}
}, { urls: ["<all_urls>"] }, ["responseHeaders"]);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return false;

  // 弹窗查询 webRequest 嗅探结果（播放器真实请求，含 worker/iframe 一切来源）
  if (msg.type === "GET_WR_MEDIA") {
    (async () => {
      await _wrHydrate(); // SW 可能重启过，先从 session storage 回灌
      const own = _wrMedia.get(msg.tabId) || [];
      const glob = _wrMedia.get(-1) || [];
      sendResponse({ ok: true, items: own.concat(glob) });
    })();
    return true; // 异步应答
  }

  if (msg.type === "MERGE_START") {
    (async () => {
      try {
        // offscreen 一次只能跑一个任务；忙时明确拒绝，避免任务被静默丢弃
        if (_mergeBusy) {
          sendResponse({ ok: false, error: "已有后台合并任务进行中，请等它完成" });
          return;
        }
        await ensureOffscreen();
        clearTimeout(_closeTimer); // 取消挂起的关闭，防止任务发给将死的文档
        _mergeBusy = true;
        chrome.runtime.sendMessage({
          type: "MERGE_JOB",
          videoUrl: msg.videoUrl,
          audioUrl: msg.audioUrl,
          name: msg.name
        }).catch(() => {});
        sendResponse({ ok: true });
      } catch (e) {
        _mergeBusy = false;
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  // 通用：为「当前站点 + 该媒体资源所在 host」安装 Referer 伪装规则
  // （爱奇艺 / 腾讯 / 优酷等 CDN 常因 Origin 不合法返回 403/405）
  if (msg.type === "SET_REFERER_RULE") {
    (async () => {
      try {
        const ok = await setRefererRule(msg.hosts, msg.referer);
        sendResponse({ ok: !!ok });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  if (msg.type === "CLEAR_REFERER_RULE") {
    clearRefererRule();
    sendResponse({ ok: true });
    return true;
  }

  // B 站后台下载：popup 发起 → 这里注入 DNR Referer 规则 → offscreen 拉轨+合并 →
  // 走 MERGE_SAVE 落盘。弹窗和页面都可以关闭（offscreen 文档独立存活）。
  if (msg.type === "BILI_BG_DOWNLOAD") {
    (async () => {
      try {
        if (_mergeBusy) {
          sendResponse({ ok: false, error: "已有后台任务进行中，请等它完成" });
          return;
        }
        await setBiliRefererRule();
        await ensureOffscreen();
        clearTimeout(_closeTimer);
        _mergeBusy = true;
        _biliJob = true;
        chrome.runtime.sendMessage({
          type: "BILI_BG_JOB",
          video: msg.video,
          audio: msg.audio || null,
          name: msg.name
        }).catch(() => {});
        sendResponse({ ok: true });
      } catch (e) {
        _mergeBusy = false;
        _biliJob = false;
        clearRefererRule();
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  // 爱奇艺后台下载：popup 发起（已用纯 MD5 换到逐分片直链）→ 注入 DNR Referer 规则 →
  // offscreen 逐片下载并合并成完整 TS → 走 MERGE_SAVE 落盘。弹窗和页面都可关闭。
  if (msg.type === "IQIYI_BG_DOWNLOAD") {
    (async () => {
      try {
        if (_mergeBusy) {
          sendResponse({ ok: false, error: "已有后台任务进行中，请等它完成" });
          return;
        }
        await setRefererRule(msg.hosts || ["iqiyi.com"], msg.referer || "https://www.iqiyi.com/");
        await ensureOffscreen();
        clearTimeout(_closeTimer);
        _mergeBusy = true;
        _iqiyiJob = true;
        chrome.runtime.sendMessage({
          type: "IQIYI_BG_JOB",
          segments: msg.segments,
          totalBytes: msg.totalBytes || 0,
          name: msg.name
        }).catch(() => {});
        sendResponse({ ok: true });
      } catch (e) {
        _mergeBusy = false;
        _iqiyiJob = false;
        clearRefererRule();
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  // offscreen 合并完成，blob URL 已就绪 → 由这里（有 downloads API）落盘
  if (msg.type === "MERGE_SAVE") {
    chrome.downloads.download(
      { url: msg.url, filename: msg.name || "video.mp4", saveAs: false },
      (dlId) => {
        if (chrome.runtime.lastError || !dlId) {
          const err = (chrome.runtime.lastError && chrome.runtime.lastError.message) || "下载任务创建失败";
          _mergeBusy = false;
          if (_biliJob || _iqiyiJob) { _biliJob = _iqiyiJob = false; clearRefererRule(); }
          chrome.runtime.sendMessage({ type: "MERGE_FAIL", error: err }).catch(() => {});
          closeOffscreen(500);
          return;
        }
        const listener = (d) => {
          if (d.id !== dlId || !d.state) return;
          if (d.state.current === "complete") {
            chrome.downloads.onChanged.removeListener(listener);
            _mergeBusy = false;
            if (_biliJob || _iqiyiJob) { _biliJob = _iqiyiJob = false; clearRefererRule(); }
            chrome.runtime.sendMessage({ type: "MERGE_DONE", name: msg.name }).catch(() => {});
            closeOffscreen(1000);
          } else if (d.state.current === "interrupted") {
            chrome.downloads.onChanged.removeListener(listener);
            _mergeBusy = false;
            if (_biliJob || _iqiyiJob) { _biliJob = _iqiyiJob = false; clearRefererRule(); }
            chrome.runtime.sendMessage({ type: "MERGE_FAIL", error: "文件保存中断" }).catch(() => {});
            closeOffscreen(500);
          }
        };
        chrome.downloads.onChanged.addListener(listener);
      }
    );
    return false;
  }

  // offscreen 出错 → 广播给 popup 并关闭释放资源
  if (msg.type === "MERGE_FAIL") {
    _mergeBusy = false;
    if (_biliJob || _iqiyiJob) { _biliJob = _iqiyiJob = false; clearRefererRule(); }
    closeOffscreen(500);
  }

  // 强制注入 content.js + media-main.js：MV3 偶尔会因为 service worker 重启 / 扩展热更
  // 让 tab 里的 content script 丢失（chrome.tabs.sendMessage 失败），由 popup 主动 inject。
  if (msg.type === "REINJECT_CONTENT") {
    (async () => {
      try {
        if (typeof msg.tabId !== "number") {
          sendResponse({ ok: false, error: "缺少 tabId" });
          return;
        }
        // 1) 隔离世界：parse.js + content.js
        await chrome.scripting.executeScript({
          target: { tabId: msg.tabId },
          files: ["lib/parse.js", "content.js"]
        });
        // 2) 主世界：media-main.js（嗅探 + B 站适配器都依赖它）
        await chrome.scripting.executeScript({
          target: { tabId: msg.tabId, frameIds: [0] },
          files: ["media-main.js"],
          world: "MAIN"
        });
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  return false;
});
