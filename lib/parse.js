// parse.js — 解析 ytInitialPlayerResponse 的 streamingData 与元数据
// 字段设计对齐 yt-dlp：vcodec/acodec、fps、filesize（精确或按码率估算）、字幕轨、章节、详情。
(function (global) {
  function int(v) {
    const n = parseInt(v, 10);
    return isNaN(n) ? 0 : n;
  }

  // mimeType 形如：video/mp4; codecs="avc1.4d401f, mp4a.40.2"
  function splitCodecs(mime) {
    const m = /codecs="([^"]+)"/.exec(mime || "");
    const list = m ? m[1].split(",").map((s) => s.trim()) : [];
    let vcodec = null;
    let acodec = null;
    for (const c of list) {
      if (/^(avc|vp0?9|av01|hvc1|hev1|theora|mpeg4)/i.test(c)) vcodec = c;
      else if (/^(mp4a|opus|vorbis|flac|aac|mp3)/i.test(c)) acodec = c;
    }
    return { vcodec: vcodec, acodec: acodec };
  }

  function parseFormats(playerResponse) {
    const sd = playerResponse.streamingData || {};
    const vd = playerResponse.videoDetails || {};
    const duration = int(vd.lengthSeconds);
    const out = [];

    function push(f, kind) {
      const mime = f.mimeType || "";
      const co = splitCodecs(mime);
      // progressive 格式（如 itag 18）mime 是 video/mp4 但含音轨，
      // 因此必须同时看 codecs 里的 acodec，否则会被误判为「无声视频流」。
      const hasVideo = /video\//.test(mime) || !!co.vcodec;
      const hasAudio = /audio\//.test(mime) || !!f.audioQuality || !!co.acodec;

      // 文件大小：优先精确值；缺失时按 (vbr+abr) × 时长 估算（yt-dlp 的 filesize_approx 思路）
      let size = int(f.contentLength);
      let approx = false;
      if (!size && duration > 0) {
        const br = int(f.bitrate) || (int(f.averageBitrate));
        if (br > 0) {
          size = Math.round((br / 8) * duration);
          approx = true;
        }
      }

      out.push({
        itag: f.itag,
        mimeType: mime,
        ext: extFromMime(mime),
        qualityLabel: f.qualityLabel || null,
        bitrate: int(f.bitrate),
        width: int(f.width),
        height: int(f.height),
        fps: int(f.fps),
        contentLength: int(f.contentLength) || null,
        filesize: size || null,
        filesizeApprox: approx,
        audioQuality: f.audioQuality || null,
        audioSampleRate: int(f.audioSampleRate) || null,
        audioChannels: int(f.audioChannels) || null,
        vcodec: co.vcodec,
        acodec: co.acodec,
        url: f.url || null,
        cipher: f.signatureCipher || f.cipher || null,
        type: kind,
        hasAudio: hasAudio,
        hasVideo: hasVideo
      });
    }

    (sd.formats || []).forEach((f) => push(f, "progressive"));
    (sd.adaptiveFormats || []).forEach((f) => push(f, "adaptive"));

    return {
      meta: buildMeta(playerResponse),
      formats: out
    };
  }

  function extFromMime(mime) {
    if (/video\/mp4/.test(mime)) return "mp4";
    if (/video\/webm/.test(mime)) return "webm";
    if (/video\/3gpp/.test(mime)) return "3gp";
    if (/audio\/mp4/.test(mime)) return "m4a";
    if (/audio\/webm/.test(mime)) return "weba";
    return "bin";
  }

  // 字幕轨：captions.playerCaptionsTracklistRenderer.captionTracks[]
  function parseCaptions(pr) {
    const tracks = [];
    try {
      const r = pr.captions && pr.captions.playerCaptionsTracklistRenderer;
      const list = (r && r.captionTracks) || [];
      for (const t of list) {
        let name = "";
        if (t.name) name = t.name.simpleText || (t.name.runs && t.name.runs[0] && t.name.runs[0].text) || "";
        tracks.push({
          baseUrl: t.baseUrl || null,
          languageCode: t.languageCode || "",
          name: name || t.languageCode,
          kind: t.kind || "",          // "asr" = 自动生成
          isTranslatable: !!t.isTranslatable
        });
      }
    } catch (e) {}
    return tracks;
  }

  // 章节：markersMap 中 key = DESCRIPTION_CHAPTERS
  function parseChapters(pr) {
    const out = [];
    try {
      const markersMap =
        pr.playerOverlays &&
        pr.playerOverlays.playerOverlayRenderer &&
        pr.playerOverlays.playerOverlayRenderer.decoratedPlayerBarRenderer &&
        pr.playerOverlays.playerOverlayRenderer.decoratedPlayerBarRenderer.playerBar &&
        pr.playerOverlays.playerOverlayRenderer.decoratedPlayerBarRenderer.playerBar
          .multiMarkersPlayerBarRenderer &&
        pr.playerOverlays.playerOverlayRenderer.decoratedPlayerBarRenderer.playerBar
          .multiMarkersPlayerBarRenderer.markersMap;
      if (Array.isArray(markersMap)) {
        for (const m of markersMap) {
          const v = m.value || {};
          if (m.key === "DESCRIPTION_CHAPTERS" && Array.isArray(v.chapters)) {
            for (const c of v.chapters) {
              let title = "";
              if (c.title) title = c.title.simpleText || (c.title.runs && c.title.runs[0] && c.title.runs[0].text) || "";
              out.push({
                title: title,
                startMs: int(c.timeRangeStartMillis)
              });
            }
          }
        }
      }
    } catch (e) {}
    return out;
  }

  function buildMeta(pr) {
    const vd = pr.videoDetails || {};
    const md = (pr.microformat && pr.microformat.playerMicroformatRenderer) || {};
    const thumbs = (vd.thumbnail && vd.thumbnail.thumbnails) || [];
    let thumb = null;
    if (thumbs.length) {
      let best = thumbs[0];
      for (const t of thumbs) {
        if ((t.width || 0) >= (best.width || 0)) best = t;
      }
      thumb = best.url || null;
    }

    return {
      title: vd.title || "",
      author: vd.author || "",
      channelId: vd.channelId || "",
      videoId: vd.videoId || "",
      lengthSeconds: int(vd.lengthSeconds),
      viewCount: int(vd.viewCount),
      keywords: vd.keywords || [],
      shortDescription: vd.shortDescription || "",
      publishDate: md.publishDate || "",
      uploadDate: md.uploadDate || "",
      category: md.category || "",
      isLive: !!vd.isLive,
      thumbnail: thumb,
      captions: parseCaptions(pr),
      chapters: parseChapters(pr)
    };
  }

  // 遗留 signatureCipher：拆出 url / s / sp。
  // 注意 s 是「加密后的签名」，必须先交给求解器（type:'sig'）解密再拼装，直接拼接必然 403。
  function normalizeCiphers(formats) {
    for (const f of formats) {
      if (!f.url && f.cipher) {
        const p = new URLSearchParams(f.cipher);
        f.url = p.get("url");
        f.sig = p.get("s") || null;
        f.sp = p.get("sp") || "signature";
      }
    }
    return formats;
  }

  global.ParseYT = { parseFormats: parseFormats, normalizeCiphers: normalizeCiphers };
})(window);
