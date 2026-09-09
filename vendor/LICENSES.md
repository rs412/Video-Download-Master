# 第三方组件许可声明（vendor/ 目录）

本目录内的第三方库均未修改（除个别文件顶部加了适配浏览器全局变量的桥接说明注释）。
各组件的来源、版本与许可证如下；相关许可证全文以各上游仓库发布文本为准。

| 文件 | 上游项目 | 版本 | 许可证 | 来源 |
|---|---|---|---|---|
| `meriyah.umd.js` | [meriyah](https://github.com/meriyah/meriyah) | 4.3.9 | MIT | 官方 UMD 构建（该构建未内嵌许可头，特此声明） |
| `astring.global.js` | [astring](https://github.com/davidbonnet/astring) | — | MIT | 官方构建的 CJS→全局桥接 shim |
| `yt.solver.core.js` | [yt-dlp/ejs](https://github.com/yt-dlp/yt-dlp) 生成 | — | Unlicense（文件内含 SPDX 标识） | yt-dlp 官方工具自动生成，本仓库含少量适配性修改（文件内以 `LOCAL PATCH` 注释标明） |
| `mediabunny.min.mjs` | [mediabunny](https://github.com/Vanilagy/mediabunny) | 1.56.0 | MPL-2.0（文件头内嵌声明） | 官方 ESM 构建，未修改 |
| `mediabunny-global.js` | — | — | 同本仓库 LICENSE（MIT） | 本仓库自写的加载桥（非第三方代码，仅负责挂载上面的小写入口） |

## 许可证要点

- **MIT**（meriyah、astring）：允许自由使用、修改、分发，须保留版权与许可声明。
- **Unlicense**（yt.solver.core.js）：公共领域，无使用限制。
- **MPL-2.0**（mediabunny）：文件级 copyleft——该文件本身以 MPL-2.0 提供，只要保持该文件的源代码可获得（本仓库已满足），可与其他许可的代码组合分发。
