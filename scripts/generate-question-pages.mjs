#!/usr/bin/env node
/**
 * scripts/generate-question-pages.mjs
 *
 * 讀取 exam-data.js，為護理師國考題庫產生：
 *   - 個別題目靜態頁 /questions/{year}-{sitting}/{subject}-{no3}.html
 *   - 該次考卷索引 /questions/{year}-{sitting}/index.html
 *   - 該次考卷單科索引 /questions/{year}-{sitting}/{subject}/index.html
 *   - 題庫總索引 /questions/index.html
 *   - 科目索引 /subjects/{subject}/index.html
 *   - 題庫 sitemap /questions/sitemap.xml
 *   - 共用樣式 /assets/css/question-page.css
 *
 * 用法：
 *   node scripts/generate-question-pages.mjs [--src=<repo根目錄，含exam-data.js>] [--out=<輸出根目錄>] [--pilot=115-1]
 *
 * --pilot 可指定只產生某個 {year}-{sitting}（例如 115-1）；不給則產生全部梯次。
 * 輸出內容為完全靜態 HTML，不依賴 JavaScript 即可看到題目、選項、答案、解析。
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

// ---------- 參數解析 ----------
const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
  })
);
const SRC_DIR = path.resolve(args.src || '.');
const OUT_DIR = path.resolve(args.out || '.');
const PILOT = args.pilot || null; // e.g. "115-1"，null 表示全部

// ---------- 科目中繼資料（與 index.html 現有課程選擇卡片文字一致） ----------
const SUBJECTS = {
  medsurg:  { name: '內外科護理學',       short: '內外科',  emoji: '🩺' },
  basicmed: { name: '基礎醫學',           short: '基礎醫學', emoji: '🔬' },
  basic:    { name: '基本護理學與護理行政', short: '基護',   emoji: '📋' },
  obpeds:   { name: '產兒科護理學',       short: '產兒科',  emoji: '👶' },
  psych:    { name: '精神衛生與社區護理學', short: '精神科',  emoji: '🧠' },
};
const SUBJECT_ORDER = ['medsurg', 'basicmed', 'basic', 'obpeds', 'psych'];

const SITE_ROOT = 'https://rexnursing.github.io/rex_nursing/';
const SITE_NAME = 'Rex Nursing';

// ---------- 讀取 exam-data.js 並在沙盒中執行，取得正規化後的 QS / EXAM_SESSIONS ----------
function loadExamData() {
  const file = path.join(SRC_DIR, 'exam-data.js');
  const code = fs.readFileSync(file, 'utf-8');
  const sandbox = {};
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { timeout: 60000 });
  if (!Array.isArray(sandbox.QS)) throw new Error('exam-data.js 未產生 QS 陣列，無法繼續');
  return { QS: sandbox.QS, EXAM_SESSIONS: sandbox.EXAM_SESSIONS || {} };
}

// ---------- 小工具 ----------
function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s) {
  return escapeHtml(s);
}

// 將 exam 代碼（medsurg 是 "115-1"，其餘是 "course-115-1"）轉成 URL 用的 {year}-{sitting} 標籤
function examLabelOf(course, exam) {
  const prefix = course + '-';
  return exam.startsWith(prefix) ? exam.slice(prefix.length) : exam;
}

function parseExamLabel(label) {
  const m = /^(\d+)-(\d+)$/.exec(label);
  if (!m) return { year: label, sitting: '', sittingLabel: label };
  const sittingWords = { '1': '第一次', '2': '第二次', '3': '第三次' };
  return {
    year: m[1],
    sitting: m[2],
    sittingLabel: sittingWords[m[2]] || `第${m[2]}次`,
  };
}

// 依考選部梯次慣例（2月=第一次、7月=第二次、11月=第三次；民國年+1911=西元年）推算穩定的
// lastmod，避免每次執行 sitemap 都填「今天」（見專案規則：不要每次執行都填今天）。
function lastmodFromExamLabel(label) {
  const { year, sitting } = parseExamLabel(label);
  const y = parseInt(year, 10);
  if (!Number.isFinite(y)) return null;
  const gregorianYear = y + 1911;
  const month = sitting === '2' ? '07' : sitting === '3' ? '11' : '02';
  return `${gregorianYear}-${month}-01`;
}

function maxDate(a, b) {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

function stripOptPrefix(s) {
  return String(s || '').replace(/^[A-D][.．、\s]*/, '').trim();
}

// 從題目原文擷取「核心內容」做標題／描述用（見專案討論：以問句標記切開，
// 若切出來的核心太短太籠統，補上正確選項的內容片段，確保每題標題不重複、不空泛）
function makeTitleCore(q, maxLen = 36) {
  let stem = String(q.q || '').trim();
  const tailMarkers = [
    '，下列何者', '，下列哪', '，何者', '，最適合', '，最需要', '，最優先',
    '，宜先', '，應優先', '，應如何', '？①', ' ①', '，可能', '，下列敘述',
    '，何種', '，那一項', '，那一種',
  ];
  let cutIdx = -1;
  for (const m of tailMarkers) {
    const idx = stem.indexOf(m);
    if (idx > 6 && (cutIdx === -1 || idx < cutIdx)) cutIdx = idx;
  }
  let core = cutIdx > -1 ? stem.slice(0, cutIdx) : stem;
  core = core.replace(/[，。？！：；、]+$/, '').trim();

  if (core.length <= 13) {
    const correctIdx = Array.isArray(q.ans) && q.ans.length ? q.ans[0] : 0;
    let optText = stripOptPrefix((q.opts || [])[correctIdx]);
    if (optText.length > 22) {
      let cut = optText.slice(0, 22);
      const b = Math.max(cut.lastIndexOf('，'), cut.lastIndexOf('、'));
      optText = (b > 10 ? cut.slice(0, b) : cut) + '…';
    }
    if (optText) core = core + '：' + optText;
  }

  if (core.length > maxLen) {
    let cut = core.slice(0, maxLen);
    const bIdx = Math.max(cut.lastIndexOf('，'), cut.lastIndexOf('、'));
    core = (bIdx > maxLen * 0.5 ? cut.slice(0, bIdx) : cut) + '…';
  }
  return core;
}

// 極少數情況下（同一情境題組共用一大段題幹、或不同梯次考到同一主題）截短後的核心內容
// 會撞名。用一個跨全程執行的集合把關，一旦偵測到重複就補上題號，保證每頁標題都不同
// （專案規則：每頁標題不可完全相同）。
const usedTitles = new Set();

function makeTitle(q, subjShort, yearLabel, sittingLabel) {
  const core = makeTitleCore(q);
  const suffix = core.endsWith('…') ? '' : '？';
  let title = `${core}${suffix}｜${yearLabel}年護理師國考${subjShort}`;
  if (usedTitles.has(title)) {
    title = `${core}${suffix}（第${q.no}題）｜${yearLabel}年護理師國考${subjShort}`;
  }
  usedTitles.add(title);
  return title;
}

function makeDescription(q, subjName, yearLabel, sittingLabel) {
  const core = makeTitleCore(q, 60);
  const sep = core.endsWith('…') ? '' : '，';
  return `${yearLabel}年${sittingLabel}護理師國考${subjName}題目，內容為${core}${sep}附答案與學習解析。`;
}

const ANS_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

function fmtExpl(expl) {
  // 解析內容內部常見 \n 分段（如逐選項解析），轉成段落，保留原文不做任何修改
  const parts = String(expl || '').split(/\n+/).filter(Boolean);
  if (parts.length <= 1) return `<p>${escapeHtml(expl || '')}</p>`;
  return parts.map(p => `<p>${escapeHtml(p)}</p>`).join('\n');
}

// ---------- 目錄工具 ----------
function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}
function writeFile(relPath, content) {
  const full = path.join(OUT_DIR, relPath);
  ensureDir(path.dirname(full));
  fs.writeFileSync(full, content, 'utf-8');
  return full;
}

// ---------- 共用版型片段 ----------
function pageShell({ titleTag, description, canonical, ogType, bodyHtml, extraHead, cssDepth }) {
  const cssHref = '../'.repeat(cssDepth) + 'assets/css/question-page.css';
  return `<!doctype html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(titleTag)}</title>
<meta name="description" content="${escapeAttr(description)}">
<meta name="robots" content="index, follow">
<meta name="author" content="${SITE_NAME}">
<link rel="canonical" href="${escapeAttr(canonical)}">
<meta property="og:type" content="${ogType || 'article'}">
<meta property="og:title" content="${escapeAttr(titleTag)}">
<meta property="og:description" content="${escapeAttr(description)}">
<meta property="og:url" content="${escapeAttr(canonical)}">
<meta property="og:site_name" content="${SITE_NAME}">
<link rel="stylesheet" href="${cssHref}">
${extraHead || ''}
</head>
<body>
${bodyHtml}
</body>
</html>
`;
}

function breadcrumbJsonLd(items) {
  return `<script type="application/ld+json">
${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((it, i) => ({
      '@type': 'ListItem', position: i + 1, name: it.name, item: it.url,
    })),
  })}
</script>`;
}

// ---------- 產生單一題目頁 ----------
function buildQuestionPage(q, ctx) {
  const { course, examLabel, no3, subj, year, sittingLabel, prevUrl, nextUrl, subjectIndexUrl, examIndexUrl, subjectHomeUrl } = ctx;
  const s = SUBJECTS[course];
  const titleTag = makeTitle(q, s.short, year, sittingLabel);
  const description = makeDescription(q, s.name, year, sittingLabel);
  const canonical = `${SITE_ROOT}questions/${examLabel}/${course}-${no3}.html`;

  const optsHtml = (q.opts || []).map((opt, i) => {
    const correct = Array.isArray(q.ans) && q.ans.includes(i);
    return `<li${correct ? ' data-correct="true"' : ''}>${escapeHtml(opt)}</li>`;
  }).join('\n');

  const correctLabels = (q.ans || []).map(i => ANS_LETTERS[i]).join('、');

  const chapterLine = q.subj ? `科目次分類：${escapeHtml(q.subj)}` : '';

  const bodyHtml = `<header class="qp-nav">
<a href="../../index.html">${SITE_NAME}</a> ›
<a href="${examIndexUrl}">${year}年${sittingLabel}</a> ›
<a href="${subjectIndexUrl}">${escapeHtml(s.name)}</a> ›
第${q.no}題
</header>
<main class="qp-main">
<h1>第${q.no}題（${year}年${sittingLabel}．${escapeHtml(s.name)}）</h1>
<p class="qp-meta">考試年度：${year}年 ｜ 次別：${sittingLabel} ｜ 科目：${escapeHtml(s.name)} ｜ ${chapterLine ? chapterLine + ' ｜ ' : ''}題號：第${q.no}題</p>
<article class="qp-question">
<p class="qp-qtext">${escapeHtml(q.q)}</p>
<ul class="qp-opts">
${optsHtml}
</ul>
<p class="qp-answer">正確答案：${correctLabels}</p>
<div class="qp-expl">
<h2>解析</h2>
${fmtExpl(q.expl)}
</div>
<p class="qp-disclaimer">解析由 AI 協助整理，僅供國考學習參考，如發現內容有誤歡迎回報或私訊 Instagram <a href="https://instagram.com/rex_nursing" target="_blank" rel="noopener">@Rex_Nursing</a> 指正。</p>
</article>
<nav class="qp-pagenav">
${prevUrl ? `<a href="${prevUrl}">← 上一題</a>` : '<span></span>'}
<a href="${examIndexUrl}">回本次考卷題目列表</a>
${nextUrl ? `<a href="${nextUrl}">下一題 →</a>` : '<span></span>'}
</nav>
<nav class="qp-links">
<a href="${subjectIndexUrl}">返回本次${escapeHtml(s.name)}題目列表</a>
<a href="${subjectHomeUrl}">返回${escapeHtml(s.name)}題庫</a>
<a href="../../index.html">返回 ${SITE_NAME} 首頁</a>
<a href="../../index.html#quiz">開啟互動作答模式</a>
</nav>
</main>`;

  const extraHead = breadcrumbJsonLd([
    { name: '首頁', url: SITE_ROOT },
    { name: '護理師國考題庫', url: `${SITE_ROOT}questions/index.html` },
    { name: `${year}年${sittingLabel}`, url: `${SITE_ROOT}questions/${examLabel}/index.html` },
    { name: s.name, url: `${SITE_ROOT}questions/${examLabel}/${course}/index.html` },
    { name: `第${q.no}題`, url: canonical },
  ]);

  return pageShell({ titleTag, description, canonical, ogType: 'article', bodyHtml, extraHead, cssDepth: 2 });
}

// ---------- 產生「該次考卷．單科」索引頁 ----------
function buildExamSubjectIndex(course, examLabel, list, year, sittingLabel) {
  const s = SUBJECTS[course];
  const titleTag = `${year}年${sittingLabel}${s.name}題目列表｜${SITE_NAME}`;
  const description = `${year}年${sittingLabel}護理師國考${s.name}全部題目列表，共${list.length}題，逐題附答案與解析，方便練習與查詢。`;
  const canonical = `${SITE_ROOT}questions/${examLabel}/${course}/index.html`;

  const items = list.map(q => {
    const href = `../${course}-${String(q.no).padStart(3, '0')}.html`;
    return `<li><a href="${href}">第${q.no}題．${escapeHtml(makeTitleCore(q, 40))}</a></li>`;
  }).join('\n');

  const bodyHtml = `<header class="qp-nav">
<a href="../../../index.html">${SITE_NAME}</a> ›
<a href="../index.html">${year}年${sittingLabel}</a> ›
${escapeHtml(s.name)}
</header>
<main class="qp-main">
<h1>${year}年${sittingLabel}．${escapeHtml(s.name)}題目列表</h1>
<p class="qp-meta">共 ${list.length} 題，點選題目可查看完整題幹、選項、答案與解析。</p>
<ol class="qp-list">
${items}
</ol>
<nav class="qp-links">
<a href="../index.html">返回${year}年${sittingLabel}全部科目</a>
<a href="../../../subjects/${course}/index.html">返回${escapeHtml(s.name)}歷屆題庫</a>
<a href="../../../index.html">返回 ${SITE_NAME} 首頁</a>
</nav>
</main>`;

  const extraHead = breadcrumbJsonLd([
    { name: '首頁', url: SITE_ROOT },
    { name: '護理師國考題庫', url: `${SITE_ROOT}questions/index.html` },
    { name: `${year}年${sittingLabel}`, url: `${SITE_ROOT}questions/${examLabel}/index.html` },
    { name: s.name, url: canonical },
  ]);

  return pageShell({ titleTag, description, canonical, ogType: 'website', bodyHtml, extraHead, cssDepth: 3 });
}

// ---------- 產生「該次考卷」總索引頁（各科） ----------
function buildExamIndex(examLabel, subjectGroups, year, sittingLabel) {
  const titleTag = `${year}年${sittingLabel}護理師國考題目列表｜${SITE_NAME}`;
  const totalQ = Object.values(subjectGroups).reduce((a, l) => a + l.length, 0);
  const description = `${year}年${sittingLabel}護理師國考各科題目列表，共${totalQ}題，涵蓋${SUBJECT_ORDER.filter(c => subjectGroups[c]).map(c => SUBJECTS[c].name).join('、')}，附答案與解析。`;
  const canonical = `${SITE_ROOT}questions/${examLabel}/index.html`;

  const cards = SUBJECT_ORDER.filter(c => subjectGroups[c]).map(c => {
    const s = SUBJECTS[c];
    const list = subjectGroups[c];
    return `<li class="qp-card"><a href="./${c}/index.html">${s.emoji} ${escapeHtml(s.name)}（${list.length}題）</a></li>`;
  }).join('\n');

  const bodyHtml = `<header class="qp-nav">
<a href="../../index.html">${SITE_NAME}</a> ›
<a href="../index.html">護理師國考題庫</a> ›
${year}年${sittingLabel}
</header>
<main class="qp-main">
<h1>${year}年${sittingLabel}護理師國考題目列表</h1>
<p class="qp-meta">共 ${totalQ} 題，依科目分類，點選進入各科題目列表。</p>
<ul class="qp-cardlist">
${cards}
</ul>
<nav class="qp-links">
<a href="../index.html">返回題庫總索引</a>
<a href="../../index.html">返回 ${SITE_NAME} 首頁</a>
</nav>
</main>`;

  const extraHead = breadcrumbJsonLd([
    { name: '首頁', url: SITE_ROOT },
    { name: '護理師國考題庫', url: `${SITE_ROOT}questions/index.html` },
    { name: `${year}年${sittingLabel}`, url: canonical },
  ]);

  return pageShell({ titleTag, description, canonical, ogType: 'website', bodyHtml, extraHead, cssDepth: 2 });
}

// ---------- 產生題庫總索引頁 ----------
function buildQuestionsIndex(examLabels, sessionsByExam) {
  const titleTag = `護理師國考歷屆題目總覽｜${SITE_NAME}`;
  const description = `護理師國考歷屆試題題目網頁版，依年度、次別、科目整理，內外科、基護、基礎醫學、產兒科、精神衛生與社區護理全部涵蓋，逐題附答案與解析。`;
  const canonical = `${SITE_ROOT}questions/index.html`;

  const sortedLabels = [...examLabels].sort((a, b) => {
    const pa = parseExamLabel(a), pb = parseExamLabel(b);
    if (pa.year !== pb.year) return pb.year.localeCompare(pa.year, 'en', { numeric: true });
    return pb.sitting.localeCompare(pa.sitting, 'en', { numeric: true });
  });

  const items = sortedLabels.map(label => {
    const { year, sittingLabel } = parseExamLabel(label);
    const subs = sessionsByExam[label] || [];
    const subNames = subs.map(c => SUBJECTS[c].short).join('、');
    return `<li><a href="./${label}/index.html">${year}年${sittingLabel}</a>（${escapeHtml(subNames)}）</li>`;
  }).join('\n');

  const subjectCards = SUBJECT_ORDER.map(c => {
    const s = SUBJECTS[c];
    return `<li class="qp-card"><a href="../subjects/${c}/index.html">${s.emoji} ${escapeHtml(s.name)}</a></li>`;
  }).join('\n');

  const bodyHtml = `<header class="qp-nav"><a href="../index.html">${SITE_NAME}</a> › 護理師國考題庫</header>
<main class="qp-main">
<h1>護理師國考歷屆題目總覽</h1>
<p class="qp-intro">Rex Nursing 提供護理師國考歷屆試題練習，涵蓋內外科護理學、基本護理學、產兒科護理學、精神衛生與社區護理及基礎醫學，依年度、科目與章節整理，每題皆附答案與學習解析。</p>
<h2>依科目瀏覽</h2>
<ul class="qp-cardlist">
${subjectCards}
</ul>
<h2>依年度／次別瀏覽</h2>
<ul class="qp-list">
${items}
</ul>
<nav class="qp-links">
<a href="../index.html">返回 ${SITE_NAME} 首頁</a>
<a href="../index.html#quiz">開啟互動作答模式</a>
</nav>
</main>`;

  const extraHead = breadcrumbJsonLd([
    { name: '首頁', url: SITE_ROOT },
    { name: '護理師國考題庫', url: canonical },
  ]);

  return pageShell({ titleTag, description, canonical, ogType: 'website', bodyHtml, extraHead, cssDepth: 1 });
}

// ---------- 產生科目索引頁（跨年度） ----------
function buildSubjectIndex(course, examLabelsForSubject) {
  const s = SUBJECTS[course];
  const titleTag = `${s.name}歷屆國考題目｜${SITE_NAME}`;
  const description = `護理師國考${s.name}歷屆試題題目網頁版，依年度次別整理，逐題附答案與解析，適合分科複習與章節練習。`;
  const canonical = `${SITE_ROOT}subjects/${course}/index.html`;

  const sorted = [...examLabelsForSubject].sort((a, b) => {
    const pa = parseExamLabel(a), pb = parseExamLabel(b);
    if (pa.year !== pb.year) return pb.year.localeCompare(pa.year, 'en', { numeric: true });
    return pb.sitting.localeCompare(pa.sitting, 'en', { numeric: true });
  });

  const items = sorted.map(label => {
    const { year, sittingLabel } = parseExamLabel(label);
    return `<li><a href="../../questions/${label}/${course}/index.html">${year}年${sittingLabel}</a></li>`;
  }).join('\n');

  const bodyHtml = `<header class="qp-nav"><a href="../../index.html">${SITE_NAME}</a> › <a href="../../questions/index.html">護理師國考題庫</a> › ${escapeHtml(s.name)}</header>
<main class="qp-main">
<h1>${s.emoji} ${escapeHtml(s.name)}歷屆國考題目</h1>
<p class="qp-meta">已上線 ${sorted.length} 個梯次，點選進入該次題目列表。</p>
<ul class="qp-list">
${items}
</ul>
<nav class="qp-links">
<a href="../../questions/index.html">返回題庫總索引</a>
<a href="../../index.html">返回 ${SITE_NAME} 首頁</a>
</nav>
</main>`;

  const extraHead = breadcrumbJsonLd([
    { name: '首頁', url: SITE_ROOT },
    { name: '護理師國考題庫', url: `${SITE_ROOT}questions/index.html` },
    { name: s.name, url: canonical },
  ]);

  return pageShell({ titleTag, description, canonical, ogType: 'website', bodyHtml, extraHead, cssDepth: 2 });
}

// ---------- 主流程 ----------
function main() {
  const { QS } = loadExamData();

  // 依 (course, exam) 分組，並解出每題在該梯次中的題號（優先用既有 no，否則用陣列原始順序）
  const groups = new Map(); // key: course|exam -> [{...q, no}]
  for (const q of QS) {
    if (!q.course || !SUBJECTS[q.course]) continue;
    const key = `${q.course}|${q.exam}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(q);
  }

  const byExamLabel = new Map(); // examLabel -> { course: [qWithNo,...] }
  const subjectExamLabels = new Map(); // course -> Set(examLabel)

  for (const [key, list] of groups) {
    const [course, exam] = key.split('|');
    const examLabel = examLabelOf(course, exam);
    if (PILOT && examLabel !== PILOT) continue;

    list.forEach((q, idx) => {
      q.__no = (q.no !== undefined && q.no !== null) ? q.no : idx + 1;
    });
    list.sort((a, b) => a.__no - b.__no);

    if (!byExamLabel.has(examLabel)) byExamLabel.set(examLabel, {});
    byExamLabel.get(examLabel)[course] = list;

    if (!subjectExamLabels.has(course)) subjectExamLabels.set(course, new Set());
    subjectExamLabels.get(course).add(examLabel);
  }

  let pageCount = 0;
  const sitemapUrls = [];
  let siteMaxDate = null;

  for (const [examLabel, subjectGroups] of byExamLabel) {
    const { year, sittingLabel } = parseExamLabel(examLabel);
    const examDate = lastmodFromExamLabel(examLabel);
    siteMaxDate = maxDate(siteMaxDate, examDate);

    for (const course of Object.keys(subjectGroups)) {
      const list = subjectGroups[course];
      const examIndexUrl = '../index.html';
      const subjectIndexUrl = `./${course}/index.html`;
      const subjectHomeUrl = `../../subjects/${course}/index.html`;

      list.forEach((q, i) => {
        const no3 = String(q.__no).padStart(3, '0');
        const prevQ = i > 0 ? list[i - 1] : null;
        const nextQ = i < list.length - 1 ? list[i + 1] : null;
        const prevUrl = prevQ ? `./${course}-${String(prevQ.__no).padStart(3, '0')}.html` : null;
        const nextUrl = nextQ ? `./${course}-${String(nextQ.__no).padStart(3, '0')}.html` : null;

        const html = buildQuestionPage(
          { ...q, no: q.__no },
          { course, examLabel, no3, subj: q.subj, year, sittingLabel, prevUrl, nextUrl, subjectIndexUrl, examIndexUrl, subjectHomeUrl }
        );
        writeFile(`questions/${examLabel}/${course}-${no3}.html`, html);
        pageCount++;
        sitemapUrls.push({ loc: `${SITE_ROOT}questions/${examLabel}/${course}-${no3}.html`, lastmod: examDate, priority: '0.6' });
      });

      const subIdxHtml = buildExamSubjectIndex(course, examLabel, list, year, sittingLabel);
      writeFile(`questions/${examLabel}/${course}/index.html`, subIdxHtml);
      pageCount++;
      sitemapUrls.push({ loc: `${SITE_ROOT}questions/${examLabel}/${course}/index.html`, lastmod: examDate, priority: '0.7' });
    }

    const examIdxHtml = buildExamIndex(examLabel, subjectGroups, year, sittingLabel);
    writeFile(`questions/${examLabel}/index.html`, examIdxHtml);
    pageCount++;
    sitemapUrls.push({ loc: `${SITE_ROOT}questions/${examLabel}/index.html`, lastmod: examDate, priority: '0.7' });
  }

  // 科目索引（跨年度）—— 只針對本次有產生資料的科目；lastmod 取該科目底下最新梯次的日期
  for (const [course, labelSet] of subjectExamLabels) {
    const html = buildSubjectIndex(course, [...labelSet]);
    writeFile(`subjects/${course}/index.html`, html);
    pageCount++;
    const subjMaxDate = [...labelSet].reduce((acc, l) => maxDate(acc, lastmodFromExamLabel(l)), null);
    sitemapUrls.push({ loc: `${SITE_ROOT}subjects/${course}/index.html`, lastmod: subjMaxDate, priority: '0.8' });
  }

  // 題庫總索引；lastmod 取全站最新梯次的日期
  const sessionsByExam = {};
  for (const [examLabel, subjectGroups] of byExamLabel) {
    sessionsByExam[examLabel] = Object.keys(subjectGroups);
  }
  const qIdxHtml = buildQuestionsIndex([...byExamLabel.keys()], sessionsByExam);
  writeFile('questions/index.html', qIdxHtml);
  pageCount++;
  sitemapUrls.push({ loc: `${SITE_ROOT}questions/index.html`, lastmod: siteMaxDate, priority: '0.9' });

  // sitemap.xml（獨立於根目錄 sitemap.xml，避免與既有健康衛教內容自動化流程衝突）
  const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemapUrls.map(u => `  <url><loc>${escapeHtml(u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}<priority>${u.priority}</priority></url>`).join('\n')}
</urlset>
`;
  writeFile('questions/sitemap.xml', sitemapXml);

  // 共用 CSS
  writeFile('assets/css/question-page.css', QUESTION_PAGE_CSS);

  console.log(`完成：產生 ${pageCount} 個 HTML 頁面（不含 sitemap/CSS），涵蓋 ${byExamLabel.size} 個梯次。`);
  console.log(`輸出目錄：${OUT_DIR}`);
  if (PILOT) console.log(`（僅限梯次 ${PILOT}，如需全部梯次請移除 --pilot 參數）`);
}

const QUESTION_PAGE_CSS = `:root{--teal:#4BA6A1;--teal-l:#eaf3f2;--teal-d:#2f7d78;--bd:#e2e6ea;--ink:#1F3B5C;--white:#fff;--muted:#6b7785;--r:10px}
*{box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans TC",sans-serif;margin:0;color:var(--ink);background:#f7f9fa;line-height:1.75;-webkit-text-size-adjust:100%}
.qp-nav{padding:14px 20px;font-size:13.5px;background:var(--white);border-bottom:1px solid var(--bd);color:var(--muted)}
.qp-nav a{color:var(--teal-d);text-decoration:none}
.qp-nav a:hover{text-decoration:underline}
.qp-main{max-width:720px;margin:0 auto;padding:22px 18px 60px}
h1{font-size:20px;line-height:1.5;margin:0 0 8px}
h2{font-size:16px;margin:0 0 8px}
.qp-meta,.qp-intro{font-size:13.5px;color:var(--muted)}
.qp-intro{font-size:14.5px;line-height:1.8;margin:10px 0 22px}
.qp-question{background:var(--white);border:1px solid var(--bd);border-radius:var(--r);padding:20px;margin:16px 0}
.qp-qtext{font-size:17px;font-weight:600;white-space:pre-wrap;word-break:break-word}
.qp-opts{list-style:none;padding:0;margin:14px 0}
.qp-opts li{padding:10px 14px;margin:7px 0;border:1px solid var(--bd);border-radius:8px;font-size:15px;word-break:break-word}
.qp-opts li[data-correct="true"]{border-color:var(--teal);background:var(--teal-l);font-weight:600;color:var(--teal-d)}
.qp-answer{font-weight:700;color:var(--teal-d);font-size:15px}
.qp-expl{margin-top:16px;padding-top:16px;border-top:1px dashed var(--bd)}
.qp-expl p{margin:0 0 10px;white-space:pre-wrap;word-break:break-word}
.qp-disclaimer{font-size:12.5px;color:#8a94a0;margin-top:16px;line-height:1.7}
.qp-disclaimer a{color:var(--teal-d)}
.qp-pagenav{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:14px;margin:18px 0;flex-wrap:wrap}
.qp-pagenav a{color:var(--teal-d);text-decoration:none;padding:8px 4px}
.qp-links{display:flex;flex-direction:column;gap:8px;font-size:14px;margin:18px 0;padding-top:14px;border-top:1px solid var(--bd)}
.qp-links a{color:var(--teal-d);text-decoration:none}
.qp-links a:hover,.qp-pagenav a:hover{text-decoration:underline}
.qp-list{padding-left:0;list-style:none;font-size:15px}
.qp-list li{padding:9px 0;border-bottom:1px solid var(--bd)}
.qp-list a{color:var(--ink);text-decoration:none}
.qp-list a:hover{color:var(--teal-d)}
.qp-cardlist{list-style:none;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;margin:14px 0 26px}
.qp-card a{display:block;background:var(--white);border:1.5px solid var(--bd);border-radius:var(--r);padding:16px;text-align:center;color:var(--ink);text-decoration:none;font-weight:600;font-size:14.5px}
.qp-card a:hover{border-color:var(--teal)}
@media(max-width:480px){.qp-main{padding:16px 14px 50px}.qp-qtext{font-size:16px}h1{font-size:18px}}
`;

main();
