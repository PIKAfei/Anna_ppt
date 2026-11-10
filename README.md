# Anna Deck · AI 做 PPT

这道笔试题我做的是一个跑在 Anna Staging 上的 App：给一句话主题，或者贴一段材料，它生成一份能直接拿去用的 PPT。仓库里就是全部源码，`manifest.json` 加 `bundle/` 下的静态页面，没有服务端，用官方 `anna-app` CLI 就能发到平台。

交付信息放在前面，方便直接验收：

- 仓库：https://github.com/PIKAfei/Anna_ppt
- App name：`Anna Deck · AI 做 PPT`，slug：`anna-deck`，上架标识 `@pikafei/anna-deck`
- 平台：https://staging.anna.partners
- 当前冻结版本 `1.0.1`，状态 `PENDING_REVIEW`，等管理员批准后执行 `release` 才在 App Store 公开

## 我为什么做成这个样子

最省事的写法其实是让模型吐一段 Markdown，前端渲染成几张卡片，截图看着挺像 PPT。但这类工具我自己用过，最烦的就是最后还得把内容一条条复制进 PowerPoint 重新排版。所以我给自己定的底线是：导出必须是真正的 `.pptx`，能在 PowerPoint / WPS 里打开改字、调顺序，还要带演讲者备注。PDF 是后来加的第二条路，用来发不需要再改的版本。有了这条底线，后面很多设计都跟着定下来了。

用户范围我没有收窄。学生做课堂汇报、老师备课、职场周报、论文讲解、路演，要的东西其实差不多：别让我从空白页开始。所以界面不预设行业黑话，语气选项里专门留了「通用」和「学生 / 课程作业」，另外几档给管理层汇报、客户提案、复盘、路演用；中英文都能出。

交互上参考的是我平时用 Gamma、WPS AI 做 slides 的流程。它们有个共同点：先给大纲让人过一遍，再铺到画布上，而不是直接甩十页成品。这个顺序我觉得挺要紧，AI 写的第二页经常不对，改一行大纲比改十张幻灯片省事得多。所以 App 里大纲可以改标题、删页、上下调序，改完画布跟着变；右侧还能逐页改标题、要点和备注。模板给了五套，品牌色可以自己填。

## 技术上怎么落地

先把 /developers 读完了才动手。Anna App 本质是一个塞进沙箱 iframe 的静态包，宿主已经把模型、存储、鉴权、文件上传这些能力通过 Host API 暴露出来了，那自己再带个后端、或者打包 Executa 就是多余的。所以最后是纯 UI App（schema 4）：一次 `llm.complete` 把整份大纲以结构化 JSON 拿回来，前端维护一份 Slide JSON，预览、编辑、调序全在本地，导出时用 PptxGenJS 生成 OOXML、用 jsPDF 生成 PDF。两个库都 vendor 进 `bundle/assets` 同源加载——平台 CSP 是 `default-src 'none'`，外链 CDN 根本过不了。草稿交给宿主的 `storage`，浅色/深色主题和语言跟着宿主广播走。

额度这块我比较克制，毕竟题目里明说了会看。整份 PPT 只调一次模型，不用「每页一次」那种写法；调用参数里 `maxTokens` 卡在 4000，`modelPreferences` 给的是 `costPriority: 1`、`speedPriority: 0.5`、`intelligencePriority: 0.3`，让平台尽量挑便宜的可用模型；AI 配图默认关掉，勾了也只给封面和分节页配、最多三张，界面上写明耗额度。预览、编辑、导出都不花额度。另外放了个「示例」按钮，不调模型就能把预览 → 编辑 → 双格式导出整条链路走一遍，主要是方便验收，也方便我自己反复调试不用烧额度。

## 几个实测才暴露的问题

PDF 一开始我用的是 `window.print()`，点完按钮还弹「已导出」，我以为成了。后来在真实 harness 里翻控制台才发现，Anna 的 iframe 没开 `allow-modals`，Chrome 直接 `Ignored call to 'print()'`，而我的代码没检查返回值，属于假成功。改成用 canvas 按系统字体把中文画出来、再嵌进 jsPDF，才算真的生成文件；顺带还不用往 bundle 里塞几 MB 的中文字体。

PPTX 下载也是类似的坑。`<a download>` 能不能用取决于 iframe 有没有 `allow-downloads`，线上规则我不敢赌。所以做了一层统一交付：本地 blob 下载照走，同时用 `upload.inline` 把文件传到平台 R2 换一个 30 分钟有效的地址，再用 `chat.append_artifact` 挂回对话。就算下载被拦，从链接或对话里也能拿到文件。这两处都是「看起来能用、实际不能用」，不连真机跑一遍根本发现不了。

发布流程比文档上看着绕。`apps list`、`set-handle`、`apps push` 全都要求 Verified Developer，没激活一律 403；而激活只能本人在网页上接受开发者条款，PAT 调那个接口会被拒。`release` 也不是想发就发，我 dry-run 试过，draft / pending_review 下直接被拒，得先 `submit-review` 等管理员批准。另外 `app.json` 里的 `slug` 是必填且创建后不能改的，第一版我漏了，push 的时候才被 CLI 揪出来。还有两个纯环境的小坑：本地 harness 第一次起不来是 `uvx` 首次拉 runtime 包超时，预热一次就好；`git ls-remote` 一开始失败只是 `known_hosts` 里没有 github.com 的主机密钥。

## 真实测试

11 月 9 号用 `anna-app dev --llm-account https://staging.anna.partners` 连的真实 Nexus，不是 mock，再拿无头 Chrome 在 App iframe 里把流程点了一遍。主题填的是「AI 如何帮助学生更高效地学习」，要 5 页。

模型被路由到 `xiaomi/mimo-v2.5`，23 秒返回，`quotaConsumed 0.1698 CU`。大纲、每页要点和演讲者备注都解析对了，大纲列表和 16:9 画布渲染正常。导出的 pptx 78,616 字节，`PK\x03\x04` 开头，是合法 OOXML；PDF 182,345 字节，`%PDF-1.3`，6 页。平台托管链接和对话 artifact 都生成成功。`validate --strict`、JS 语法、DOM id 一致性也都过了，控制台只有一个 favicon 404，无害。

真实 LLM 调用总共没几次，导出验证全用示例数据、零额度，1000 额度基本没动。

## 本地跑和发布

```bash
npm i -g @anna-ai/cli
anna-app validate --strict
anna-app dev                                              # 本地沙箱预览，默认 5180
anna-app dev --llm-account https://staging.anna.partners  # 连真实模型

anna-app login --host https://staging.anna.partners
anna-app account set-handle pikafei
anna-app apps push                                        # 上传工作草稿
anna-app apps cut 1.0.1 --changelog "sandbox-safe exports"
anna-app apps submit-review                               # DRAFT → PENDING_REVIEW
# 管理员批准之后：
anna-app apps release 1.0.1
anna-app apps status anna-deck
```

状态是 `DRAFT → PENDING_REVIEW → APPROVED → PUBLISHED`，`APPROVED` 可以直链安装，`PUBLISHED` 才在商店里公开可见。审核期间如果又 cut 了新版本，要再跑一次 `submit-review` 把候选重新 pin 到最新版本，我改完导出加固那一版就是这么做的。

## 文件结构

```
anna-deck/
├── manifest.json          # App 清单（schema 4，纯 UI，无 Executa）
├── app.json               # 商店元数据（name / slug / tagline / description / category）
├── bundle/
│   ├── index.html         # 大纲 / 画布 / 属性三段式 + 云端交付链接区
│   ├── app.js             # 宿主连接、LLM、配图、大纲编辑、预览、双格式导出、统一交付层
│   ├── styles.css         # 主题感知样式
│   └── assets/
│       ├── pptxgen.bundle.js  # PptxGenJS（同源）
│       └── jspdf.umd.min.js   # jsPDF（同源）
└── README.md
```

还有没做完的：审核这一步在平台管理员侧，我这边能做的都做完了；配图分支因为默认关闭、又比较耗额度，只做了调用路径的检查，没有跑完整的生成验证。模板也只有五套，谈不上设计系统，够用而已。
