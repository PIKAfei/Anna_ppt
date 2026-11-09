# Anna Deck · AI 做 PPT

> 笔试工程题：基于 [Anna](https://staging.anna.partners) 平台，做一个人人可用的「AI 制作 PPT」App。
> 本仓库是 **Anna App** 完整源码（manifest + 静态 SPA bundle），可直接发布到 Anna Staging。

---

## 一、解题思路

### 1. 目标用户：通用，不设门槛
学生做课程汇报/读书分享、老师备课、职场人做周报与提案、研究者讲论文、创业者做路演——都是目标用户。因此 UI 用词、默认示例、模板都不预设行业背景；「语气/受众」里显式保留 **通用** 与 **学生/课程作业** 两档，同时提供管理层、提案、复盘、路演等进阶选项。中文优先，也支持英文。

> 设计取舍：受众范围放宽，但**交互范式与技术方案采用当前主流商用 AI PPT 产品**（Gamma / Microsoft 365 Copilot / WPS AI Slides / Beautiful.ai）的成熟做法。即"通用的用户，专业的产品形态"。

### 2. 核心判断：真正可用 > 演示效果
很多 AI PPT 产品只吐出一段聊天文本或几张图片，用户拿不到能交付的成品。本 App 的硬指标是 **导出可编辑 `.pptx`**（PowerPoint / WPS / Keynote 直接打开继续改），并补充 **真实 PDF**。这是"可用"与"玩具"的分界。

### 3. 功能范围（对齐主流范式）
| 主流产品必备环节 | 本 App |
|---|---|
| 主题 / 粘贴材料输入 | ✅ 支持主题或整段材料 |
| **大纲先行、可审阅编辑** | ✅ 改标题、增删页、上下调序，再落到幻灯片 |
| 模板 / 品牌控制 | ✅ 5 套模板 + 自定义品牌色 |
| 画布预览 + 逐页编辑 | ✅ 16:9 实时预览，标题/要点/演讲者备注 |
| AI 配图 | ✅ 可选，默认关，≤3 张 |
| 多格式导出 | ✅ 可编辑 .pptx + PDF |
| 交付物回到工作流 | ✅ 平台云端下载链接 + 对话 artifact |
| 草稿续编 | ✅ 平台托管 storage |

### 4. 交互方式
- **入口**：App Store 打开独立窗口；或在 Anna 对话里 `#anna-deck <主题>`，助手通过 `open_app_view` 带入主题（`entry_payload`）。
- **应用内**：左栏「输入 + 大纲列表」→ 右栏「幻灯片画布 + 本页属性编辑」，即主流的「大纲 / 画布 / 属性」三段式；对话式入口 + 可视化编辑混合。
- 主题/语言跟随宿主（light/dark、locale 广播）。

### 5. PPT 输出形式
- **主：可编辑 `.pptx`** —— 16:9，封面/分节/内容页，项目符号 + 演讲者备注，PptxGenJS 生成标准 OOXML。
- **次：真实 PDF** —— jsPDF + Canvas 逐页生成：中文由浏览器用系统字体绘制到 canvas，再嵌入 PDF，因此**不乱码、不需要内嵌几 MB 的中文字体**。
  > 为什么不用 `window.print()`：实测 Anna 的 iframe sandbox 未开放 `allow-modals`，浏览器会直接拒绝 `print()` 并报 `Ignored call to 'print()'`，却能返回"成功"的假象。改为前端生成真实 PDF 后才算可用。
- **交付通道**：每次导出同时走两条路 —— 本地 blob 下载（快）+ `anna.upload.inline` 把文件上传到平台 R2，返回 30 分钟有效的下载地址，并用 `anna.chat.append_artifact` 挂回对话。这样即使某个宿主 iframe 未开放 `allow-downloads`，用户依然能从链接/对话拿到文件。

### 6. 技术方案（与企业主流分层一一对应）
| 典型企业方案 | 本 App 落地 |
|---|---|
| React/TS 组件化 + 类型化 Slide schema | 静态 SPA + 结构化 Slide JSON 契约（Anna iframe 沙箱内零构建） |
| 企业统一 AI 网关（无需自带 key，统一计费/审计） | Anna Host API `llm.complete`，按 CU 计费、无密钥暴露 |
| 模板 / 设计系统 | 内置主题 + 品牌色 |
| OOXML 导出服务 | PptxGenJS（vendored 到 bundle，同源加载规避 CSP） |
| PDF 导出服务 | jsPDF + Canvas（vendored，浏览器渲染 CJK） |
| 对象存储 / 文件分发 | Anna Host `upload.inline` → R2 预签名链接 |
| 托管鉴权 / 存储 / 沙箱 | Anna Host `storage` + 沙箱运行时，无自建后端 |
| 多端一致 | 宿主主题 / 语言广播 |

**为什么是纯 UI App、不打包 Executa**：宿主已内置 `llm.*` / `image.*` / `storage.*` / `upload.*`，App 无需自带后端进程即可调用，发布更轻、故障面更小、额度更省。

### 7. 额度友好（笔试评价项）
- 整份大纲与内容用 **一次 `llm.complete`** 结构化 JSON 返回，而非每页多次调用。
- `modelPreferences.costPriority=1`，优先平台最经济的可用模型；`maxTokens≤4000`。
- **AI 配图默认关闭**，仅在用户主动开启且最多 3 张，UI 明确提示"消耗较多额度"。
- 预览 / 编辑 / 调序 / PPTX / PDF 生成 **全部本地完成，不消耗 LLM 额度**。
- 内置「示例」按钮：零额度即可走通 预览→编辑→双格式导出，方便验收。
- 实测：一次真实生成（5 页中文大纲）由平台路由到 `xiaomi/mimo-v2.5`，`quotaConsumed ≈ 0.17 CU`。

---

## 二、本地开发与验证

```bash
# 前置：Node 22+、uv（CLI 首次运行自动拉取 runtime 包）
npm i -g @anna-ai/cli

anna-app validate            # schema + UI 静态 + Host API 调用检查（通过）
anna-app validate --strict   # 额外校验 Host API 方法存在性（通过）
anna-app dev                 # 本地沙箱预览 http://localhost:5180
anna-app dev --llm-account https://staging.anna.partners   # 连真实 Nexus LLM
```

**已验证**（详见第六节）
- `validate` / `validate --strict` / JS 语法 / DOM id 一致性全部通过。
- 真实 `llm.complete` 端到端生成 5 页中文大纲，含演讲者备注。
- `.pptx` 是合法 OOXML/ZIP（含 `presentation.xml` / `slideN.xml` / `notesSlide`）。
- `.pdf` 是合法 `%PDF-1.3`，6 页、182 KB。

---

## 三、发布到 Anna Staging（**激活开发者需本人网页操作**）

> ⚠️ 关键前置：平台要求 **Verified Developer**，`apps list` / `set-handle` / `apps push` 在未激活时一律 `403 Verified developer required`。激活端点只接受浏览器会话且需本人接受开发者条款，CLI/Agent 无法代做：打开 https://staging.anna.partners/developer 完成邮箱验证 + 接受 ToS + 设置 handle。

正确的生命周期（**顺序不能颠倒**，实测 `release` 在 `draft` / `pending_review` 会被拒绝）：

```bash
anna-app login --host https://staging.anna.partners
anna-app account set-handle <handle>

anna-app apps push                                   # 上传工作草稿（manifest + bundle）
anna-app apps cut 1.0.0 --changelog "first release"  # 冻结为不可变版本
anna-app apps submit-review                           # DRAFT → PENDING_REVIEW，锁定审核候选版本
#  ⏳ 平台管理员审核通过 → APPROVED / PUBLISHED（服务端动作，开发者无法自助）
anna-app apps release 1.0.0                           # go live / 发布版本
anna-app apps status anna-deck                        # 查询状态
```

状态机：`DRAFT → PENDING_REVIEW → APPROVED → PUBLISHED`。`APPROVED` 可直链安装，`PUBLISHED` 才在 App Store 公开可见。审核期间若 cut 了新版本，需再跑一次 `submit-review` 把候选重新 pin 到最新版本。

---

## 四、文件结构
```
anna-deck/
├── manifest.json          # App 清单（schema 4，纯 UI，无 Executa）
├── app.json               # 商店元数据（name / slug / tagline / description / category）
├── bundle/
│   ├── index.html         # 三段式布局 + 云端交付链接区
│   ├── app.js             # 宿主连接 / LLM / 配图 / 大纲编辑 / 预览 / 双格式导出 / 统一交付层
│   ├── styles.css         # 主题感知样式
│   └── assets/
│       ├── pptxgen.bundle.js  # PptxGenJS（vendored，同源）
│       └── jspdf.umd.min.js   # jsPDF（vendored，同源）
└── README.md
```

所有依赖均 vendor 到 bundle 内、同源加载，不依赖 CDN，符合平台 `default-src 'none'` 的基础 CSP。

---

## 五、交付信息

| 项 | 值 |
|---|---|
| GitHub 仓库 | https://github.com/PIKAfei/Anna_ppt |
| App name | `Anna Deck · AI 做 PPT` |
| App slug | `anna-deck` |
| 上架标识 | `@pikafei/anna-deck` |
| 平台 | https://staging.anna.partners |
| 当前版本 | `1.0.1`（审核候选） |
| 当前状态 | `PENDING_REVIEW`，等待平台管理员批准；批准并 `release` 后即可被其他用户搜索/安装 |

---

## 六、真实测试记录（2026-11-09，Anna Staging）

用 `anna-app dev --llm-account https://staging.anna.partners` 连真实 Nexus，配合无头 Chrome 在 App iframe 内完成端到端操作：

| 测试项 | 结果 |
|---|---|
| SDK 握手 / `window.hello` / `storage.get` | ✅ 正常 |
| 真实 `llm.complete`（主题「AI 如何帮助学生更高效地学习」，5 页） | ✅ 返回 `xiaomi/mimo-v2.5`，延迟 23 s，`quotaConsumed 0.1698 CU` |
| 结构化大纲解析 → 大纲列表 / 画布 / 演讲备注渲染 | ✅ 5 页全部正确，toast「大纲已生成，可直接编辑」 |
| 导出 `.pptx` | ✅ 78,616 B，`application/zip`，`PK\x03\x04` 头（合法 OOXML） |
| 导出 `.pdf` | ✅ 182,345 B，`application/pdf`，`%PDF-1.3` 头 |
| `upload.inline` 平台托管 | ✅ 返回 R2 预签名下载 URL（TTL 1800 s），界面出现「☁ 平台托管」链接 |
| `chat.append_artifact` | ✅ 交付物挂回对话（`payload_ref` = 下载 URL） |
| `validate --strict` / JS 语法 / DOM id 一致性 | ✅ 全部通过 |
| 控制台错误 | 仅 `favicon.ico` 404（无害） |

测试期间发起的真实 LLM 调用为个位数，且示例/导出验证均为零额度，额度消耗可忽略。
