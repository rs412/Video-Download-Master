// background.js — MV3 service worker：
// 1) 管理 offscreen 合并文档生命周期（单例）：popup 发 MERGE_START → 转发 MERGE_JOB；
// 2) 保存：offscreen 没有 chrome.downloads API，合并完成后发 MERGE_SAVE（带 blob URL），
//    这里调 chrome.downloads 落盘，监听 onChanged，完成后广播 MERGE_DONE / MERGE_FAIL，
//    并关闭 offscreen 释放内存（blob URL 随之销毁）。

let _creating = null;
let _closeTimer = null;
let _mergeBusy = false;

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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return false;

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

  // offscreen 合并完成，blob URL 已就绪 → 由这里（有 downloads API）落盘
  if (msg.type === "MERGE_SAVE") {
    chrome.downloads.download(
      { url: msg.url, filename: msg.name || "video.mp4", saveAs: false },
      (dlId) => {
        if (chrome.runtime.lastError || !dlId) {
          const err = (chrome.runtime.lastError && chrome.runtime.lastError.message) || "下载任务创建失败";
          _mergeBusy = false;
          chrome.runtime.sendMessage({ type: "MERGE_FAIL", error: err }).catch(() => {});
          closeOffscreen(500);
          return;
        }
        const listener = (d) => {
          if (d.id !== dlId || !d.state) return;
          if (d.state.current === "complete") {
            chrome.downloads.onChanged.removeListener(listener);
            _mergeBusy = false;
            chrome.runtime.sendMessage({ type: "MERGE_DONE", name: msg.name }).catch(() => {});
            closeOffscreen(1000);
          } else if (d.state.current === "interrupted") {
            chrome.downloads.onChanged.removeListener(listener);
            _mergeBusy = false;
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
    closeOffscreen(500);
  }
  return false;
});
