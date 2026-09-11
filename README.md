# 基金智投 · FundSmartInvest

一个自建的**基金投研终端**：实时基金行情 + DeepSeek Agent 对话 + 每日智能推送。
零第三方 Node 依赖，深色专业金融终端界面。

```
┌──────────────┬─────────────────────────────────────────────┐
│  基金智投     │  行情看板  ·  AI 对话  ·  每日推送              │
│  ─────────   │                                             │
│  📊 行情看板  │   实时净值 / 盘中估值 / 走势图 / 涨跌幅榜        │
│  💬 AI 对话   │   DeepSeek Agent（工具 · 技能 · 知识库 · OCR）   │
│  🔔 每日推送  │   资讯聚合 → 持仓诊断 → 趋势预测                 │
└──────────────┴─────────────────────────────────────────────┘
```

---

## 一、快速开始

```bash
cd /Users/allenjia/learnEco

# 1. 配置 DeepSeek API Key（三选一）
#    a) 环境变量：export DEEPSEEK_API_KEY=sk-xxx
#    b) 项目根目录创建 .env（参考 .env.example）
#    c) 若本机装有 DeepSeek Harness，会自动复用 ~/.dsh/.credentials.yaml
cp .env.example .env && vi .env

# 2. 启动（无需 npm install，零依赖）
npm start
#    → http://127.0.0.1:5399

# 3. 可选：导入知识库种子文档
npm run seed
```

打开 http://127.0.0.1:5399 即为行情看板；左侧可切换 `AI 对话` 与 `每日推送`。

---

## 二、三大模块

### 1. 行情看板（`/`）

- **实时行情**：批量拉取自选基金的当日单位净值、累计净值、日涨跌幅；交易时段内优先使用**盘中估值**（GSZ/GSZZL），盘后回落到最新净值口径，界面上标注当前采用的哪一种。
- **净值走势图**：手写 SVG 折线图（无图表库），支持 **7天 / 1月 / 3月 / 6月 / 1年 / 3年** 六个区间切换，带面积渐变、网格、悬停十字线与数据提示框。
- **主题分类**：按 混合 / 消费 / 医疗 / 煤炭 / 科技 / 电力 / 红利 / 黄金 筛选，每个分类显示基金数量。
- **涨跌幅榜**：右侧展示自选池内今日涨幅 Top5 与跌幅 Top5（红涨绿跌，符合中国市场惯例）。
- **自选管理**：搜索基金代码或名称（如输入"白酒"）加入自选，卡片悬停可移除。

### 2. AI 对话（`/chat.html`）

一个完整的 **Agent harness**，不只是套壳调用模型：

| 能力 | 实现 |
|---|---|
| **流式输出** | 基于 SSE 的逐字流式渲染，实时重渲染 Markdown |
| **工具调用** | 8 个 Function Calling 工具，Agent 自主决定调用顺序并多轮推理后作答 |
| **技能挂载** | `skills/*/SKILL.md`，可在界面上开关；挂载后指令注入系统提示 |
| **知识库** | 本地 TF-IDF 检索（中英文 2-gram 分词），命中片段自动注入上下文 |
| **图片解读** | macOS Vision 框架 OCR（Swift 原生二进制），中英文识别 |
| **文档解读** | DOCX / XLSX 走内置 ZIP 解析器；PDF 走流式解压 + 文本算子提取；纯文本直接解码 |
| **会话管理** | 多会话持久化，历史对话可回溯 |

内置可调用的工具：

```
search_fund          按名称/代码搜索基金
get_fund_quote       批量实时行情（净值、涨跌幅、盘中估值）
get_fund_history     历史净值序列 + 多周期涨幅
get_fund_detail      基金详情（类型/规模/经理/风险等级/投资策略）
get_fund_ranking     全市场涨幅榜 / 跌幅榜
get_financial_news   实时财经快讯与政策公告
search_knowledge     本地知识库检索
calculate            安全表达式求值（收益率、复利、仓位计算）
```

### 3. 每日推送（`/push.html`）

- **资讯聚合**：并行抓取 东方财富 7×24 快讯 / 新浪财经滚动 / 沪深公告，去重后按 政策·宏观·市场·行业·国际 五维自动分类。
- **持仓诊断**：把每只自选基金的实时净值 + 多周期涨幅 + 近 10 日净值序列，与当日资讯一并交给分析模型。
- **结构化产出**：市场综述、逐只基金的 `操作建议 / 置信度 / 理由 / 短期展望 / 中长期展望`、综合操作总结表、整体仓位建议、结论与免责声明。
- **数据回填**：报告中所有数值字段由后端用真实行情覆盖，模型只负责判断与文字，避免数值幻觉。
- **定时任务**：内置极简 cron（默认工作日 14:10，`PUSH_CRON` 可配），也可在界面上手动生成。

---

## 三、数据源说明（重要）

### 关于支付宝 · 蚂蚁财富接口

需求要求接入蚂蚁财富接口。实测结论如下：

```
$ curl -s -o /dev/null -w "%{http_code}" "https://fundmobapi.alipay.com/fundprod/fund/Detail.json?fundCode=000001"
000                      # 连接失败
$ nslookup fundmobapi.alipay.com
                         # 无解析结果（公网 DNS 层不可达）
```

**`fundmobapi.alipay.com` 在公网 DNS 层面无法解析**，因此无法直接调用。

项目的处理方式：

1. **数据源做成可插拔 Provider**（`server/providers/`），业务代码不感知具体源。
2. 实现了完整的 **`antfortune` Provider**（`providers/antfortune.js`），包含 Detail / NetValueTrend / RankList / Search 四个接口的对接与字段映射。
3. 启动时自动探测可达性，**不可达则降级到 `eastmoney` Provider**，并把降级事实暴露在接口与界面上（`/api/funds/source`、侧边栏底部、看板右下角），不做静默伪装。
4. 若在可访问蚂蚁财富的网络环境（内网代理 / 出口白名单），设置 `FUND_PROVIDER=antfortune` 即可切换，无需改动任何业务代码。

### 关于数据口径

`eastmoney`（天天基金/东方财富）与蚂蚁财富展示的基金净值**同源**，都是基金公司披露的官方净值数据，因此切换数据源不会改变净值口径。

使用的公开接口（均无需鉴权）：

| 接口 | 用途 |
|---|---|
| `fundmobapi.eastmoney.com/FundMNewApi/FundMNFInfo` | 批量实时行情 |
| `fundmobapi.eastmoney.com/FundMNewApi/FundMNDetailInformation` | 基金详情 |
| `fund.eastmoney.com/pingzhongdata/{code}.js` | 完整历史净值 + 区间收益 |
| `fund.eastmoney.com/data/rankhandler.aspx` | 排行榜 |
| `fundsuggest.eastmoney.com/FundSearch/...` | 基金搜索 |
| `newsapi.eastmoney.com/kuaixun/...` | 7×24 快讯 |
| `feed.mix.sina.com.cn/api/roll/get` | 新浪财经滚动新闻 |
| `np-anotice-stock.eastmoney.com/api/security/ann` | 沪深公告 |

### 关于模型能力边界

DeepSeek 公开 API 目前仅支持 `deepseek-flash` 与 `deepseek-v4-pro`，**不支持图片输入**（发送图片会得到 `[Unsupported Image]`）。

因此图片解读不走模型视觉通道，而是由 **harness 侧补齐**：

- 图片 → `tools/ocr/ocr-bin`（Swift + macOS Vision 框架编译的原生二进制，支持 zh-Hans / en-US）→ 文本 → 交给模型解读。
- 该二进制由 `npm run ocr` 编译（`tools/ocr/build.sh`）。脚本把 Swift 模块缓存重定向到仓库内，以适配受限沙箱。

---

## 四、目录结构

```
learnEco/
├── server/
│   ├── index.js              # HTTP 服务入口（零依赖）
│   ├── config.js             # 配置与凭据解析
│   ├── lib/
│   │   ├── http.js           # 请求体/JSON/SSE/静态文件/上游抓取
│   │   ├── router.js         # 极简路由器
│   │   └── store.js          # JSON 持久化 + TTL 缓存
│   ├── providers/
│   │   ├── index.js          # 数据源选择与降级
│   │   ├── eastmoney.js      # 天天基金（当前生效）
│   │   └── antfortune.js     # 支付宝蚂蚁财富（可插拔）
│   ├── services/
│   │   ├── llm.js            # DeepSeek 客户端（流式 / 工具 / JSON 模式）
│   │   ├── agent.js          # Agent 执行器（harness 核心）
│   │   ├── tools.js          # 工具注册表
│   │   ├── skills.js         # 技能挂载
│   │   ├── kb.js             # 知识库（TF-IDF 检索）
│   │   ├── extract.js        # OCR + 文档解析
│   │   ├── funds.js          # 基金业务服务
│   │   ├── news.js           # 资讯聚合
│   │   └── push.js           # 每日推送与定时任务
│   └── routes/               # funds / chat / push / kb / system
├── public/
│   ├── index.html            # 行情看板
│   ├── chat.html             # AI 对话
│   ├── push.html             # 每日推送
│   ├── css/app.css           # 设计系统
│   └── js/{app,dashboard,chat,push}.js
├── skills/                   # 可挂载技能（SKILL.md）
│   ├── fund-analysis/
│   ├── risk-control/
│   └── attachment-reading/
├── knowledge/                # 知识库种子文档
├── tools/ocr/                # Swift OCR 源码 + 编译产物
├── scripts/seed-kb.js
└── data/                     # 运行时数据（会话/报告/知识库索引）
```

---

## 五、API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/status` | 系统状态（模型、数据源、OCR、技能、工具、知识库） |
| GET | `/api/funds/dashboard` | 看板聚合（自选行情 + 分类 + 涨跌幅榜） |
| GET | `/api/funds/source` | 数据源健康与降级状态 |
| GET | `/api/funds/search?q=` | 基金搜索 |
| GET | `/api/funds/:code` | 基金详情 |
| GET | `/api/funds/:code/series?range=` | 净值序列（7d/1m/3m/6m/1y/3y） |
| GET | `/api/funds/ranking?dir=&limit=` | 全市场排行榜 |
| GET/POST | `/api/watchlist` | 自选列表 / 添加 |
| DELETE | `/api/watchlist/:code` | 移除自选 |
| GET | `/api/news?limit=&category=` | 资讯聚合 |
| GET | `/api/skills` · POST `/api/skills/:name/mount` | 技能列表 / 挂载开关 |
| GET | `/api/tools` | 工具清单 |
| GET/POST | `/api/kb` · DELETE `/api/kb/:id` | 知识库管理 |
| GET/POST | `/api/sessions` · GET/DELETE `/api/sessions/:id` | 会话管理 |
| POST | `/api/chat` | **SSE 流式对话**（支持附件） |
| GET | `/api/push/reports` · GET/DELETE `/api/push/reports/:id` | 报告列表 / 详情 |
| POST | `/api/push/generate` | **SSE 生成报告**（带进度） |

---

## 六、配置项

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `DEEPSEEK_API_KEY` | — | 必填（或放 `.env`） |
| `DEEPSEEK_MODEL` | `deepseek-flash` | 对话主模型 |
| `DEEPSEEK_ANALYST_MODEL` | `deepseek-v4-pro` | 投研分析模型 |
| `FUND_PROVIDER` | `eastmoney` | 行情数据源 |
|  `PORT` | `5399` | 服务端口 |
| `PUSH_CRON` | `10 14 * * 1-5` | 定时生成日报 |
| `QUOTE_TTL_MS` | `20000` | 行情缓存时长 |

---

## 七、已知限制

1. **蚂蚁财富接口不可达**（见第三节），当前使用同源的天天基金数据；Provider 已实现，网络可达时改配置即可切换。
2. **无视觉模型通道**：图片解读依赖本机 macOS Vision OCR，非 macOS 环境需替换 `tools/ocr/` 实现。
3. **PDF 仅支持文本层**：扫描件 PDF 无文本层，需先转图片再走 OCR。
4. **数据为演示级**：未做用户体系、鉴权与并发限流，仅供本地单机使用。
5. **投资建议由 AI 生成**，仅供参考，不构成投资建议。

---

## 八、免责声明

本项目为技术演示。所有行情与资讯来自公开接口，投资建议由 AI 基于公开数据生成，
**仅供参考，不构成任何投资建议**。基金投资有风险，历史业绩不代表未来表现，入市需谨慎。

---

## 九、公网部署（前后端分离）

### 为什么必须分离

**GitHub Pages 只能托管静态文件，无法运行任何服务端代码。** 本站的 AI 对话、资讯聚合、
定时任务、数据持久化都依赖 Node 后端，因此无法整体部署到 GitHub Pages。

采用的方案是前后端分离：

```
┌─────────────────────────────┐         ┌──────────────────────────────────┐
│  GitHub Pages（静态前端）    │  HTTPS  │  本机 Node 后端                   │
│  allenjia1998.github.io/    │ ─CORS─▶ │  + Cloudflare 隧道（公网入口）     │
│  fund-smart-invest/         │         │  LLM 调用 / 数据抓取 / 持久化      │
└─────────────────────────────┘         └──────────────────────────────────┘
```

- 前端 `public/` 通过 `git subtree` 推到 `gh-pages` 分支
- 后端由 `cloudflared` 快速隧道暴露为公网 HTTPS 地址
- 前端 `public/js/config.js` 里按访问来源自动切换后端地址：
  `*.github.io` 走隧道地址，本地/局域网走同源

### 一键部署

```bash
# 1. 启动后端 + 公网隧道（首次会自动下载 cloudflared）
bash scripts/tunnel.sh
#    → 输出形如 https://xxx-xxx-xxx-xxx.trycloudflare.com

# 2. 把前端推到 GitHub Pages，并自动写入后端地址
bash scripts/deploy-pages.sh
```

部署脚本会在推送前自检后端可达性，避免上线一个连不通的地址。

### ⚠️ 快速隧道的重要限制

Cloudflare 快速隧道（`trycloudflare.com`）**无需账号**，但：

| 限制 | 影响 |
|---|---|
| 地址每次重启都变 | 隧道重启后需重新执行 `deploy-pages.sh` |
| 进程关闭即失效 | 关掉终端或重启电脑后站点 API 不可用 |
| 无可用性保证 | Cloudflare 官方明示不适合生产环境 |

**要长期稳定在线**，需要换成以下之一：

1. **Cloudflare 命名隧道**：注册 Cloudflare 账号 + 一个域名（可用免费域名），
   地址固定，`cloudflared tunnel create` 后配置 DNS 即可
2. **PaaS 平台**（Render / Railway / Fly.io）：把后端整体部署上去，
   注意需要持久化磁盘（会话与报告落盘在 `data/`），并把 `PUSH_CRON` 定时任务交给平台调度
3. **自备 VPS**：`git clone` 后 `npm start`，用 Nginx 反代 + systemd 守护

### 访问控制

公网开放后，消耗 DeepSeek 额度的功能必须保护。当前的策略是**按接口粒度鉴权**：

| 接口 | 保护 |
|---|---|
| `GET /api/funds/*`、`GET /api/news`、`GET /api/status` | 公开（只读） |
| `POST /api/chat` | 🔐 口令 + 每 IP 每分钟 12 次 |
| `POST /api/push/generate` | 🔐 口令 + 每 IP 每小时 5 次 |
| `/api/sessions*`（会话内容） | 🔐 口令 |
| `POST /api/kb`、`DELETE /api/kb/:id`、技能挂载 | 🔐 口令 |

访问口令的解析优先级：

1. 环境变量 `ACCESS_CODE`
2. `.env` 文件中的 `ACCESS_CODE`
3. **未配置时自动生成**并持久化到 `data/access-code.txt`（重启不变），启动日志会打印

前端在首次调用受保护接口收到 401 时，会弹出「连接设置」引导输入口令，
口令保存在浏览器 `localStorage`，通过请求头 `X-Access-Code` 发送。

自定义限流阈值：`RATE_CHAT`（默认 12/分钟）、`RATE_REPORT`（默认 5/小时）。

### 跨域配置

默认 `CORS_ORIGINS=*`（允许任意来源）。若要收紧到只允许自己的 Pages 站点：

```bash
CORS_ORIGINS=https://allenjia1998.github.io npm start
```
