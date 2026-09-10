# NOVA 优选 · 电商商城演示站

一个现代、响应式的电商商城静态站点，使用纯 HTML / CSS / JavaScript 构建，可直接部署到 GitHub Pages。

## 功能特性

- 🏠 首屏 Hero + 品牌介绍
- 🛍️ 商品网格 + 分类筛选（数码 / 家居 / 服饰 / 美妆 / 食品 / 运动）
- 🛒 购物车抽屉（本地存储持久化，支持数量增减、移除、合计）
- ✨ 服务保障、关于我们、订阅表单等模块
- 📱 完全响应式，适配手机 / 平板 / 桌面
- ⚡ 零依赖、零构建，纯静态文件

## 本地预览

直接用任意静态服务器打开即可，例如：

```bash
python3 -m http.server 8080
# 然后访问 http://localhost:8080
```

## 部署到 GitHub Pages

1. 在 GitHub 新建一个空仓库（例如 `nova-shop`）
2. 推送代码：

```bash
git init
git add .
git commit -m "init: nova shop site"
git remote add origin git@github.com:AllenJia1998/nova-shop.git
git push -u origin main
```

3. 在仓库 **Settings → Pages** 中，将 Source 设为 `main` 分支、根目录 `/`
4. 稍等片刻，即可通过 `https://AllenJia1998.github.io/nova-shop/` 访问

## 目录结构

```
.
├── index.html        # 首页
├── css/style.css     # 样式
├── js/main.js        # 交互逻辑
└── README.md
```
