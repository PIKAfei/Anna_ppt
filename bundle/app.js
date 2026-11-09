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
//   managed auth/storage              -> Anna host storage + sandbox
//   design system                     -> built-in templates + brand color
import { AnnaAppRuntime } from "/static/anna-apps/_sdk/latest/index.js";

const PptxGenJS = window.PptxGenJS;

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

const state = { deck: null, idx: 0 };
let anna = null;

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const topicEl = $("topic"), langEl = $("lang"), countEl = $("count"),
  toneEl = $("tone"), styleEl = $("style"), brandColorEl = $("brandColor"),
  withImagesEl = $("withImages");
const genBtn = $("genBtn"), sampleBtn = $("sampleBtn"), exportBtn = $("exportBtn"),
  pdfBtn = $("pdfBtn"), regenBtn = $("regenBtn"), prevBtn = $("prevBtn"),
  nextBtn = $("nextBtn"), addSlideBtn = $("addSlideBtn"), delSlideBtn = $("delSlideBtn");
const previewEl = $("preview"), pageInfoEl = $("pageInfo"), outlineList = $("outlineList"),
  outlineCount = $("outlineCount"), printDeck = $("printDeck"),
  edTitle = $("edTitle"), edBullets = $("edBullets"), edNotes = $("edNotes"),
  costHint = $("costHint"), toastEl = $("toast");

// ---------- helpers ----------
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
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
  [genBtn, sampleBtn, exportBtn, pdfBtn, regenBtn, prevBtn, nextBtn, addSlideBtn, delSlideBtn]
    .forEach((b) => (b.disabled = busy));
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

// ---------- LLM prompt: outline-first, audience-aware ----------
function buildSystemPrompt(lang, count, tone) {
  const langText = lang === "zh" ? "简体中文" : lang === "en" ? "English" : "与用户输入语言一致";
  return [
    "你是专业的演示文稿策划顾问。基于用户给出的主题、材料或大纲，产出一份结构清晰、内容扎实的幻灯片大纲。",
    "规则：",
    "1. 严格只输出一个 JSON 对象，不要解释、不要 markdown 代码块、不要多余文字。",
    "2. 结构：{\"title\":总标题, \"subtitle\":副标题, \"slides\":[{\"title\":每页标题, \"bullets\":[要点字符串数组], \"notes\":演讲备注字符串, \"layout\":\"title\"|\"bullets\"|\"section\"}]}",
    "3. 共生成 " + count + " 页。第 1 页为封面(layout:\"title\")；可穿插 \"section\" 分节页；其余为 \"bullets\" 内容页。",
    "4. 标题写成明确的短句；每页 bullets 3-5 条，信息具体、避免空话套话。",
    "5. notes 为该页演讲者备注（2-3 句），便于讲解时展开。",
    "6. 语言：" + langText + "。受众与语气：" + (TONE_TEXT[tone] || TONE_TEXT.general) + "。",
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
    image: null,
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
    if (withImagesEl.checked) await generateImages(deck);
    const used = res?._meta?.quotaConsumed;
    costHint.textContent = used != null ? `本次生成消耗约 ${used} CU` : "";
    toast("大纲已生成，可直接编辑 ✏️", false, "ok");
  } catch (e) {
    toast(handleErr(e), true);
  } finally { setBusy(false); }
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
      const data = unwrap(await anna.image.generate(
        { prompt: `Professional abstract presentation visual for a slide titled "${deck.slides[i].title}". Modern, clean, no text, brand-safe.`, n: 1, size: "1280x720" },
        { timeoutMs: 120000 }
      ));
      const url = data?.images?.[0]?.url;
      if (url) { deck.slides[i].image = await urlToBase64(url); renderAll(); }
    } catch (e) { console.warn("image gen failed:", e); }
  }
  await saveDeck();
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

// ---------- sample: general topic, zero-credit ----------
function loadSample() {
  state.deck = {
    title: "AI 如何重塑个人生产力",
    subtitle: "从工具到协作伙伴 · 通识分享",
    lang: "zh",
    style: styleEl.value || "business",
    brandColor: brandColorEl.value.replace("#", ""),
    slides: [
      { title: "AI 如何重塑个人生产力", bullets: ["从工具到协作伙伴", "一次关于效率的范式转移", "人人都用得上的三个场景"], notes: "开场先抛问题：你上一次用 AI 省下的时间，用在了哪里？", layout: "title", image: null },
      { title: "今天聊什么", bullets: ["为什么是现在", "三类高频场景", "风险与边界", "上手建议"], notes: "30 秒交代结构，让听众有预期。", layout: "section", image: null },
      { title: "为什么是现在", bullets: ["大模型能力跨过可用阈值", "使用成本大幅下降", "与日常工具集成趋于成熟"], notes: "强调拐点来自能力、成本、集成三者同时到位。", layout: "bullets", image: null },
      { title: "三类高频场景", bullets: ["写作与摘要：从草稿到定稿", "资料整理：从杂乱到结构化", "学习辅助：把难点讲成例子"], notes: "每个场景给一个学生和上班族都能对号入座的例子。", layout: "bullets", image: null },
      { title: "风险与边界", bullets: ["幻觉与事实核查", "隐私与数据边界", "人的判断不可外包"], notes: "坦诚谈风险，反而增加可信度。", layout: "bullets", image: null },
      { title: "上手建议", bullets: ["从一个小场景开始", "积累可复用的提示模板", "把 AI 当协作者而非替代"], notes: "结尾给出可执行的下一步。", layout: "bullets", image: null },
    ],
  };
  state.idx = 0; saveDeck(); renderAll();
  toast("已载入示例（无需额度）", false, "ok");
}

// ---------- render ----------
function renderAll() { renderPreview(); renderEditor(); renderNav(); renderOutline(); }
function renderNav() {
  const d = state.deck;
  [exportBtn, pdfBtn, regenBtn, addSlideBtn, delSlideBtn].forEach((b) => (b.disabled = !d));
  if (!d) { pageInfoEl.textContent = "— / —"; return; }
  pageInfoEl.textContent = `${state.idx + 1} / ${d.slides.length}`;
  prevBtn.disabled = state.idx === 0;
  nextBtn.disabled = state.idx === d.slides.length - 1;
}
function renderPreview() {
  const d = state.deck;
  if (!d) { previewEl.innerHTML = '<div style="margin:auto;opacity:.5">输入主题并「生成大纲」，或点「示例」预览</div>'; return; }
  const style = STYLES[d.style] || STYLES.business;
  const accent = accentOf(d);
  const s = d.slides[state.idx];
  const isCover = state.idx === 0;
  previewEl.className = "slide-preview" + (style.dark ? " is-dark" : "");
  previewEl.style.background = "#" + style.bg;
  previewEl.style.color = "#" + style.text;
  let html = "";
  if (isCover) {
    html += `<div class="sp-kicker" style="color:#${accent}">PRESENTATION</div>`;
    html += `<div class="sp-title">${escapeHtml(d.title)}</div>`;
    if (d.subtitle) html += `<div class="sp-sub">${escapeHtml(d.subtitle)}</div>`;
  } else {
    html += `<div class="sp-kicker" style="color:#${accent}">${s.layout === "section" ? "SECTION" : String(state.idx + 1).padStart(2, "0")}</div>`;
    html += `<div class="sp-title">${escapeHtml(s.title)}</div>`;
    if (s.bullets.length) html += '<ul class="sp-bullets">' + s.bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join("") + "</ul>";
  }
  if (s.notes) html += `<div class="sp-notes">🗒 ${escapeHtml(s.notes)}</div>`;
  if (s.image) html += `<img class="sp-image" src="${s.image}" alt="" />`;
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
  renderPreview(); renderOutline(); saveDeck();
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
    renderAll(); saveDeck(); return;
  }
  const li = e.target.closest("li[data-i]");
  if (li) { state.idx = +li.dataset.i; renderAll(); }
}
function addSlide() {
  const d = state.deck; if (!d) return;
  d.slides.splice(state.idx + 1, 0, { title: "新幻灯片", bullets: ["要点一", "要点二"], notes: "", layout: "bullets", image: null });
  state.idx++;
  renderAll(); saveDeck();
}
function deleteCurrent() {
  const d = state.deck; if (!d || d.slides.length <= 1) { toast("至少保留一页", true); return; }
  d.slides.splice(state.idx, 1);
  state.idx = Math.max(0, Math.min(state.idx, d.slides.length - 1));
  renderAll(); saveDeck();
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
      if (i === 0) {
        sl.addText(d.title, { x: 0.7, y: 2.3, w: 11.9, h: 1.6, fontSize: 40, bold: true, color: accent });
        if (d.subtitle) sl.addText(d.subtitle, { x: 0.7, y: 4.0, w: 11.9, h: 0.9, fontSize: 20, color: style.sub });
      } else {
        sl.addText(s.title, { x: 0.7, y: 0.5, w: 11.9, h: 1.0, fontSize: 28, bold: true, color: accent });
        if (s.image) sl.addImage({ data: s.image, x: 8.6, y: 1.8, w: 4.0, h: 4.4 });
        sl.addText(
          s.bullets.map((b) => ({ text: b, options: { bullet: { indent: 18 } } })),
          { x: 0.7, y: 1.8, w: (s.image ? 7.6 : 11.9), h: 4.8, fontSize: 18, color: style.text, lineSpacingMultiple: 1.2 }
        );
      }
      if (s.notes) sl.addNotes(s.notes);
    });
    const blob = await pptx.write({ outputType: "blob" });
    download(blob, (d.title || "anna-deck").replace(/[\\/:*?"<>|]/g, "_") + ".pptx");
    toast("已导出可编辑 PPTX ⬇", false, "ok");
  } catch (e) {
    toast("导出失败：" + handleErr(e), true);
  } finally { setBusy(false); }
}
function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// ---------- export: PDF via browser print (keeps CJK glyphs, zero deps) ----------
function exportPdf() {
  const d = state.deck; if (!d) return;
  const style = STYLES[d.style] || STYLES.business;
  const accent = accentOf(d);
  printDeck.innerHTML = d.slides.map((s, i) => {
    const cover = i === 0;
    return `<section class="print-slide" style="background:#${style.bg};color:#${style.text}">
      <div class="ps-kicker" style="color:#${accent}">${cover ? "PRESENTATION" : (s.layout === "section" ? "SECTION" : String(i + 1).padStart(2, "0"))}</div>
      <h2 class="ps-title">${escapeHtml(cover ? d.title : s.title)}</h2>
      ${cover && d.subtitle ? `<p class="ps-sub">${escapeHtml(d.subtitle)}</p>` : ""}
      ${!cover && s.bullets.length ? `<ul class="ps-bullets">${s.bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join("")}</ul>` : ""}
      ${s.image ? `<img class="ps-image" src="${s.image}" alt="" />` : ""}
    </section>`;
  }).join("");
  toast("已调起打印，请在对话框选择「另存为 PDF」", false, "ok");
  setTimeout(() => {
    try { window.print(); }
    catch (e) { toast("浏览器阻止了打印，请使用浏览器菜单另存为 PDF", true); }
  }, 250);
}

// ---------- persistence (strip base64 images: runtime_state cap 256 KB) ----------
async function saveDeck() {
  if (!anna || !state.deck) return;
  try {
    const slim = { ...state.deck, slides: state.deck.slides.map((s) => ({ ...s, image: null })) };
    await anna.storage.set({ key: "deck", value: slim });
  } catch (e) { /* ignore */ }
}
async function loadDeck() {
  if (!anna) return;
  try {
    const g = unwrap(await anna.storage.get({ key: "deck" }));
    const value = g?.value ?? g;
    if (value && Array.isArray(value.slides) && value.slides.length) {
      state.deck = value; state.idx = 0;
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
  outlineList.addEventListener("click", onOutlineClick);
  [edTitle, edBullets, edNotes].forEach((el) => el.addEventListener("input", onEdit));
  styleEl.addEventListener("change", () => {
    brandColorEl.value = "#" + STYLES[styleEl.value].accent;
    if (state.deck) { state.deck.style = styleEl.value; state.deck.brandColor = brandColorEl.value.slice(1); renderAll(); saveDeck(); }
  });
  brandColorEl.addEventListener("input", () => {
    if (state.deck) { state.deck.brandColor = brandColorEl.value.slice(1); renderPreview(); renderOutline(); }
  });
  brandColorEl.addEventListener("change", saveDeck);
}
async function main() {
  wire(); renderOutline();
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
