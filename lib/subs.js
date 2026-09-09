// subs.js — 字幕获取与格式转换（对标 yt-dlp --write-subs / --convert-subs）
// YouTube 的 timedtext 接口用 &fmt=json3 返回结构化数据，再本地转成 srt / vtt / 纯文本。
(function (global) {
  function pad(n, w) {
    let s = String(Math.floor(n));
    while (s.length < w) s = "0" + s;
    return s;
  }

  function msToSrt(ms) {
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return pad(h, 2) + ":" + pad(m, 2) + ":" + pad(s, 2) + "," + pad(ms % 1000, 3);
  }

  function msToVtt(ms) {
    return msToSrt(ms).replace(",", ".");
  }

  function msToClock(ms) {
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return (h > 0 ? pad(h, 2) + ":" : "") + pad(m, 2) + ":" + pad(s, 2);
  }

  function decodeEntities(t) {
    return String(t)
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, " ");
  }

  // json3 → [{start, end, text}]
  function json3ToCues(json) {
    const cues = [];
    let cursor = 0;
    const events = (json && json.events) || [];
    for (const e of events) {
      if (!e.segs) continue;
      const start = typeof e.tStartMs === "number" ? e.tStartMs : cursor;
      const dur = typeof e.dDurationMs === "number" ? e.dDurationMs : 0;
      cursor = start + dur;

      let text = "";
      for (const s of e.segs) {
        if (s.utf8 == null) continue;
        text += s.aAppend ? s.utf8 : s.utf8;
      }
      text = decodeEntities(text).replace(/\n{3,}/g, "\n\n").trim();
      if (!text) continue;
      cues.push({ start: start, end: start + dur, text: text });
    }
    return cues;
  }

  function toSrt(cues) {
    return cues
      .map((c, i) => (i + 1) + "\n" + msToSrt(c.start) + " --> " + msToSrt(c.end) + "\n" + c.text + "\n")
      .join("\n");
  }

  function toVtt(cues) {
    return "WEBVTT\n\n" + cues
      .map((c) => msToVtt(c.start) + " --> " + msToVtt(c.end) + "\n" + c.text + "\n")
      .join("\n");
  }

  function toTxt(cues) {
    return cues.map((c) => c.text).join("\n");
  }

  function toLrc(cues) {
    // LRC 只到百分秒，够听歌用
    const lines = ["[offset:0]"];
    for (const c of cues) {
      const m = Math.floor(c.start / 60000);
      const s = Math.floor((c.start % 60000) / 1000);
      const cs = Math.floor((c.start % 1000) / 10);
      lines.push("[" + pad(m, 2) + ":" + pad(s, 2) + "." + pad(cs, 2) + "]" + c.text.replace(/\n/g, " "));
    }
    return lines.join("\n");
  }

  // 章节 → YouTube 章节文本（对标 --write-chapters 的可见输出）
  function chaptersToText(chapters) {
    return chapters
      .map((c) => msToClock(c.startMs) + " " + c.title)
      .join("\n");
  }

  // 拉取字幕：baseUrl + &fmt=json3 → 转成指定格式
  async function fetchSubtitle(baseUrl, fmt) {
    if (!baseUrl) throw new Error("字幕轨无地址");
    const u = new URL(baseUrl);
    u.searchParams.set("fmt", "json3");
    const r = await fetch(u.toString());
    if (!r.ok) throw new Error("字幕下载失败：HTTP " + r.status);
    const json = await r.json();
    const cues = json3ToCues(json);
    if (!cues.length) throw new Error("该字幕轨无内容（可能未生成）");

    let text;
    let ext;
    if (fmt === "vtt") { text = toVtt(cues); ext = "vtt"; }
    else if (fmt === "txt") { text = toTxt(cues); ext = "txt"; }
    else if (fmt === "lrc") { text = toLrc(cues); ext = "lrc"; }
    else { text = toSrt(cues); ext = "srt"; }
    return { text: text, ext: ext, count: cues.length };
  }

  global.YTSubs = {
    fetchSubtitle: fetchSubtitle,
    chaptersToText: chaptersToText,
    json3ToCues: json3ToCues
  };
})(window);
