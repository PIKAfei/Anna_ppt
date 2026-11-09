# Anna Deck · AI 做 PPT

> 笔试工程题：基于 [Anna](https://staging.anna.partners) 平台，做一个人人可用的「AI 制作 PPT」App。
> 本仓库是 **Anna App** 完整源码（manifest + 静态 SPA bundle），可直接发布到 Anna Staging。

---

## 一、解题思路

### 1. 目标用户：通用，不设门槛
学生做课程汇报/读书分享、老师备课、职场人做周报与提案、研究者讲论文、创业者做路演——都是目标用户。因此 UI 用词、默认示例、模板都不预设行业背景；「语气/受众」里显式保留 **通用** 与 **学生/课程作业** 两档，同时提供管理层、提案、复盘、路演等进阶选项。中文优先，也支持英文。

> 设计取舍：受众范围放宽，但**交互范式与技术方案采用当前主流商用 AI PPT 产品**（Gamma / Microsoft 365 Copilot / WPS AI Slides / Beautiful.ai）的成熟做法。即"通用的用户，专业的产品形态"。

### 2. 核心判断：真正可用 > 演示效果
很多 AI PPT 产品只吐出一段聊天文本或几张图片，用户拿不到能交付的成品。本 App 的硬指标是 **导出可编辑 `.pptx`**（PowerPoint / WPS / Keynote 直接打开继续改），并补充 **PDF**。这是"可用"与"玩具"的分界。

### 3. 功能范围（对齐主流范式）
| 主流产品必备环节 | 本 App |
|---|---|
| 主题 / 粘贴材料输入 | ✅ 支持主题或整段材料 |
| **大纲先行、可审阅编辑** | ✅ 改标题、增删页、上下调序，再落到幻灯片 |
| 模板 / 品牌控制 | ✅ 5 套模板 + 自定义品牌色 |
| 画布预览 + 逐页编辑 | ✅ 16:9 实时预览，标题/要点/演讲者备注 |
| AI 配图 | ✅ 可选，默认关，≤3 张 |
| 多格式导出 | ✅ 可编辑 .pptx + PDF |
| 草稿续编 | ✅ 平台托管 storage |

### 4. 交互方式
- **入口**：App Store 打开独立窗口；或在 Anna 对话里 `#anna-deck <主题>`，助手通过 `open_app_view` 带入主题（`entry_payload`）。
- **应用内**：左栏「输入 + 大纲列表」→ 中栏「幻灯片画布」→ 下栏「本页属性编辑」，即主流的「大纲 / 画布 / 属性」三段式；对话式入口 + 可视化编辑混合。
- 主题/语言跟随宿主（light/dark、locale 广播）。

### 5. PPT 输出形式
- **主：可编辑 `.pptx`** —— 16:9，封面/分节/内容页，含项目符号与演讲者备注，PptxGenJS 生成标准 OOXML。
- **次：PDF** —— 浏览器打印通道（`@page landscape` + print CSS），中文不乱码、零额外依赖。

### 6. 技术方案（与企业主流分层一一对应）
| 典型企业方案 | 本 App 落地 |
|---|---|
| React/TS 组件化 + 类型化 Slide schema | 静态 SPA + 结构化 Slide JSON 契约（Anna iframe 沙箱内零构建） |
| 企业统一 AI 网关（无需自带 key，统一计费/审计） | Anna Host API `llm.complete`，按 CU 计费、无密钥暴露 |
| 模板 / 设计系统 | 内置主题 + 品牌色 |
| OOXML 导出服务 | PptxGenJS（vendored 到 bundle，同源加载规避 CSP） |
| 托管鉴权 / 存储 / 沙箱 | Anna Host `storage` + 沙箱运行时，无自建后端 |
| 多端一致 | 宿主主题 / 语言广播 |

**为什么是纯 UI App、不打包 Executa**：宿主已内置 `llm.*` / `image.*` / `storage.*`，App 无需自带后端进程即可调用，发布更轻、故障面更小、额度更省。

### 7. 额度友好（笔试评价项）
- 整份大纲与内容用 **一次 `llm.complete`** 结构化 JSON 返回，而非每页多次调用。
- `modelPreferences.costPriority=1`，优先平台最经济的可用模型；`maxTokens≤4000`。
- **AI 配图默认关闭**，仅在用户主动开启且最多 3 张，UI 明确提示"消耗较多额度"。
- 预览 / 编辑 / 调序 / 导出 / PPTX 与 PDF 生成 **全部本地完成，不消耗额度**。
- 内置「示例」按钮：零额度即可走通 预览→编辑→双格式导出，方便验收。

---

## 二、本地开发与验证

```bash
# 前置：Node 22+、uv（CLI 首次运行自动拉取）
npm i -g @anna-ai/cli

anna-app validate            # schema + UI 静态 + Host API 调用检查（通过）
anna-app validate --strict   # 额外校验 Host API 方法存在性（通过）
anna-app dev                 # 本地沙箱预览 http://localhost:5180
anna-app dev --llm real      # 需 PAT；对真实 Nexus 调 LLM（计入真实额度）
anna-app dev --llm mock --mock-llm fixtures/replies.jsonl   # 确定性、免费
```

已验证：PptxGenJS 导出的 `.pptx` 是合法 OOXML/ZIP（含 `presentation.xml`、`slideN.xml`、`notesSlide`）。

---

## 三、发布到 Anna Staging（**需开发者本人在网页完成一次激活**）

> ⚠️ 关键前置：平台要求 **Verified Developer** 标志，`/api/v1/developer/apps/*` 全部接口（含 `apps list`、`set-handle`、`apps push`）在没有该标志时一律 `403 Verified developer required`。
> 激活端点 `POST /api/v1/developer/profile/activate` **只接受浏览器会话，PAT 会被拒绝**（`PAT_NOT_ALLOWED`），且需要本人接受开发者条款——因此这一步无法由 CLI/Agent 代做。

```bash
# 1) 注册并完成邮箱验证 → 获得 1000 额度
#    打开 https://staging.anna.partners 注册
# 2) 网页激活开发者（一次性）
#    打开 https://staging.anna.partners/developer
#    阅读并接受 Developer Terms of Service，填 developer_handle，点 Activate developer access
# 3) 设备码登录，保存 PAT（90 天）
anna-app login --host https://staging.anna.partners
# 4) 设置命名空间（若第 2 步已填 handle 可跳过）
anna-app account set-handle <handle>
# 5) 发布闭环
anna-app apps push
anna-app apps cut 1.0.0 --changelog "first release"
anna-app apps release 1.0.0
anna-app apps submit-review
```

`submit-review` 后进入平台管理员审核，通过即上架 App Store，其他用户可直接打开或 `#anna-deck` 提及。

---

## 四、文件结构
```
anna-deck/
├── manifest.json          # App 清单（schema 4，纯 UI）
├── app.json               # 商店元数据（name / slug / tagline / description / category）
├── bundle/
│   ├── index.html         # 三段式布局：输入+大纲 / 画布 / 属性编辑
│   ├── app.js             # 连接宿主、LLM、配图、大纲编辑、预览、双格式导出
│   ├── styles.css         # 主题感知 + 打印样式（PDF）
│   └── assets/pptxgen.bundle.js  # PptxGenJS（vendored）
└── README.md
```
