// Anna Deck — AI presentation builder for everyone (pure-UI Anna App)
//
// Target users: general-purpose — students, educators, office workers,
// researchers, founders. Anyone who needs a deck quickly.
//
// Interaction / output follow the current mainstream AI-PPT product paradigm
// (cf. Gamma / Microsoft 365 Copilot / WPS AI Slides / Beautiful.ai):
//   brief/paste -> AI OUTLINE-first -> review & edit outline -> template/brand
//   -> slide canvas + per-slide editing -> export editable .pptx AND PDF.
//
// Tech layering (same separation of concerns as a typical enterprise stack):
//   component UI + typed Slide schema -> static SPA + structured Slide JSON
//   managed AI gateway (no BYO key, central billing) -> Anna Host llm.complete
//   OOXML export                      -> PptxGenJS (vendored)
//   PDF export                        -> jsPDF + Canvas (browser-rendered CJK)
//   managed auth/storage/file delivery -> Anna host storage / upload.inline
//   design system                     -> built-in templates + brand color
import { AnnaAppRuntime } from "/static/anna-apps/_sdk/latest/index.js";

const PptxGenJS = window.PptxGenJS;
const jsPDF = window.jspdf && window.jspdf.jsPDF;

const STYLES = {
  business: { label: "商务蓝", bg: "FFFFFF", accent: "1F4E79", text: "1C1E21", sub: "5B6B7B", dark: false },
  minimal:  { label: "极简黑白", bg: "FFFFFF", accent: "111111", text: "222222", sub: "666666", dark: false },
  academic: { label: "学术 / 白皮书", bg: "FFFFFF", accent: "2E5A88", text: "1A1A1A", sub: "555555", dark: false },
  tech:     { label: "科技紫", bg: "15102B", accent: "8B5CF6", text: "EDE9FE", sub: "A99FE6", dark: true },
  vibrant:  { label: "活力橙", bg: "FFF7ED", accent: "EA580C", text: "431407", sub: "9A3412", dark: false },
};

// Broad audience/tone set — students included
const TONE_TEXT = {
  general: "面向普通观众，清晰易懂、结构分明，避免专业黑话",
  student: "面向学生 / 课程作业：循序渐进、概念配例子，重讲解与知识脉络，必要时给记忆点",
  exec: "面向管理层的经营汇报：结论先行，突出关键指标、偏差归因与决策请求，措辞克制",
  proposal: "面向客户的提案：以痛点与收益为主线，包含现状、方案、价值证明与下一步",
  review: "项目复盘 / 周报：按目标—结果—差距—根因—行动项组织，明确责任人与时间",
  pitch: "融资路演：市场机会、产品壁垒、商业模式与增长曲线，强调可量化证据",
};

const IMAGE_SOURCE_LABEL = { ai: "AI 生成", upload: "本地图片", url: "链接图片" };
// Host runtime_state caps a single key at 262144 bytes. Keep comfortably below
// it so the outline (CJK text) still fits alongside compacted illustrations.
const DRAFT_BYTE_BUDGET = 200000;

const state = { deck: null, idx: 0, busy: false };
let anna = null;

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const topicEl = $("topic"), langEl = $("lang"), countEl = $("count"),
  toneEl = $("tone"), styleEl = $("style"), brandColorEl = $("brandColor"),
  withImagesEl = $("withImages");
const genBtn = $("genBtn"), sampleBtn = $("sampleBtn"), exportBtn = $("exportBtn"),
  pdfBtn = $("pdfBtn"), regenBtn = $("regenBtn"), prevBtn = $("prevBtn"),
  nextBtn = $("nextBtn"), addSlideBtn = $("addSlideBtn"), delSlideBtn = $("delSlideBtn");
const imgAiBtn = $("imgAiBtn"), imgUploadBtn = $("imgUploadBtn"), imgFileEl = $("imgFile"),
  imgClearBtn = $("imgClearBtn"), imgUrlEl = $("imgUrl"), imgUrlBtn = $("imgUrlBtn"),
  imgStatus = $("imgStatus");
const previewEl = $("preview"), pageInfoEl = $("pageInfo"), outlineList = $("outlineList"),
  outlineCount = $("outlineCount"), cloudLink = $("cloudLink"),
  edTitle = $("edTitle"), edBullets = $("edBullets"), edNotes = $("edNotes"),
  costHint = $("costHint"), toastEl = $("toast");

const ALL_BUTTONS = () => [
  genBtn, sampleBtn, exportBtn, pdfBtn, regenBtn, prevBtn, nextBtn,
  addSlideBtn, delSlideBtn, imgAiBtn, imgUploadBtn, imgClearBtn, imgUrlBtn,
];

// ---------- helpers ----------
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}
// The app window is often only ~700px tall, so a 16:9 canvas sized purely by
// width would overflow the preview area and clip the speaker notes at the
// bottom. Constrain width by the available height as well.
function fitPreview() {
  const wrap = document.querySelector(".preview-wrap");
  if (!wrap) return;
  const availW = wrap.clientWidth - 36;
  const availH = wrap.clientHeight - 36;
  if (availH <= 0) return;
  const w = Math.min(availW > 0 ? availW : 860, 860, (availH * 16) / 9);
  previewEl.style.width = Math.max(300, Math.floor(w)) + "px";
}
// SDK proxies resolve with the bare result on success, but some host versions
// return the raw {ok, result} / {ok:false, error} envelope. Handle both.
function unwrap(res) {
  if (res && typeof res === "object" && "ok" in res) {
    if (res.ok === false) {
      const err = res.error || { message: "RPC failed" };
      const e = new Error(err.message || "RPC failed");
      e.error = err;
      throw e;
    }
    return res.result !== undefined ? res.result : res;
  }
  return res;
}
function toast(msg, isErr = false, kind = null) {
  toastEl.textContent = msg;
  toastEl.className = "toast" + (isErr ? " err" : kind === "ok" ? " ok" : "");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toastEl.classList.add("hidden"), 3400);
}
function setBusy(busy, msg) {
  state.busy = busy;
  ALL_BUTTONS().forEach((b) => (b.disabled = busy));
  imgUrlEl.disabled = busy || !state.deck;
  genBtn.textContent = busy && msg ? msg : "✨ 生成大纲";
  if (!busy) renderNav();
}
function handleErr(e) {
  const m = e?.error?.message || e?.message || String(e);
  if (/APP_QUOTA_EXCEEDED/.test(m) || /quota/i.test(m)) return "额度不足：请调小页数、关闭配图或检查账户余额。";
  if (/APP_NOT_GRANTED/.test(m)) return "App 未安装/未授权，请先在 Anna 中打开本应用。";
  if (/agent_unavailable/.test(m)) return "未连接到 Anna Agent，请确认已登录并打开应用。";
  if (/llm_disabled/.test(m)) return "本地预览未启用 LLM；请用「示例」体验，或在已发布的 App 中生成。";
  if (/network|fetch|Failed to fetch/i.test(m)) return "网络或宿主连接失败，请稍后重试。";
  return m;
}
const accentOf = (d) => d?.brandColor || (STYLES[d?.style] || STYLES.business).accent;
const safeName = (s) => String(s || "anna-deck").replace(/[^\w\u4e00-\u9fa5 .-]/g, "_").slice(0, 80);

// ---------- LLM prompt: outline-first, audience-aware ----------
function buildSystemPrompt(lang, count, tone) {
  const langText = lang === "zh" ? "简体中文" : lang === "en" ? "English" : "与用户输入语言一致";
  return [
    "你是专业的演示文稿策划顾问。基于用户给出的主题、材料或大纲，产出一份结构清晰、内容扎实的幻灯片大纲。",
    "规则：",
    "1. 严格只输出一个 JSON 对象，不要解释、不要 markdown 代码块、不要多余文字。",
    "2. 结构：{\"title\":总标题, \"subtitle\":副标题, \"slides\":[{\"title\":每页标题, \"bullets\":[要点字符串数组], \"notes\":演讲备注字符串, \"layout\":\"title\"|\"bullets\"|\"section\", \"imagePrompt\":英文配图提示词}]}",
    "3. 共生成 " + count + " 页。第 1 页为封面(layout:\"title\")；可穿插 \"section\" 分节页；其余为 \"bullets\" 内容页。",
    "4. 标题写成明确的短句；每页 bullets 3-5 条，信息具体、避免空话套话。",
    "5. notes 为该页演讲者备注（2-3 句），便于讲解时展开。",
    "6. 语言：" + langText + "。受众与语气：" + (TONE_TEXT[tone] || TONE_TEXT.general) + "。",
    "7. imagePrompt 是给图片模型用的英文提示词（30-50 词）：描述与本页内容直接对应的具体场景、实物、人物或环境，让人只看图就能猜到主题；必须用到总主题里的关键名词和该页要点中的具体元素。禁止抽象光带、流线、科技波纹、无意义渐变、几何装饰，不要出现文字、字母、数字或 logo。字符串内不要用未转义的英文双引号。",
  ].join("\n");
}
function buildUserPrompt(topic, lang) {
  const t = lang === "en" ? "Create a slide-deck outline from this brief" : "请基于以下主题/材料生成幻灯片大纲";
  return t + "：\n" + topic;
}

// ---------- parse ----------
function parseDeck(text, meta) {
  let s = String(text || "").trim();
  s = s.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  const obj = JSON.parse(s);
  const slides = (obj.slides || []).map((x) => ({
    title: String(x.title || ""),
    bullets: Array.isArray(x.bullets) ? x.bullets.map(String) : x.bullets ? [String(x.bullets)] : [],
    notes: String(x.notes || ""),
    layout: x.layout || "bullets",
    imagePrompt: String(x.imagePrompt || ""),
    image: null,
    imageSource: null,
  }));
  return {
    title: obj.title || "未命名演示",
    subtitle: obj.subtitle || "",
    lang: meta.lang, style: meta.style, brandColor: meta.brandColor,
    slides,
  };
}

// ---------- generate ----------
async function generateDeck() {
  if (!anna) { toast("当前为独立预览，无法调用 AI。请点「示例」体验，或在已发布的 Anna App 中生成。", true); return; }
  const topic = topicEl.value.trim();
  if (!topic) { toast("请先输入主题或粘贴材料", true); return; }
  const lang = langEl.value, count = +countEl.value, styleKey = styleEl.value,
    tone = toneEl.value, brandColor = brandColorEl.value.replace("#", "");
  setBusy(true, "AI 正在规划大纲…");
  try {
    const res = unwrap(await anna.llm.complete({
      systemPrompt: buildSystemPrompt(lang, count, tone),
      messages: [{ role: "user", content: buildUserPrompt(topic, lang) }],
      maxTokens: 4000,
      temperature: 0.7,
      modelPreferences: { costPriority: 1, speedPriority: 0.5, intelligencePriority: 0.3 },
    }));
    const deck = parseDeck(res?.content?.text || "", { lang, style: styleKey, brandColor });
    if (!deck.slides.length) throw new Error("AI 返回内容无法解析，请重试");
    state.deck = deck; state.idx = 0;
    await saveDeck(); renderAll();
    let failedImages = 0;
    if (withImagesEl.checked) failedImages = (await generateImages(deck)).fail;
    const used = res?._meta?.quotaConsumed;
    costHint.textContent = used != null ? `本次生成消耗约 ${used} CU` : "";
    if (failedImages) toast(`大纲已生成，${failedImages} 张自动配图失败，可在「本页配图」里逐页补图`, true);
    else toast("大纲已生成，可直接编辑 ✏️", false, "ok");
  } catch (e) {
    toast(handleErr(e), true);
  } finally { setBusy(false); }
}

// The old prompt asked for an "abstract presentation visual" using only the
// slide title, so the model reliably returned generic light-ribbon decoration
// unrelated to the topic. The outline now carries a concrete, topic-bound
// imagePrompt from the same single LLM call; this wraps it with strict
// "no abstract decoration" constraints and the deck's own context.
function imagePromptFor(deck, s) {
  const style = STYLES[deck.style] || STYLES.business;
  const palette = style.dark
    ? "dark, low-key editorial lighting, deep navy and charcoal tones with one subtle accent colour"
    : "bright, clean editorial lighting, soft neutral background";
  const context = [deck.title, deck.subtitle, s.title, ...(s.bullets || []).slice(0, 2)]
    .filter(Boolean).join(" / ");
  const subject = (s.imagePrompt || "").trim() ||
    `A literal, recognisable scene illustrating ${context}, showing concrete real-world objects, people or places directly connected to this subject, editorial photography or realistic illustration.`;
  return [
    subject,
    `Deck topic: ${deck.title}. This slide is specifically about: ${s.title}.`,
    `Visual style: ${palette}, coherent with the slide template, one coherent high-quality scene, no collage.`,
    "STRICTLY AVOID: abstract swirls, flowing light ribbons, generic technology waves, neon spirals, bokeh, random gradients, decorative geometric shapes, and any text, letters, numbers, logos or watermarks.",
    "The picture must clearly depict this slide's subject — a viewer should recognise the topic from the image alone.",
  ].join(" ");
}

// Automatic images are only a DEFAULT SUGGESTION: cover + section pages,
// capped at three to keep CU spend predictable. Page count and placement are
// ultimately the user's call via the per-slide tools below.
async function generateImages(deck) {
  const targets = [];
  deck.slides.forEach((s, i) => {
    if ((i === 0 || s.layout === "section") && targets.length < 3) targets.push(i);
  });
  let ok = 0, fail = 0;
  for (let k = 0; k < targets.length; k++) {
    const i = targets[k];
    try {
      setBusy(true, `正在按主题生成配图 ${k + 1}/${targets.length}…`);
      const data = unwrap(await anna.image.generate(
        { prompt: imagePromptFor(deck, deck.slides[i]), n: 1, size: "1280x720" },
        { timeoutMs: 120000 }
      ));
      const url = data?.images?.[0]?.url;
      if (!url) throw new Error("图片生成未返回图片");
      deck.slides[i].image = await normalizeImage(await urlToBase64(url));
      deck.slides[i].imageSource = "ai";
      ok++; renderAll();
    } catch (e) { fail++; console.warn("image gen failed:", e); }
  }
  await saveDeck();
  return { ok, fail };
}
async function urlToBase64(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error("图片下载失败 HTTP " + resp.status);
  const blob = await resp.blob();
  if (blob.type && !/^image\//.test(blob.type)) throw new Error("链接返回的不是图片");
  return await new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result));
    fr.onerror = () => rej(new Error("图片读取失败"));
    fr.readAsDataURL(blob);
  });
}

// ---------- per-slide image tools (P0 + P1) ----------
const slimCache = new WeakMap();
function compactImage(dataUrl, maxW, quality) {
  return new Promise((res) => {
    const im = new Image();
    im.onload = () => {
      try {
        const scale = Math.min(1, maxW / im.width);
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(im.width * scale));
        c.height = Math.max(1, Math.round(im.height * scale));
        c.getContext("2d").drawImage(im, 0, 0, c.width, c.height);
        res(c.toDataURL("image/jpeg", quality));
      } catch (e) { res(null); }
    };
    im.onerror = () => res(null);
    im.src = dataUrl;
  });
}
async function normalizeImage(dataUrl) {
  if (typeof dataUrl !== "string" || !/^data:image\//.test(dataUrl)) throw new Error("图片数据无效");
  if (dataUrl.length < 1200000) return dataUrl;
  return (await compactImage(dataUrl, 1600, 0.88)) || dataUrl;
}
async function slimImageFor(s) {
  if (!s.image) return null;
  const hit = slimCache.get(s);
  if (hit && hit.src === s.image) return hit.slim;
  const slim = await compactImage(s.image, 560, 0.62);
  slimCache.set(s, { src: s.image, slim });
  return slim;
}
function renderImageTools() {
  const d = state.deck, s = d && d.slides[state.idx];
  const has = !!(s && s.image);
  const blocked = !d || state.busy;
  [imgAiBtn, imgUploadBtn, imgUrlBtn, imgUrlEl, imgClearBtn].forEach((el) => (el.disabled = blocked));
  imgClearBtn.disabled = blocked || !has;
  imgAiBtn.textContent = has && s.imageSource === "ai" ? "AI 重生成配图" : "AI 生成配图";
  imgStatus.textContent = has ? (IMAGE_SOURCE_LABEL[s.imageSource] || "已有配图") : "本页暂无配图";
}
async function setSlideImage(dataUrl, source) {
  const d = state.deck; if (!d) return;
  const s = d.slides[state.idx];
  s.image = await normalizeImage(dataUrl);
  s.imageSource = source;
  renderAll();
  await saveDeck();
}
function clearSlideImage() {
  const d = state.deck; if (!d) return;
  const s = d.slides[state.idx];
  if (!s.image) return;
  s.image = null; s.imageSource = null;
  renderAll(); saveDeck();
  toast("已清除本页配图", false, "ok");
}
async function generateSlideImage() {
  const d = state.deck; if (!d) return;
  if (!anna || !anna.image || !anna.image.generate) {
    toast("当前环境无法调用图片生成，请改用「上传图片」", true); return;
  }
  setBusy(true, "正在为本页生成配图…");
  try {
    const res = await anna.image.generate(
      { prompt: imagePromptFor(d, d.slides[state.idx]), n: 1, size: "1280x720" },
      { timeoutMs: 120000 }
    );
    const data = unwrap(res);
    const url = data?.images?.[0]?.url;
    if (!url) throw new Error("图片生成未返回图片");
    await setSlideImage(await urlToBase64(url), "ai");
    const used = res?._meta?.quotaConsumed ?? data?._meta?.quotaConsumed;
    toast(used != null ? `本页配图已生成 · 消耗约 ${used} CU` : "本页配图已生成", false, "ok");
  } catch (e) { toast("配图失败：" + handleErr(e), true); }
  finally { setBusy(false); }
}
async function onUploadImage() {
  const f = imgFileEl.files && imgFileEl.files[0];
  imgFileEl.value = "";
  if (!f) return;
  if (/svg/i.test(f.type)) { toast("暂不支持 SVG，请改用 PNG / JPG / WebP", true); return; }
  if (!/^image\//.test(f.type)) { toast("请选择图片文件", true); return; }
  if (f.size > 8 * 1024 * 1024) { toast("图片超过 8 MB，请换一张小一些的", true); return; }
  setBusy(true, "正在读取图片…");
  try {
    const dataUrl = await new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result));
      fr.onerror = () => rej(new Error("读取文件失败"));
      fr.readAsDataURL(f);
    });
    await setSlideImage(dataUrl, "upload");
    toast("已使用本地图片（不消耗额度）", false, "ok");
  } catch (e) { toast("图片读取失败：" + handleErr(e), true); }
  finally { setBusy(false); }
}
async function useImageUrl() {
  const d = state.deck; if (!d) return;
  const url = imgUrlEl.value.trim();
  if (!/^https?:\/\//i.test(url)) { toast("请填写 http(s) 开头的图片链接", true); return; }
  setBusy(true, "正在读取链接图片…");
  try {
    const dataUrl = await urlToBase64(url);
    await setSlideImage(dataUrl, "url");
    imgUrlEl.value = "";
    toast("已使用链接图片（不消耗额度）", false, "ok");
  } catch (e) {
    toast("链接图片读取失败（平台沙箱或跨域限制），请下载后改用「上传图片」：" + handleErr(e), true);
  } finally { setBusy(false); }
}

// ---------- sample: general topic, zero-credit ----------
function loadSample() {
  state.deck = {
    title: "AI 如何重塑个人生产力",
    subtitle: "从工具到协作伙伴 · 通识分享",
    lang: "zh",
    style: styleEl.value || "business",
    brandColor: brandColorEl.value.replace("#", ""),
    slides: [
      { title: "AI 如何重塑个人生产力", bullets: ["从工具到协作伙伴", "一次关于效率的范式转移", "人人都用得上的三个场景"], notes: "开场先抛问题：你上一次用 AI 省下的时间，用在了哪里？", layout: "title", imagePrompt: "", image: null, imageSource: null },
      { title: "今天聊什么", bullets: ["为什么是现在", "三类高频场景", "风险与边界", "上手建议"], notes: "30 秒交代结构，让听众有预期。", layout: "section", imagePrompt: "", image: null, imageSource: null },
      { title: "为什么是现在", bullets: ["大模型能力跨过可用阈值", "使用成本大幅下降", "与日常工具集成趋于成熟"], notes: "强调拐点来自能力、成本、集成三者同时到位。", layout: "bullets", imagePrompt: "", image: null, imageSource: null },
      { title: "三类高频场景", bullets: ["写作与摘要：从草稿到定稿", "资料整理：从杂乱到结构化", "学习辅助：把难点讲成例子"], notes: "每个场景给一个学生和上班族都能对号入座的例子。", layout: "bullets", imagePrompt: "", image: null, imageSource: null },
      { title: "风险与边界", bullets: ["幻觉与事实核查", "隐私与数据边界", "人的判断不可外包"], notes: "坦诚谈风险，反而增加可信度。", layout: "bullets", imagePrompt: "", image: null, imageSource: null },
      { title: "上手建议", bullets: ["从一个小场景开始", "积累可复用的提示模板", "把 AI 当协作者而非替代"], notes: "结尾给出可执行的下一步。", layout: "bullets", imagePrompt: "", image: null, imageSource: null },
    ],
  };
  state.idx = 0; saveDeck(); renderAll();
  toast("已载入示例（无需额度）", false, "ok");
}

// ---------- render ----------
function renderAll() { renderPreview(); renderEditor(); renderNav(); renderOutline(); fitPreview(); }
function renderNav() {
  const d = state.deck;
  [exportBtn, pdfBtn, regenBtn, addSlideBtn, delSlideBtn].forEach((b) => (b.disabled = !d || state.busy));
  if (!d) { pageInfoEl.textContent = "— / —"; renderImageTools(); return; }
  pageInfoEl.textContent = `${state.idx + 1} / ${d.slides.length}`;
  prevBtn.disabled = state.busy || state.idx === 0;
  nextBtn.disabled = state.busy || state.idx === d.slides.length - 1;
  renderImageTools();
}
function renderPreview() {
  const d = state.deck;
  if (!d) { previewEl.innerHTML = '<div style="margin:auto;opacity:.5">输入主题并「生成大纲」，或点「示例」预览</div>'; return; }
  const style = STYLES[d.style] || STYLES.business;
  const accent = accentOf(d);
  const s = d.slides[state.idx];
  const isCover = state.idx === 0;
  const hasImage = !!s.image;
  previewEl.className = "slide-preview" + (style.dark ? " is-dark" : "") + (hasImage ? " has-image" : "");
  previewEl.style.background = "#" + style.bg;
  previewEl.style.color = "#" + style.text;
  // Text lives in a left column that is narrowed whenever an image is present,
  // so long titles wrap instead of running underneath the absolutely
  // positioned right-hand image. The image is kept below the text layer too.
  let html = '<div class="sp-content">';
  if (isCover) {
    html += `<div class="sp-kicker" style="color:#${accent}">PRESENTATION</div>`;
    html += `<div class="sp-title">${escapeHtml(d.title)}</div>`;
    if (d.subtitle) html += `<div class="sp-sub">${escapeHtml(d.subtitle)}</div>`;
  } else {
    html += `<div class="sp-kicker" style="color:#${accent}">${s.layout === "section" ? "SECTION" : String(state.idx + 1).padStart(2, "0")}</div>`;
    html += `<div class="sp-title">${escapeHtml(s.title)}</div>`;
    if (s.bullets.length) html += '<ul class="sp-bullets">' + s.bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join("") + "</ul>";
  }
  if (s.notes) html += `<div class="sp-notes">备注：${escapeHtml(s.notes)}</div>`;
  html += "</div>";
  if (hasImage) {
    html += `<img class="sp-image" src="${escapeHtml(s.image)}" alt="" />`;
    html += `<span class="sp-img-badge">${IMAGE_SOURCE_LABEL[s.imageSource] || "配图"}</span>`;
  }
  previewEl.innerHTML = html;
}
function renderEditor() {
  const d = state.deck;
  [edTitle, edBullets, edNotes].forEach((el) => (el.disabled = !d));
  if (!d) { edTitle.value = edBullets.value = edNotes.value = ""; return; }
  const s = d.slides[state.idx];
  edTitle.value = s.title;
  edBullets.value = s.bullets.join("\n");
  edNotes.value = s.notes;
}
function renderOutline() {
  const d = state.deck;
  outlineCount.textContent = d ? d.slides.length : 0;
  if (!d) { outlineList.innerHTML = '<li class="empty">尚无大纲</li>'; return; }
  outlineList.innerHTML = d.slides.map((s, i) => `
    <li class="outline-item ${i === state.idx ? "active" : ""}" data-i="${i}">
      <span class="oi-num">${String(i + 1).padStart(2, "0")}</span>
      <span class="oi-title">${escapeHtml(s.title || "未命名页")}</span>
      <span class="oi-actions">
        <button data-act="up" data-i="${i}" title="上移">↑</button>
        <button data-act="down" data-i="${i}" title="下移">↓</button>
        <button data-act="del" data-i="${i}" title="删除">✕</button>
      </span>
    </li>`).join("");
}

// ---------- outline + per-slide editing ----------
function onEdit() {
  const d = state.deck; if (!d) return;
  const s = d.slides[state.idx];
  s.title = edTitle.value;
  s.bullets = edBullets.value.split("\n").map((x) => x.trim()).filter(Boolean);
  s.notes = edNotes.value;
  renderPreview(); renderOutline(); scheduleSave();
}
function onOutlineClick(e) {
  const d = state.deck; if (!d) return;
  const btn = e.target.closest("button[data-act]");
  if (btn) {
    const i = +btn.dataset.i, act = btn.dataset.act;
    if (act === "up" && i > 0) {
      [d.slides[i - 1], d.slides[i]] = [d.slides[i], d.slides[i - 1]]; state.idx = i - 1;
    } else if (act === "down" && i < d.slides.length - 1) {
      [d.slides[i + 1], d.slides[i]] = [d.slides[i], d.slides[i + 1]]; state.idx = i + 1;
    } else if (act === "del" && d.slides.length > 1) {
      d.slides.splice(i, 1);
      state.idx = Math.max(0, Math.min(state.idx, d.slides.length - 1));
    } else return;
    renderAll(); scheduleSave(); return;
  }
  const li = e.target.closest("li[data-i]");
  if (li) { state.idx = +li.dataset.i; renderAll(); }
}
function addSlide() {
  const d = state.deck; if (!d) return;
  d.slides.splice(state.idx + 1, 0, { title: "新幻灯片", bullets: ["要点一", "要点二"], notes: "", layout: "bullets", imagePrompt: "", image: null, imageSource: null });
  state.idx++;
  renderAll(); scheduleSave();
}
function deleteCurrent() {
  const d = state.deck; if (!d || d.slides.length <= 1) { toast("至少保留一页", true); return; }
  d.slides.splice(state.idx, 1);
  state.idx = Math.max(0, Math.min(state.idx, d.slides.length - 1));
  renderAll(); scheduleSave();
}

// ---------- delivery: local download + platform-hosted link ----------
// A sandboxed iframe is not guaranteed to have `allow-downloads`. So every
// export is ALSO handed to the Anna host via upload.inline (bypasses CSP and
// the iframe sandbox entirely), which returns a presigned download URL. The
// link is shown in-app and attached to the conversation as an artifact.
async function deliverFile(blob, filename, mime) {
  try { downloadBlob(blob, filename); } catch (e) { /* sandbox may block it */ }
  if (!anna || !anna.upload || !anna.upload.inline) return { mode: "local" };
  try {
    const b64 = await blobToB64(blob);
    const r = unwrap(await anna.upload.inline(
      { filename, mime_type: mime, content_b64: b64, purpose: "user_artifact" },
      { timeoutMs: 60000 }
    ));
    const url = r && r.download_url;
    if (!url) return { mode: "local" };
    showCloudLink(url, filename);
    if (anna.chat && anna.chat.append_artifact) {
      try {
        await anna.chat.append_artifact({ artifact: {
          kind: "presentation", app_slug: "anna-deck",
          summary: "演示文稿已生成：" + filename,
          payload_ref: url,
          data: { filename, mime_type: mime, download_url: url },
        } });
      } catch (e) { /* artifact is a bonus, never block the download */ }
    }
    return { mode: "cloud", url };
  } catch (e) {
    console.warn("host upload unavailable, local download only:", e);
    return { mode: "local" };
  }
}
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
function blobToB64(blob) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result).split(",")[1] || "");
    fr.onerror = rej;
    fr.readAsDataURL(blob);
  });
}
function showCloudLink(url, filename) {
  cloudLink.classList.remove("hidden");
  cloudLink.innerHTML = `
    <span class="cl-label">☁ 平台托管</span>
    <a class="cl-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(filename)}</a>
    <button class="cl-copy" type="button">复制链接</button>
    <span class="cl-url" title="${escapeHtml(url)}">${escapeHtml(url)}</span>`;
  const btn = cloudLink.querySelector(".cl-copy");
  btn.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(url); btn.textContent = "已复制 ✓"; }
    catch (e) { btn.textContent = "请手动复制链接"; }
    setTimeout(() => (btn.textContent = "复制链接"), 2200);
  });
}

// ---------- export: editable .pptx ----------
async function exportPptx() {
  const d = state.deck; if (!d) return;
  if (!PptxGenJS) { toast("PptxGenJS 未加载，无法导出", true); return; }
  setBusy(true, "正在生成 .pptx…");
  try {
    const style = STYLES[d.style] || STYLES.business;
    const accent = accentOf(d);
    const pptx = new PptxGenJS();
    pptx.layout = "LAYOUT_WIDE";
    d.slides.forEach((s, i) => {
      const sl = pptx.addSlide();
      sl.background = { color: style.bg };
      const hasImage = !!s.image;
      const textW = hasImage ? 7.4 : 11.9;
      // Image first (underneath), text confined to the left column.
      if (hasImage) sl.addImage({ data: s.image, x: 8.6, y: 1.8, w: 4.0, h: 4.4 });
      if (i === 0) {
        sl.addText(d.title, { x: 0.7, y: 2.3, w: textW, h: 1.6, fontSize: hasImage ? 34 : 40, bold: true, color: accent });
        if (d.subtitle) sl.addText(d.subtitle, { x: 0.7, y: 4.0, w: textW, h: 0.9, fontSize: 20, color: style.sub });
      } else {
        sl.addText(s.title, { x: 0.7, y: 0.5, w: textW, h: 1.0, fontSize: 28, bold: true, color: accent });
        sl.addText(
          s.bullets.map((b) => ({ text: b, options: { bullet: { indent: 18 } } })),
          { x: 0.7, y: 1.8, w: textW, h: 4.8, fontSize: 18, color: style.text, lineSpacingMultiple: 1.2 }
        );
      }
      if (s.notes) sl.addNotes(s.notes);
    });
    const blob = await pptx.write({ outputType: "blob" });
    const res = await deliverFile(blob, safeName(d.title || "anna-deck") + ".pptx",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation");
    toast(res.mode === "cloud" ? "已导出 PPTX · 本地下载 + 云端链接 ⬇" : "已导出可编辑 PPTX ⬇", false, "ok");
  } catch (e) {
    toast("导出失败：" + handleErr(e), true);
  } finally { setBusy(false); }
}

// ---------- export: real PDF (jsPDF + Canvas) ----------
// window.print() is blocked in a sandboxed iframe without `allow-modals`, and
// embedding a CJK font would bloat the bundle. Rendering each slide onto a
// canvas lets the browser paint Chinese glyphs with system fonts; the PNG is
// then embedded page-by-page into a real PDF. No host/browser modal needed.
async function exportPdf() {
  const d = state.deck; if (!d) return;
  if (!jsPDF) { toast("PDF 组件未加载，无法导出", true); return; }
  setBusy(true, "正在生成 PDF…");
  try {
    const pdf = new jsPDF({ orientation: "landscape", unit: "pt", format: [1280, 720], compress: true });
    for (let i = 0; i < d.slides.length; i++) {
      if (i > 0) pdf.addPage([1280, 720], "landscape");
      const canvas = await renderSlideCanvas(d.slides[i], i, d);
      pdf.addImage(canvas.toDataURL("image/jpeg", 0.9), "JPEG", 0, 0, 1280, 720);
    }
    const blob = pdf.output("blob");
    const res = await deliverFile(blob, safeName(d.title || "anna-deck") + ".pdf", "application/pdf");
    toast(res.mode === "cloud" ? "已导出 PDF · 本地下载 + 云端链接 ⬇" : "已导出 PDF ⬇", false, "ok");
  } catch (e) {
    toast("导出失败：" + handleErr(e), true);
  } finally { setBusy(false); }
}
function wrapCanvasText(g, text, x, y, maxW, lineH) {
  let line = "", yy = y;
  for (const ch of String(text || "")) {
    if (g.measureText(line + ch).width > maxW && line) {
      g.fillText(line, x, yy); yy += lineH; line = ch;
    } else line += ch;
  }
  if (line) g.fillText(line, x, yy);
  return yy;
}
function loadImage(src) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error("image decode failed"));
    im.src = src;
  });
}
function drawImageCover(g, im, x, y, w, h) {
  const ir = im.width / im.height, br = w / h;
  let sw = im.width, sh = im.height, sx = 0, sy = 0;
  if (ir > br) { sw = im.height * br; sx = (im.width - sw) / 2; }
  else { sh = im.width / br; sy = (im.height - sh) / 2; }
  g.save();
  g.beginPath();
  if (typeof g.roundRect === "function") g.roundRect(x, y, w, h, 12);
  else g.rect(x, y, w, h);
  g.clip();
  g.drawImage(im, sx, sy, sw, sh, x, y, w, h);
  g.restore();
}
async function renderSlideCanvas(s, i, d) {
  const W = 1280, H = 720;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d");
  const st = STYLES[d.style] || STYLES.business;
  const accent = "#" + accentOf(d);
  const font = '"Microsoft YaHei","PingFang SC","Noto Sans CJK SC",Arial,sans-serif';
  const hasImage = !!s.image;
  const textMaxW = hasImage ? 700 : W - 192;
  g.fillStyle = "#" + st.bg; g.fillRect(0, 0, W, H);
  g.fillStyle = accent; g.fillRect(0, 0, W, 10);
  g.textBaseline = "top";
  if (i === 0) {
    g.fillStyle = "#" + st.sub; g.font = "20px " + font;
    g.fillText("PRESENTATION", 96, 150);
    g.fillStyle = accent; g.font = "bold 52px " + font;
    wrapCanvasText(g, d.title, 96, 250, textMaxW, 68);
    g.fillStyle = "#" + st.sub; g.font = "26px " + font;
    wrapCanvasText(g, d.subtitle || "", 96, 400, textMaxW, 40);
  } else {
    g.fillStyle = "#" + st.sub; g.font = "20px " + font;
    g.fillText(s.layout === "section" ? "SECTION" : String(i + 1).padStart(2, "0"), 96, 80);
    g.fillStyle = accent; g.font = "bold 42px " + font;
    const endY = wrapCanvasText(g, s.title, 96, 130, textMaxW, 54);
    let y = Math.max(260, endY + 70);
    (s.bullets || []).forEach((b) => {
      g.fillStyle = accent;
      g.beginPath(); g.arc(108, y + 15, 7, 0, Math.PI * 2); g.fill();
      g.fillStyle = "#" + st.text; g.font = "26px " + font;
      y = wrapCanvasText(g, b, 140, y, hasImage ? 600 : W - 250, 40) + 24;
    });
  }
  // PDF must show the same illustration as the preview / PPTX.
  if (hasImage) {
    try { drawImageCover(g, await loadImage(s.image), 830, 150, 360, 400); }
    catch (e) { console.warn("pdf image skipped:", e); }
  }
  g.fillStyle = "#" + st.sub; g.font = "18px " + font;
  g.fillText(String(i + 1).padStart(2, "0") + " / " + String(d.slides.length).padStart(2, "0"), W - 150, H - 48);
  return c;
}

// ---------- persistence ----------
// The old version stripped every image from the draft, so a refresh silently
// lost all illustrations. Now images are downscaled to a compact JPEG, with a
// byte budget; if the deck still cannot fit under runtime_state's cap we drop
// images from the end first, and finally fall back to a text-only draft.
let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveDeck(); }, 350);
}
async function saveDeck() {
  if (!anna || !state.deck) return;
  const bare = () => ({
    ...state.deck,
    idx: state.idx,
    slides: state.deck.slides.map((s) => ({ ...s, image: null, imageSource: null })),
  });
  try {
    const slides = [];
    for (const s of state.deck.slides) {
      slides.push({ ...s, image: await slimImageFor(s), imageSource: s.image ? s.imageSource : null });
    }
    let draft = { ...state.deck, idx: state.idx, slides };
    const byteLen = () => new TextEncoder().encode(JSON.stringify(draft)).length;
    let bytes = byteLen();
    if (bytes > DRAFT_BYTE_BUDGET) {
      for (let i = slides.length - 1; i >= 0 && bytes > DRAFT_BYTE_BUDGET; i--) {
        if (slides[i].image) { slides[i].image = null; bytes = byteLen(); }
      }
    }
    if (bytes > DRAFT_BYTE_BUDGET) draft = bare();
    await anna.storage.set({ key: "deck", value: draft });
  } catch (e) {
    try { await anna.storage.set({ key: "deck", value: bare() }); } catch (_) { /* ignore */ }
  }
}
async function loadDeck() {
  if (!anna) return;
  try {
    const g = unwrap(await anna.storage.get({ key: "deck" }));
    const value = g?.value ?? g;
    if (value && Array.isArray(value.slides) && value.slides.length) {
      state.deck = value;
      state.idx = Math.max(0, Math.min(Number(value.idx) || 0, value.slides.length - 1));
      styleEl.value = value.style || "business";
      brandColorEl.value = "#" + (value.brandColor || STYLES[styleEl.value].accent);
      renderAll();
    }
  } catch (e) { /* ignore */ }
}

// ---------- boot ----------
function wire() {
  genBtn.addEventListener("click", generateDeck);
  sampleBtn.addEventListener("click", loadSample);
  exportBtn.addEventListener("click", exportPptx);
  pdfBtn.addEventListener("click", exportPdf);
  regenBtn.addEventListener("click", generateDeck);
  prevBtn.addEventListener("click", () => { if (state.idx > 0) { state.idx--; renderAll(); } });
  nextBtn.addEventListener("click", () => { if (state.deck && state.idx < state.deck.slides.length - 1) { state.idx++; renderAll(); } });
  addSlideBtn.addEventListener("click", addSlide);
  delSlideBtn.addEventListener("click", deleteCurrent);
  imgAiBtn.addEventListener("click", generateSlideImage);
  imgUploadBtn.addEventListener("click", () => imgFileEl.click());
  imgFileEl.addEventListener("change", onUploadImage);
  imgClearBtn.addEventListener("click", clearSlideImage);
  imgUrlBtn.addEventListener("click", useImageUrl);
  imgUrlEl.addEventListener("keydown", (e) => { if (e.key === "Enter") useImageUrl(); });
  outlineList.addEventListener("click", onOutlineClick);
  [edTitle, edBullets, edNotes].forEach((el) => el.addEventListener("input", onEdit));
  styleEl.addEventListener("change", () => {
    brandColorEl.value = "#" + STYLES[styleEl.value].accent;
    if (state.deck) { state.deck.style = styleEl.value; state.deck.brandColor = brandColorEl.value.slice(1); renderAll(); scheduleSave(); }
  });
  brandColorEl.addEventListener("input", () => {
    if (state.deck) { state.deck.brandColor = brandColorEl.value.slice(1); renderPreview(); renderOutline(); }
  });
  brandColorEl.addEventListener("change", scheduleSave);
  window.addEventListener("resize", fitPreview);
}
async function main() {
  wire(); renderOutline(); renderImageTools(); fitPreview();
  try {
    anna = await AnnaAppRuntime.connect();
    document.documentElement.dataset.theme = anna.theme || "light";
    anna.onThemeChange && anna.onThemeChange(({ theme }) => (document.documentElement.dataset.theme = theme));
    await loadDeck();
    // Opened from chat with a topic payload -> prefill and generate
    if (anna.entryPayload && anna.entryPayload.topic) {
      topicEl.value = anna.entryPayload.topic;
      generateDeck();
    }
  } catch (e) {
    // Standalone preview (no host) — sample + both exports still work.
    document.documentElement.dataset.theme = "light";
  }
}
main();
