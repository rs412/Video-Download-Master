// hls.js — HLS(m3u8) 下载器：解析清单 → 并发下载分段 → 顺序拼接为 Blob。
// 用途：web_safari 客户端返回的 HLS 是「预合并音视频」的 fMP4 流，免 GVS PO Token，
//      且 init 段(#EXT-X-MAP) + media 段顺序拼接即为完整可播放 mp4，无需 ffmpeg。
// 新增：支持 AES-128 加密 HLS（优酷等站点），按 #EXT-X-KEY 自动下载 key 并解密。
// 注意：整个文件在内存中拼接，超长视频（>1 小时 1080p）可能占用数百 MB 内存。
(function (global) {
  async function fetchText(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.text();
  }

  async function fetchBuf(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.arrayBuffer();
  }

  function hexToBuf(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
    }
    return bytes;
  }

  // HLS 默认 IV：16 字节，低 32 位为大端 sequence number
  function seqToIv(seq) {
    const buf = new Uint8Array(16);
    const view = new DataView(buf.buffer);
    view.setUint32(12, seq >>> 0, false);
    return buf;
  }

  function parseKeyLine(line, baseUrl) {
    // #EXT-X-KEY:METHOD=AES-128,URI="...",IV=0x...
    const method = /METHOD=([^,\s]+)/.exec(line);
    const uri = /URI="([^"]+)"/.exec(line);
    if (!method || !uri) return null;
    return {
      method: method[1].toUpperCase(),
      url: new URL(uri[1], baseUrl).href,
      ivHex: (function () {
        const m = /IV=0x([0-9a-fA-F]+)/.exec(line);
        return m ? m[1] : null;
      })()
    };
  }

  // 解析清单：若是 master playlist 则选分辨率最高的 variant 并拉取其 media playlist。
  // 返回 { height, initUrl, segments[], hosts[], keyInfo, baseUrl, mediaSequence }
  // hosts 是 init + segment + key 全部 URL 的 host 集合（master playlist 解析时也合并 variant 的 host），
  // 让上层给它们也装上 Referer 伪装（HLS 分片/CDN/key 服务器经常和 m3u8 URL 跨域）。
  async function resolveBestVariant(manifestUrl) {
    const allHosts = new Set();
    const addHost = (u) => {
      if (!u) return;
      try { const h = new URL(u).hostname; if (h) allHosts.add(h); } catch (e) {}
    };
    let base = manifestUrl;
    let text = await fetchText(base);
    let height = 0;
    addHost(base);

    if (/#EXT-X-STREAM-INF/.test(text)) {
      const lines = text.split("\n");
      let best = null;
      for (let i = 0; i < lines.length; i++) {
        const L = lines[i].trim();
        if (!L.startsWith("#EXT-X-STREAM-INF")) continue;
        const res = /RESOLUTION=(\d+)x(\d+)/.exec(L);
        const bw = /BANDWIDTH=(\d+)/.exec(L);
        const uri = (lines[i + 1] || "").trim();
        if (!uri || uri.startsWith("#")) continue;
        const h = res ? parseInt(res[2], 10) : 0;
        if (!best || h > best.h || (h === best.h && bw && best.bw && parseInt(bw[1], 10) > best.bw)) {
          best = { h: h, bw: bw ? parseInt(bw[1], 10) : 0, uri: uri };
        }
      }
      if (!best) throw new Error("master m3u8 中未找到可用流");
      const variantAbs = new URL(best.uri, base).href;
      addHost(variantAbs);
      base = variantAbs;
      height = best.h;
      text = await fetchText(base);
    }

    const lines = text.split("\n");
    let initUrl = null;
    let keyInfo = null;
    let mediaSequence = 0;
    const segs = [];
    for (let i = 0; i < lines.length; i++) {
      const L = lines[i].trim();
      if (!L) continue;
      if (L.startsWith("#")) {
        if (L.startsWith("#EXT-X-MAP")) {
          const m = /URI="([^"]+)"/.exec(L);
          if (m) {
            initUrl = new URL(m[1], base).href;
            addHost(initUrl);
          }
        } else if (L.startsWith("#EXT-X-KEY")) {
          keyInfo = parseKeyLine(L, base);
          if (keyInfo) addHost(keyInfo.url);
        } else if (L.startsWith("#EXT-X-MEDIA-SEQUENCE")) {
          const m = /:(\d+)/.exec(L);
          if (m) mediaSequence = parseInt(m[1], 10) || 0;
        }
        continue;
      }
      const segUrl = new URL(L, base).href;
      addHost(segUrl);
      segs.push(segUrl);
    }
    if (!segs.length) throw new Error("m3u8 中未找到媒体分段");
    return {
      height: height,
      initUrl: initUrl,
      segments: segs,
      hosts: Array.from(allHosts),
      keyInfo: keyInfo,
      baseUrl: base,
      mediaSequence: mediaSequence
    };
  }

  // 并发下载全部分段（保序），onProgress(done, total)
  async function download(info, onProgress, concurrency) {
    const CONC = concurrency || 6;
    const out = new Array(info.segments.length);
    let done = 0;
    let idx = 0;

    let cryptoKey = null;
    let fixedIv = null;
    if (info.keyInfo) {
      if (info.keyInfo.method !== "AES-128") {
        throw new Error("不支持的 HLS 加密方式：" + info.keyInfo.method);
      }
      const keyBuf = await fetchBuf(info.keyInfo.url);
      if (keyBuf.byteLength !== 16) throw new Error("AES-128 key 长度异常：" + keyBuf.byteLength);
      cryptoKey = await crypto.subtle.importKey(
        "raw", keyBuf, { name: "AES-CBC" }, false, ["decrypt"]
      );
      fixedIv = info.keyInfo.ivHex ? hexToBuf(info.keyInfo.ivHex) : null;
    }

    async function worker() {
      while (idx < info.segments.length) {
        const i = idx++;
        let r;
        try {
          r = await fetch(info.segments[i]);
        } catch (e) {
          throw new Error("分段 " + (i + 1) + " fetch 失败：" + ((e && e.message) || e));
        }
        if (!r.ok) throw new Error("分段 " + (i + 1) + " 下载失败 HTTP " + r.status);
        let buf = await r.arrayBuffer();
        if (cryptoKey) {
          const iv = fixedIv || seqToIv((info.mediaSequence || 0) + i);
          try {
            buf = await crypto.subtle.decrypt({ name: "AES-CBC", iv: iv }, cryptoKey, buf);
          } catch (e) {
            throw new Error("分段 " + (i + 1) + " 解密失败：" + ((e && e.message) || e));
          }
        }
        out[i] = buf;
        done++;
        if (onProgress) onProgress(done, info.segments.length);
      }
    }

    const parts = [];
    if (info.initUrl) {
      const r = await fetch(info.initUrl);
      if (!r.ok) throw new Error("init 段下载失败 HTTP " + r.status);
      parts.push(await r.arrayBuffer());
    }
    await Promise.all(new Array(Math.min(CONC, info.segments.length)).fill(0).map(worker));
    for (const b of out) parts.push(b);
    return new Blob(parts, { type: "video/mp4" });
  }

  global.YTHls = { resolveBestVariant: resolveBestVariant, download: download };
})(window);
