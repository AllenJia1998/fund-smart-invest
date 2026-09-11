/**
 * 部署期配置。
 *
 * 本项目的部署形态是「前后端分离」：
 *   - 前端（纯静态）→ GitHub Pages
 *   - 后端（Node 服务，含 LLM 调用与数据抓取）→ 本机 + Cloudflare 隧道
 *
 * 因为 GitHub Pages 只能托管静态文件、无法运行后端，所以前端需要知道后端地址。
 * 这里按访问来源自动切换：
 *   - 通过 *.github.io 访问  → 走后端隧道地址
 *   - 本地 / 局域网访问      → 走同源（后端自己就把前端一起托管了）
 *
 * 部署后如需临时改地址或填访问口令，点页面左下角「⚙ 连接设置」即可，
 * 会保存在浏览器 localStorage，无需重新部署。
 */
(function () {
  // ↓ 后端隧道地址，隧道重启后会变化，重新部署或改这里即可
  var REMOTE_BACKEND = 'https://frozen-gst-revolutionary-weight.trycloudflare.com';

  var onGithubPages = /\.github\.io$/i.test(location.hostname);
  window.__API_BASE__ = onGithubPages ? REMOTE_BACKEND : '';
})();
