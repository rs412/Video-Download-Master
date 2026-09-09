// merge.js — 音视频合并：视频流文件（fMP4/webm）+ 音轨文件（m4a/opus）→ 单个 mp4。
// 纯 remux（转封装，不重新编码）：用 mediabunny 的 EncodedPacketSink 逐包读出编码数据，
// 经 EncodedVideoPacketSource / EncodedAudioPacketSource 写进 Mp4OutputFormat。
// 这就是 ffmpeg -i v -i a -c copy 的浏览器内等价物。依赖 window.mediabunny（vendor/mediabunny-global.js）。
(function (global) {
  function ready() {
    if (global.mediabunny) return Promise.resolve(global.mediabunny);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("mediabunny 库未加载")), 8000);
      global.addEventListener("mediabunny-ready", () => {
        clearTimeout(t);
        resolve(global.mediabunny);
      }, { once: true });
    });
  }

  // 迭代读取一个轨道的全部编码包，按序写入 packetSource；onProg(0~1) 按播放时长汇报进度
  async function pumpPackets(track, packetSource, decoderConfig, onProg) {
    const { EncodedPacketSink } = global.mediabunny;
    const sink = new EncodedPacketSink(track);
    const duration = (await track.computeDuration()) || 0;
    let first = true;
    for await (const packet of sink.packets()) {
      // 首包必须带 decoderConfig（含 codec/description 等，输出文件据此构造 moov）
      await packetSource.add(packet, first ? { decoderConfig: decoderConfig } : undefined);
      first = false;
      if (onProg && duration) onProg(Math.min(1, packet.timestamp / duration));
    }
  }

  // 带进度的分片并发下载（多连接绕开 googlevideo 单流限速，对标 aria2/IDM）：
  // 总大小取直链 clen 参数（googlevideo 自带），按 8MB 分片、6 连发；onProg(0~1) 按已完成字节汇报
  async function fetchBlobWithProgress(url, onProg) {
    let total = 0;
    try { total = parseInt(new URL(url).searchParams.get("clen"), 10) || 0; } catch (e) {}

    // 兜底：URL 没有 clen 时用 Range 探测总大小
    if (!total) {
      const pr = await fetch(url, { headers: { Range: "bytes=0-1" } });
      const cr = pr.headers.get("content-range"); // "bytes 0-1/123456"
      if (cr && cr.indexOf("/") >= 0) total = parseInt(cr.split("/")[1], 10) || 0;
      if (!total) return await (await fetch(url)).blob();
    }

    const CHUNK = 8 * 1024 * 1024;
    const CONC = 6;
    const parts = Math.max(1, Math.ceil(total / CHUNK));
    const bufs = new Array(parts);
    let doneBytes = 0;
    let nextPart = 0;

    async function worker() {
      for (;;) {
        const i = nextPart++;
        if (i >= parts) return;
        const start = i * CHUNK;
        const end = Math.min(total, start + CHUNK) - 1;
        // 每片最多 3 次重试（6 连发下网络抖动/限流很常见，单次失败不该毁掉整个任务）
        let lastErr = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const resp = await fetch(url, { headers: { Range: "bytes=" + start + "-" + end } });
            if (!resp.ok) throw new Error("HTTP " + resp.status);
            bufs[i] = await resp.arrayBuffer();
            lastErr = null;
            break;
          } catch (e) {
            lastErr = e;
          }
        }
        if (lastErr) throw new Error("分片下载失败（第 " + (i + 1) + "/" + parts + " 片，重试 3 次后放弃）：" + lastErr.message);
        doneBytes += end - start + 1;
        if (onProg) onProg(Math.min(0.99, doneBytes / total));
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONC, parts) }, worker));
    return new Blob(bufs, { type: "video/mp4" });
  }

  // mergeAv(videoUrl, audioUrl, onStage) → Blob (video/mp4)
  async function mergeAv(videoUrl, audioUrl, onStage) {
    const M = await ready();
    const {
      Input, Output, ALL_FORMATS, Mp4OutputFormat, BufferTarget,
      BlobSource, EncodedVideoPacketSource, EncodedAudioPacketSource
    } = M;
    const report = (p, msg) => { if (onStage) onStage(p, msg); };

    report(0.01, "下载视频流…");
    const videoBlob = await fetchBlobWithProgress(videoUrl, (p) =>
      report(0.01 + 0.49 * p, "下载视频流 " + Math.round(p * 100) + "%…")
    );
    report(0.52, "下载音轨…");
    const audioBlob = await fetchBlobWithProgress(audioUrl, (p) =>
      report(0.52 + 0.18 * p, "下载音轨 " + Math.round(p * 100) + "%…")
    );

    const vInput = new Input({ formats: ALL_FORMATS, source: new BlobSource(videoBlob) });
    const aInput = new Input({ formats: ALL_FORMATS, source: new BlobSource(audioBlob) });
    const vTrack = await vInput.getPrimaryVideoTrack();
    const aTrack = await aInput.getPrimaryAudioTrack();
    if (!vTrack) throw new Error("视频流中未找到视频轨");
    if (!aTrack) throw new Error("音轨中未找到音频轨");

    const codecOf = async (t) => {
      if (t.codec) return t.codec;
      if (typeof t.getCodec === "function") return await t.getCodec();
      throw new Error("无法识别轨道编码");
    };
    const vCodec = await codecOf(vTrack); // 'avc' | 'hevc' | 'vp9' | 'av1'
    const aCodec = await codecOf(aTrack); // 'aac' | 'opus'
    const vConfig = await vTrack.getDecoderConfig();
    const aConfig = await aTrack.getDecoderConfig();

    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: "in-memory" }),
      target: new BufferTarget()
    });
    const vSource = new EncodedVideoPacketSource(vCodec);
    const aSource = new EncodedAudioPacketSource(aCodec);
    output.addVideoTrack(vSource);
    output.addAudioTrack(aSource);
    await output.start();

    report(0.72, "封装视频轨…");
    await pumpPackets(
      vTrack, vSource, vConfig,
      (p) => report(0.72 + 0.15 * p, "封装视频轨 " + Math.round(p * 100) + "%…")
    );
    report(0.88, "封装音轨…");
    await pumpPackets(
      aTrack, aSource, aConfig,
      (p) => report(0.88 + 0.07 * p, "封装音轨 " + Math.round(p * 100) + "%…")
    );

    report(0.96, "生成 mp4 容器…");
    await output.finalize();
    report(1, "完成");

    const buffer = output.target.buffer;
    if (!buffer || !buffer.byteLength) throw new Error("合并结果为空");
    return new Blob([buffer], { type: "video/mp4" });
  }

  global.YTMerge = { mergeAv: mergeAv, ready: ready };
})(window);
