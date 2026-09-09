// mediabunny-global.js — module 桥：把 ESM 构建的 mediabunny 挂到 window 上，
// 供 popup.js（经典脚本）以 window.mediabunny 使用。popup.html 里以 type="module" 引入本文件。
import * as M from "./mediabunny.min.mjs";
window.mediabunny = M;
window.dispatchEvent(new Event("mediabunny-ready"));
