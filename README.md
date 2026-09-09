# Video Download Master for YouTube

一个纯前端的 Chrome / Edge (Manifest V3) 浏览器扩展：在 YouTube 视频页直接解析可用格式并下载，支持高清视频自动合并音轨、字幕导出、封面下载等，全程无需 ffmpeg 或任何外部服务。

> 仓库短名 `video-download-master`；扩展名中的 "for YouTube" 表示本工具仅支持 YouTube 页面，不支持其他网站。

> 本扩展不收集任何用户数据，不发起任何统计/埋点请求，所有解析、下载、合并均在本机浏览器内完成。

---

## ✨ 功能特性

- **多格式解析**：自动解密 YouTube 的签名参数（n / sig），列出当前视频全部可用格式
- **高清下载**：通过多 InnerTube 客户端回退（Vision OS → TV 降级版 → Web Embedded → Web Safari），绕开 web 客户端仅提供 360p 直链的 SABR 限制
- **自动合并音轨**：高清纯视频流下载后自动与最佳音轨（优先 AAC）remux 合并为单个 mp4——浏览器内转封装，无损、无需 ffmpeg
- **多连接分片下载**：8MB 分片、6 连发并发（aria2 / IDM 式），绕开 googlevideo 单流限速，每片自动重试
- **后台合并**：合并任务在 offscreen 后台页面执行，弹窗可以随时关闭，完成后自动保存
- **HLS 兜底**：直链不可用时自动切换 HLS 清单（预合并音视频流，逐段拼接为 mp4）
- **字幕导出**：支持 srt / vtt / lrc / txt 四种格式，可选语言
- **其他**：封面下载、metadata.json、章节信息、文件名模板、复制直链、一键最佳画质

## 📦 安装

### 安装方式：开发者模式加载

1. 下载本仓库（`Code` → `Download ZIP`，或 `git clone`）并解压；
2. 打开 Edge，地址栏输入 `edge://extensions`（Chrome 为 `chrome://extensions`）；
3. 打开左下角（Chrome 为右上角）**开发人员模式**；
4. 点击 **加载解压缩的扩展**，选择本仓库文件夹；
5. 打开任意 YouTube 视频页，点击工具栏扩展图标即可使用。

> 本扩展仅通过 GitHub 发布，不上架应用商店；更新请重新下载仓库后替换文件夹并重载扩展。

## 🚀 使用方法

1. 在 YouTube 视频页（`/watch?v=...`）点击扩展图标；
2. 等待解析完成（状态栏会显示数据源与直链检测结果）；
3. 点击需要的格式行「下载」：
   - **合并格式（360p）**：直接下载；
   - **纯视频流（720p/1080p 等）**：自动与音轨合并为单 mp4，期间可关闭弹窗；
   - **纯音频**：直接下载对应音轨文件；
4. 「最佳画质」「仅音频」「720p」等快捷按钮在顶部一排。

## ❓ 常见问题

**Q: 只有 360p？**
YouTube 已对 web 客户端启用 SABR 改版（高清流不再提供直链）。本扩展会自动切换客户端并探测直链，状态栏会显示决策路径。若所有客户端均被拒，会显示每个客户端的具体失败原因。

**Q: 高清下载速度慢 / 合并卡住？**
合并使用 6 连发分片下载，正常应接近浏览器直接下载的速度。请确认扩展为最新版本（早期版本为单连接，速度受限）。

**Q: VP9 格式合并后的 mp4 播放不了？**
个别播放器不支持 VP9-in-mp4 容器。想最大兼容性请选 H.264 (avc1) 或 AV1 标注的格式行。

**Q: 下载的直链过期了？**
googlevideo 直链由 YouTube 签发，有效期较短（数小时）。过期后刷新视频页重新解析即可。

## 🔧 技术架构

面向想阅读源码的同学：

- **三世界架构**：`content.js`（ISOLATED，消息中枢）↔ `main.js`（MAIN 主世界，读 `ytInitialPlayerResponse` / 发 InnerTube 请求 / 捕获 PO Token）↔ `sandbox.html`（解密 nsig）
- **nsig 求解器**：`vendor/yt.solver.core.js`（源自 yt-dlp 的 JS 求解器）+ meriyah 解析 player AST
- **InnerTube 多客户端**：`lib/clients.js` 移植 yt-dlp `INNERTUBE_CLIENTS` 当前定义（含 body 内 UA、SAPISIDHASH 签名头、干净 context 重建）
- **remux 合并**：`lib/merge.js` 基于 [mediabunny](https://github.com/Vanilagy/mediabunny) 的 `EncodedPacketSink` 双输入逐包转封装
- **后台任务**：`background.js`（service worker）管理 offscreen document 生命周期；offscreen 负责合并，下载保存交回 service worker（offscreen 无 `chrome.downloads` API）

## 📁 目录结构

```
├── manifest.json          # MV3 清单（最小权限：downloads/storage/activeTab/offscreen）
├── background.js          # service worker：offscreen 生命周期 + 下载保存
├── content.js             # ISOLATED 世界：消息中枢
├── main.js                # MAIN 世界：读页面数据 / InnerTube 请求 / PO Token 捕获
├── popup.html/js/css      # 弹窗 UI
├── sandbox.html/js        # nsig/签名解密（唯一允许 eval 的沙箱页）
├── lib/
│   ├── parse.js           # 格式解析与规范化
│   ├── clients.js         # InnerTube 多客户端定义（移植 yt-dlp）
│   ├── merge.js           # 分片并发下载 + mediabunny remux 合并
│   ├── hls.js             # HLS 清单解析与分段下载
│   └── subs.js            # 字幕解析（srt/vtt/lrc/txt）
├── offscreen/             # 后台合并工人页面
├── vendor/                # 第三方库（meriyah / astring / yt 求解器 / mediabunny）
├── icons/ + gen_icons.py  # 图标（由脚本生成，可复现）
```

## 📄 许可证

本项目自身代码以 [MIT License](LICENSE) 发布。

第三方组件保留其原有许可证（版本与来源详见 [vendor/LICENSES.md](vendor/LICENSES.md)）：

| 组件 | 用途 | 许可证 |
|---|---|---|
| [meriyah](https://github.com/meriyah/meriyah) | JS 解析器（nsig 求解） | MIT |
| [astring](https://github.com/davidbonnet/astring) | AST → JS 代码生成 | MIT |
| yt.solver.core.js | nsig 求解器（源自 [yt-dlp](https://github.com/yt-dlp/yt-dlp)） | Unlicense |
| [mediabunny](https://github.com/Vanilagy/mediabunny) | mp4 转封装 | MPL-2.0 |

---

## ⚠️ 免责声明（使用前必读）

1. **仅供学习交流与个人使用。** 本项目不托管、不分发、不缓存任何视频内容，仅对用户自己浏览器内已加载的数据做格式解析与转存。

2. **请尊重版权。** YouTube 上的内容版权归其各自权利人所有。使用本工具前，请确保你**拥有该内容的版权、已获权利人明确授权**，或该内容属于你所在司法辖区的合理使用范围。因违反第三方版权而产生的全部法律责任由使用者自行承担，与本项目作者无关。

3. **关于 YouTube 服务条款。** 通过非官方手段下载 YouTube 内容可能违反 [YouTube 服务条款](https://www.youtube.com/static?template=terms)。是否使用、如何使用由你自行判断并承担相应后果。

4. **禁止的用途。** 严禁将本工具用于：盗版与二次分发受版权保护的内容、批量爬取与商业转售、规避付费/DRM 等技术保护措施、任何违反法律法规的用途。

5. **无关联声明。** 本项目为独立开源工具，与 Google LLC、YouTube 及其关联公司**无任何隶属、合作或背书关系**。"YouTube" 名称与标识为其各自所有者的商标，本项目中的使用仅作描述性引用。

6. **按"现状"提供。** 本项目不提供任何明示或默示的担保。YouTube 前端与接口持续变化，本工具可能随时失效；作者不对因使用本工具导致的任何直接或间接损失负责。

7. **侵权处理。** 若你是权利人且认为本仓库内容侵犯了你的合法权益，请通过 Issue 联系，我们将及时处理。

**安装或使用本工具，即表示你已阅读、理解并同意上述全部条款。**
