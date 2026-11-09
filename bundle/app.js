// Anna Deck — AI presentation builder (pure-UI Anna App)
// Uses host APIs: anna.llm.complete, anna.image.generate, anna.storage.*
// PptxGenJS (window.PptxGenJS) is vendored locally and used for .pptx export.
import { AnnaAppRuntime } from "/static/anna-apps/_sdk/latest/index.js";

const PptxGenJS = window.PptxGenJS;

const STYLES = {
  business: { label: "商务蓝", bg: "FFFFFF", accent: "1F4E79", text: "1C1E21", sub: "5B6B7B", dark: false },
  minimal:  { label: "极简黑白", bg: "FFFFFF", accent: "111111", text: "222222", sub: "666666", dark: false },
  academic: { label: "学术", bg: "FFFFFF", accent: "2E5A88", text: "1A1A1A", sub: "555555", dark: false },
  tech:     { label: "科技紫", bg: "15102B", accent: "8B5CF6", text: "EDE9FE", sub: "A99FE6", dark: true },
  vibrant:  { label: "活力橙", bg: "FFF7ED", accent: "EA580C", text: "431407", sub: "9A3412", dark: false },
};

const TONE_TEXT = {
  general: "通俗易懂、结构清晰的通用表达",
  investor: "突出商业价值、市场机会与增长逻辑，适合投资人或融资路演",
  exec: "简洁、有结论先行（BLUF），适合管理层或向上汇报",
  student: "循序渐进、讲解细致，适合学生或课程作业",
  sales: "以客户收益与痛点为主线，适合销售或客户沟通",
};

const state = { deck: null, idx: 0 };
let anna = null;

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const topicEl = $("topic"), langEl = $("lang"), countEl = $("count"),
  styleEl = $("style"), toneEl = $("tone"), withImagesEl = $("withImages");
const genBtn = $("genBtn"), sampleBtn = $("sampleBtn"), exportBtn = $("exportBtn"),
  regenBtn = $("regenBtn"), prevBtn = $("prevBtn"), nextBtn = $("nextBtn");
const previewEl = $("preview"), pageInfoEl = $("pageInfo"),
  edTitle = $("edTitle"), edBullets = $("edBullets"), edNotes = $("edNotes"),
  costHint = $("costHint"), toastEl = $("toast");

// ---------- helpers ----------
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}
function toast(msg, isErr = false, kind = null) {
  toastEl.textContent = msg;
  toastEl.className = "toast" + (isErr ? " err" : kind === "ok" ? " ok" : "");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toastEl.classList.add("hidden"), 3200);
}
function setBusy(busy, msg) {
  [genBtn, sampleBtn, exportBtn, regenBtn, prevBtn, nextBtn].forEach((b) => (b.disabled = busy));
  if (busy && msg) genBtn.textContent = msg;
  else genBtn.textContent = "✨ AI 生成";
}
function handleErr(e) {
  const m = e?.error?.message || e?.message || String(e);
  if (/APP_QUOTA_EXCEEDED/.test(m) || /quota/i.test(m)) return "额度不足，请检查账户余额或调小页数/关闭配图。";
  if (/APP_NOT_GRANTED/.test(m)) return "App 未安装/未授权，请先在 Anna 中打开本应用。";
  if (/agent_unavailable/.test(m)) return "未连接到 Anna Agent，请确认已登录并打开应用。";
  if (/network|fetch|Failed to fetch/i.test(m)) return "网络或宿主连接失败，请稍后重试。";
  return m;
}

// ---------- LLM prompt ----------
function buildSystemPrompt(lang, count, tone) {
  const langText = lang === "zh" ? "简体中文" : lang === "en" ? "English" : "与用户输入语言一致";
  return [
    "你是专业的演示文稿策划。基于用户给出的主题或大纲，生成结构清晰、内容专业的幻灯片方案。",
    "规则：",
    "1. 严格只输出一个 JSON 对象，不要解释、不要 markdown 代码块、不要多余文字。",
    "2. 结构：{\"title\":总标题, \"subtitle\":副标题, \"slides\":[{\"title\":每页标题, \"bullets\":[要点字符串数组], \"notes\":演讲备注字符串, \"layout\":\"title\"|\"bullets\"|\"section\"}]}",
    "3. 共生成 " + count + " 页。第 1 页为封面(layout:\"title\")；可用若干 \"section\" 页作为分节；其余为 \"bullets\" 内容页。",
    "4. 每页 bullets 3-6 条，精炼且有信息量；notes 为该页演讲展开说明（2-4 句）。",
    "5. 语言：" + langText + "。语气/受众：" + (TONE_TEXT[tone] || TONE_TEXT.general) + "。",
  ].join("\n");
}
function buildUserPrompt(topic, lang) {
  const t = lang === "en" ? "Please create a slide deck based on this topic/outline" : "请基于以下主题/大纲生成幻灯片方案";
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
    bullets: Array.isArray(x.bullets)
      ? x.bullets.map(String)
      : x.bullets ? [String(x.bullets)] : [],
    notes: String(x.notes || ""),
    layout: x.layout || "bullets",
    image: null,
  }));
  return {
    title: obj.title || "未命名演示",
    subtitle: obj.subtitle || "",
    lang: meta.lang,
    style: meta.style,
    slides,
  };
}

// ---------- generate ----------
async function generateDeck() {
  if (!anna) {
    toast("当前为独立预览，无法调用 AI。请点「载入示例」体验，或在已发布的 Anna App 中生成。", true);
    return;
  }
  const topic = topicEl.value.trim();
  if (!topic) { toast("请先输入主题或大纲", true); return; }
  const lang = langEl.value, count = +countEl.value, styleKey = styleEl.value, tone = toneEl.value;
  setBusy(true, "AI 正在规划幻灯片…");
  try {
    const res = await anna.llm.complete({
      systemPrompt: buildSystemPrompt(lang, count, tone),
      messages: [{ role: "user", content: buildUserPrompt(topic, lang) }],
      maxTokens: 4000,
      temperature: 0.7,
      modelPreferences: { costPriority: 1, speedPriority: 0.5, intelligencePriority: 0.3 },
    });
    const text = res?.content?.text || "";
    const deck = parseDeck(text, { lang, style: styleKey });
    if (!deck.slides.length) throw new Error("AI 返回内容无法解析，请重试");
    state.deck = deck; state.idx = 0;
    await saveDeck();
    renderAll();
    if (withImagesEl.checked) await generateImages(deck);
    const used = res?._meta?.quotaConsumed;
    costHint.textContent = used != null ? `本次生成消耗约 ${used} CU` : "";
    toast("生成完成 🎉", false, "ok");
  } catch (e) {
    toast(handleErr(e), true);
  } finally {
    setBusy(false);
  }
}

async function generateImages(deck) {
  const targets = [];
  deck.slides.forEach((s, i) => {
    if ((i === 0 || s.layout === "section") && targets.length < 3) targets.push(i);
  });
  for (let k = 0; k < targets.length; k++) {
    const i = targets[k];
    try {
      setBusy(true, `正在生成配图 ${k + 1}/${targets.length}…`);
      const r = await anna.image.generate(
        { prompt: `Professional abstract presentation illustration for a slide titled "${deck.slides[i].title}". Modern, clean, no text, brand-quality.`, n: 1, size: "1280x720" },
        { timeoutMs: 120000 }
      );
      const url = r?.images?.[0]?.url;
      if (url) { deck.slides[i].image = await urlToBase64(url); renderPreview(); }
    } catch (e) { console.warn("image gen failed:", e); }
  }
}
async function urlToBase64(url) {
  const resp = await fetch(url);
  const blob = await resp.blob();
  return await new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = rej;
    fr.readAsDataURL(blob);
  });
}

// ---------- sample (zero-credit path) ----------
function loadSample() {
  state.deck = {
    title: "AI 如何重塑个人生产力",
    subtitle: "从工具到协作伙伴",
    lang: "zh",
    style: styleEl.value || "business",
    slides: [
      { title: "AI 如何重塑个人生产力", bullets: ["从工具到协作伙伴", "一次关于效率的范式转移"], notes: "开场先抛出一个问题：你上一次用 AI 省下的时间，用在了哪里？", layout: "title", image: null },
      { title: " Agenda · 今天聊什么", bullets: ["为什么是现在", "三类高频场景", "风险与边界", "落地建议"], notes: "用 30 秒告诉大家今天的结构，让听众有预期。", layout: "section", image: null },
      { title: "为什么是现在", bullets: ["大模型能力跨过可用阈值", "工具成本大幅下降", "工作流集成趋于成熟"], notes: "强调拐点不是单点技术，而是成本、能力、集成三者同时到位。", layout: "bullets", image: null },
      { title: "三类高频场景", bullets: ["写作与摘要：草稿到定稿", "分析：从数据到洞察", "自动化：重复任务的接管"], notes: "每个场景给一个真实例子，避免空泛。", layout: "bullets", image: null },
      { title: "风险与边界", bullets: ["幻觉与事实核查", "隐私与数据边界", "人的最终判断不可外包"], notes: "坦诚谈风险，反而增加可信度。", layout: "bullets", image: null },
      { title: "落地建议", bullets: ["从一个小场景开始", "建立可复用提示模板", "把 AI 当协作者而非替代"], notes: "结尾给出可执行的下一步，方便听众带走。", layout: "bullets", image: null },
    ],
  };
  state.idx = 0;
  saveDeck();
  renderAll();
  toast("已载入示例（无需额度）", false, "ok");
}

// ---------- render ----------
function renderAll() { renderPreview(); renderEditor(); renderNav(); }
function renderNav() {
  const d = state.deck;
  exportBtn.disabled = !d;
  regenBtn.disabled = !d;
  if (!d) { pageInfoEl.textContent = "— / —"; return; }
  pageInfoEl.textContent = `${state.idx + 1} / ${d.slides.length}`;
  prevBtn.disabled = state.idx === 0;
  nextBtn.disabled = state.idx === d.slides.length - 1;
}
function renderPreview() {
  const d = state.deck;
  if (!d) { previewEl.innerHTML = '<div style="margin:auto;opacity:.5">在左侧输入主题并点击「AI 生成」，或先「载入示例」</div>'; return; }
  const style = STYLES[d.style] || STYLES.business;
  const s = d.slides[state.idx];
  const isCover = state.idx === 0;
  previewEl.className = "slide-preview" + (style.dark ? " is-dark" : "");
  previewEl.style.background = "#" + style.bg;
  previewEl.style.color = "#" + style.text;
  let html = "";
  if (isCover) {
    html += `<div class="sp-kicker" style="color:#${style.accent}">PRESENTATION</div>`;
    html += `<div class="sp-title">${escapeHtml(d.title)}</div>`;
    if (d.subtitle) html += `<div class="sp-sub">${escapeHtml(d.subtitle)}</div>`;
  } else {
    html += `<div class="sp-kicker" style="color:#${style.accent}">${s.layout === "section" ? "SECTION" : (state.idx + 1)}</div>`;
    html += `<div class="sp-title">${escapeHtml(s.title)}</div>`;
    if (s.bullets.length) {
      html += '<ul class="sp-bullets">' + s.bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join("") + "</ul>";
    }
  }
  if (s.notes) html += `<div class="sp-notes">🗒 ${escapeHtml(s.notes)}</div>`;
  if (s.image) html += `<img class="sp-image" src="${s.image}" alt="" />`;
  previewEl.innerHTML = html;
}
function renderEditor() {
  const d = state.deck;
  const on = !!d;
  [edTitle, edBullets, edNotes].forEach((el) => (el.disabled = !on));
  if (!d) { edTitle.value = edBullets.value = edNotes.value = ""; return; }
  const s = d.slides[state.idx];
  edTitle.value = s.title;
  edBullets.value = s.bullets.join("\n");
  edNotes.value = s.notes;
}

// ---------- edit ----------
function onEdit() {
  const d = state.deck; if (!d) return;
  const s = d.slides[state.idx];
  s.title = edTitle.value;
  s.bullets = edBullets.value.split("\n").map((x) => x.trim()).filter(Boolean);
  s.notes = edNotes.value;
  renderPreview();
  saveDeck();
}

// ---------- export ----------
async function exportPptx() {
  const d = state.deck; if (!d) return;
  if (!PptxGenJS) { toast("PptxGenJS 未加载，无法导出", true); return; }
  setBusy(true, "正在生成 .pptx…");
  try {
    const style = STYLES[d.style] || STYLES.business;
    const pptx = new PptxGenJS();
    pptx.layout = "LAYOUT_WIDE";
    d.slides.forEach((s, i) => {
      const sl = pptx.addSlide();
      sl.background = { color: style.bg };
      if (i === 0) {
        sl.addText(d.title, { x: 0.7, y: 2.3, w: 11.9, h: 1.6, fontSize: 40, bold: true, color: style.accent });
        if (d.subtitle) sl.addText(d.subtitle, { x: 0.7, y: 4.0, w: 11.9, h: 0.9, fontSize: 20, color: style.sub });
      } else {
        sl.addText(s.title, { x: 0.7, y: 0.5, w: 11.9, h: 1.0, fontSize: 28, bold: true, color: style.accent });
        if (s.image) sl.addImage({ data: s.image, x: 8.6, y: 1.8, w: 4.0, h: 4.4 });
        sl.addText(
          s.bullets.map((b) => ({ text: b, options: { bullet: { indent: 18 } } })),
          {
            x: 0.7, y: 1.8, w: (s.image ? 7.6 : 11.9), h: 4.8,
            fontSize: 18, color: style.text, lineSpacingMultiple: 1.2,
          }
        );
      }
      if (s.notes) sl.addNotes(s.notes);
    });
    const blob = await pptx.write({ outputType: "blob" });
    download(blob, (d.title || "anna-deck").replace(/[\\/:*?"<>|]/g, "_") + ".pptx");
    toast("已导出 PPTX ⬇", false, "ok");
  } catch (e) {
    toast("导出失败：" + handleErr(e), true);
  } finally {
    setBusy(false);
  }
}
function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// ---------- persistence ----------
async function saveDeck() {
  if (!anna) return;
  try { await anna.storage.set({ key: "deck", value: state.deck }); } catch (e) { /* ignore */ }
}
async function loadDeck() {
  if (!anna) return;
  try {
    const { value } = await anna.storage.get({ key: "deck" });
    if (value && value.slides && value.slides.length) {
      state.deck = value; state.idx = 0; renderAll();
    }
  } catch (e) { /* ignore */ }
}

// ---------- boot ----------
function wire() {
  genBtn.addEventListener("click", generateDeck);
  sampleBtn.addEventListener("click", loadSample);
  exportBtn.addEventListener("click", exportPptx);
  regenBtn.addEventListener("click", generateDeck);
  prevBtn.addEventListener("click", () => { if (state.idx > 0) { state.idx--; renderAll(); } });
  nextBtn.addEventListener("click", () => { if (state.deck && state.idx < state.deck.slides.length - 1) { state.idx++; renderAll(); } });
  [edTitle, edBullets, edNotes].forEach((el) => el.addEventListener("input", onEdit));
}

async function main() {
  wire();
  try {
    anna = await AnnaAppRuntime.connect();
    document.documentElement.dataset.theme = anna.theme || "light";
    anna.onThemeChange && anna.onThemeChange(({ theme }) => (document.documentElement.dataset.theme = theme));
    await loadDeck();
    // If opened from chat with a topic payload, prefill + auto-generate
    if (anna.entryPayload && anna.entryPayload.topic) {
      topicEl.value = anna.entryPayload.topic;
      generateDeck();
    }
  } catch (e) {
    // Standalone preview (no host) — sample + export still work.
    document.documentElement.dataset.theme = "light";
  }
}
main();
