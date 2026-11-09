# Anna Deck · AI 做 PPT

> 一道开放式工程题：基于 [Anna](https://staging.anna.partners) 平台，用 AI 做 PPT 的 App。
> 本仓库是 **Anna App** 的完整源码（manifest + 静态 SPA bundle），可直接 `anna-app publish` 发布到 Anna Staging 平台。

---

## 一、解题思路（设计决策）

这是一道"开放式工程题"，目标用户、功能、交互、输出形式、技术方案都开放。我的核心判断是：

1. **真正可用 > 演示效果**。很多"AI 做 PPT"产品只产出一段聊天文本或图片，用户拿不到能用的成品。本 App 的硬指标是：**生成后一键导出为真正的 `.pptx` 文件**，可用 PowerPoint / WPS / Keynote 直接打开并继续编辑。这是"可用"与"玩具"的分界线。
2. **额度友好 = 笔试成绩**。题目要求额度使用纳入评价。因此：
   - 整个大纲与内容用 **一次 `llm.complete` 调用** 以结构化 JSON 返回（而不是每页多次调用）；
   - 模型偏好设为 **costPriority 最高**，自动走平台最便宜的可用模型；
   - **AI 配图默认关闭**，仅在用户主动开启且最多 3 张（封面 + 分节页），显式提示"消耗较多额度"；
   - 预览、逐页编辑、重新排版全部在本地完成，**不消耗任何额度**；只有"AI 生成"才调用模型。
3. **纯 UI App，不打包 Executa**。Anna 的宿主已内置 `llm.*` / `image.*` / `storage.*` Host API，App 无需自带后端进程即可调用，**更简单、更省额度、发布更轻**。
4. **中文体验优先**，同时支持英文等多语言（由用户输入语言决定）。

### 目标用户
需要快速产出演示文稿的人：学生、职场汇报、融资路演、销售、研究者。

### 功能范围
- 输入主题/大纲，选择 语言 / 页数(5–15) / 风格模板 / 语气受众
- AI 自动规划结构、撰写每页标题+要点+演讲备注（单次 LLM 调用）
- 可选 AI 配图（默认关，≤3 张）
- 实时预览 + 逐页编辑（标题/要点/备注）
- **一键导出真正的 `.pptx`**（PptxGenJS，浏览器内生成，可编辑）
- 草稿自动保存（Anna `storage`），下次打开续编
- 跟随 Anna 浅色/深色主题

### 交互方式
- 独立 App 窗口：从 Anna App Store 打开，或在对话中输入 `#anna-deck <主题>` 由助手 `open_app_view` 唤起并带入主题。
- 应用内：左侧创作面板 → 生成 → 右侧预览/编辑 → 导出。

### PPT 输出形式
- 直接下载 `.pptx`（16:9，含标题页、要点页、分节页、演讲备注、可选配图），可在任意演示软件二次编辑。

### 技术方案
- **Anna App（schema 4）**，UI bundle 为静态 SPA（原生 JS，无构建步骤）
- 宿主 SDK：`AnnaAppRuntime`（`/static/anna-apps/_sdk/latest/index.js`）
- AI：`anna.llm.complete`（结构化 JSON，costPriority 模型偏好）
- 配图：`anna.image.generate`（可选，≤3，n:1）
- 持久化：`anna.storage.set/get`
- 导出：`PptxGenJS`（已 vendored 到 `bundle/assets/pptxgen.bundle.js`，同源加载，避免 CSP/外链问题）

---

## 二、本地开发与验证

```bash
# 前置：Node 22+，uv（CLI 首次运行会自动拉取）
npm i -g @anna-ai/cli

# 在本目录
anna-app validate            # schema + UI 静态 + Host API 调用检查（已通过）
anna-app validate --strict   # 额外校验 Host API 方法是否存在（已通过）
anna-app dev                 # 本地沙箱预览（http://localhost:5180）

# 无宿主时：点击「载入示例」可零额度走通 预览→编辑→导出 全流程
```

导出路径已用 Node 侧等价调用验证：生成的 `.pptx` 是合法 OOXML/ZIP 包（含 `presentation.xml`、`slideN.xml`、`notesSlide`）。

---

## 三、发布到 Anna Staging 平台（需开发者本人操作）

> 以下命令需要 **你自己的 Anna 账号 PAT**（设备码登录）。Agent 无法代你完成邮箱验证码与浏览器授权。

```bash
# 1) 在 https://staging.anna.partners 注册并完成邮箱验证 → 获得 1000 额度
# 2) 设备码登录（按提示在浏览器批准）
anna-app login --host https://staging.anna.partners
# 3) 设置开发者命名空间（@handle）
anna-app account set-handle <你的handle>
# 4) 推送 working draft → 切版本 → 发布 → 提交审核
anna-app apps push
anna-app apps cut 1.0.0 --changelog "first release"
anna-app apps release 1.0.0
anna-app apps submit-review
```

发布后在 Anna App Store 即可搜索到，其他用户可 `#anna-deck` 或直接打开使用。

---

## 四、额度使用说明（笔试评价相关）
- 单次"AI 生成" = 1 次 `llm.complete`（结构化 JSON，maxTokens≤4000），模型走最便宜可用档。
- AI 配图：每张 = 1 次 `image.generate`（默认关闭，建议仅在必要时开启，≤3 张）。
- 预览/编辑/导出/PPTX 生成：**不消耗额度**。
- 建议验收流程：先用「载入示例」零额度验证 UI 与导出，再发起 1–2 次真实"AI 生成"验证端到端。

---

## 五、文件结构
```
anna-deck/
├── manifest.json          # App 清单（schema 4，纯 UI）
├── app.json               # 商店上架元数据（name/tagline/description/category）
├── bundle/
│   ├── index.html         # 两栏布局：创作面板 + 幻灯片预览
│   ├── app.js             # 全部逻辑：连接宿主、LLM、配图、预览、编辑、导出
│   ├── styles.css         # 主题感知（浅/深）
│   └── assets/
│       └── pptxgen.bundle.js  # PptxGenJS（vendored，用于 .pptx 导出）
└── README.md
```
