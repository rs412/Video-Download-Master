// sandbox.js — 沙箱 iframe（manifest 声明 sandbox allow-scripts + unsafe-eval）。
// 采用 yt-dlp 官方 JSC 求解器（vendor/yt.solver.core.js，Unlicense）计算 nsig：
//   meriyah 解析 player AST → 用 ('alr','yes') 调用指纹定位 nsig 函数 → astring 生成 → new Function 执行。
//
// ⚠ 关键修复：yt-dlp 求解器的初始化片段里有
//     if (typeof URL === "undefined") { globalThis.location = {...} }
//     else { globalThis.location = new URL("https://www.youtube.com/watch?v=yt-dlp-wins") }
//   这在 node/deno（无 location）里无害，但在浏览器沙箱 iframe 中会命中 window.location 的
//   导航 setter —— iframe 立刻跳转，脚本上下文被销毁，解密结果永远回不来，
//   表现为「所有格式都签名未解密」。
//   解法：包一层 Function 构造器，把该赋值改写成 var 声明。var 会提升到生成程序的函数作用域，
//   于是 player 代码里所有 location 引用都解析到这个局部变量，既躲开导航，又保留 youtube.com 语义。
(function () {
  var _RealFunction = Function;
  globalThis.Function = function () {
    var args = [];
    for (var i = 0; i < arguments.length; i++) {
      var a = arguments[i];
      args.push(
        typeof a === "string"
          ? a.replace(/(?:globalThis|window|self|top)\.location\s*=/g, "var location =")
          : a
      );
    }
    return _RealFunction.apply(_RealFunction, args);
  };

  // 同一 player 复用预处理结果，避免重复解析数 MB 的 player JS
  var _cache = { url: null, preprocessed: null };

  function solve(playerJs, playerUrl, nList, sigList) {
    const requests = [
      { type: "n", challenges: nList },
      { type: "sig", challenges: sigList }
    ];
    let out;
    if (_cache.url === playerUrl && _cache.preprocessed) {
      out = jsc({
        type: "preprocessed",
        preprocessed_player: _cache.preprocessed,
        requests: requests
      });
    } else {
      out = jsc({
        type: "player",
        player: playerJs,
        output_preprocessed: true,
        requests: requests
      });
      if (out && out.preprocessed_player) {
        _cache = { url: playerUrl, preprocessed: out.preprocessed_player };
      }
    }
    const rn = out && out.responses && out.responses[0];
    const rs = out && out.responses && out.responses[1];
    return {
      n: rn && rn.type === "result" ? rn.data : null,
      sig: rs && rs.type === "result" ? rs.data : null,
      nErr: rn && rn.type !== "result" ? String(rn.error) : null,
      sigErr: rs && rs.type !== "result" ? String(rs.error) : null
    };
  }

  window.addEventListener("message", function (e) {
    var d = e.data;
    if (!d || d.__yt_nsig__ === undefined) return;
    var req = d.__yt_nsig__;
    var reqId = req.reqId;

    function reply(payload) {
      try {
        parent.postMessage({ __yt_nsig_res__: payload }, "*");
      } catch (err) {
        /* 父页面已关闭 */
      }
    }

    try {
      if (typeof jsc !== "function") {
        throw new Error("yt-dlp 求解器未加载（vendor 脚本缺失？）");
      }
      if (!req.playerJs || req.playerJs.length < 1000) {
        throw new Error("player JS 无效（长度 " + (req.playerJs || "").length + "）");
      }
      var r = solve(
        req.playerJs,
        req.url,
        req.challenges || [],
        req.sigChallenges || []
      );
      // 注意：即使部分成功也要回传错误原文。
      // 空挑战数组求解结果是 {}（truthy），只靠 ok/data 判断会把失败吞掉。
      reply({
        reqId: reqId,
        ok: true,
        data: r.n || {},
        sigData: r.sig || {},
        nErr: r.nErr,
        sigErr: r.sigErr,
        diag: {
          playerLen: req.playerJs.length,
          // 求解器靠 ('alr','yes') 调用指纹定位 nsig 函数；
          // 若玩家 JS 不含该指纹，说明抓到的文件不对或指纹已变更。
          hasFingerprint: /["']alr["']\s*,\s*["']yes["']/.test(req.playerJs),
          nCount: (req.challenges || []).length,
          sigCount: (req.sigChallenges || []).length
        }
      });
    } catch (err) {
      reply({
        reqId: reqId,
        ok: false,
        error: String((err && err.message) || err)
      });
    }
  });

  // 通知父页面（popup）沙箱已就绪
  parent.postMessage({ __yt_nsig_ready__: true }, "*");
})();
