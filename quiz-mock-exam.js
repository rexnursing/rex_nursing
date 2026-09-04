// quiz-mock-exam.js
// Rex Nursing 模擬國考 —— 獨立 session／完整明細保存／可回顧歷史
//
// 修正的根本問題（與 Rex 回報的一致）：
//   1) applyMockAnswerHighlight() 為了隱藏「即時對錯」而把整個 #q-feedback
//      藏起來，但「下一題／查看成績」按鈕 (#next-btn) 剛好也在 #q-feedback
//      裡面，於是連按鈕一起被藏了——這個檔案完全不需要處理這件事，因為
//      新的操作列 (ensureOperationBar) 是獨立注入在 #q-feedback 之外的元素，
//      #q-feedback 要不要隱藏跟操作列完全無關，兩者互不影響。
//   2) 舊版只用共用的 myAnswers（單純「題目 n -> 選了第幾個選項」的全站
//      扁平表）保存進度，沒有「這次是哪 50 題、什麼順序、目前第幾題、
//      絕對截止時間」這種「一場模擬考」等級的資料——這個檔案新增一份完全
//      獨立的 session（rex_mock_session_v1）＋完整明細保存
//      （rex_mock_attempts_v1）來處理。
//
// 設計原則（跟 quiz-sync.js 現有的做法一致）：
//   - 純函式（不碰 DOM／localStorage）跟會碰 DOM 的函式分開放，前者可以在
//     純 Node 環境直接 import 測試，不需要瀏覽器。
//   - 這個檔案完全不知道「reviewIsMockExam」「startReviewList」這些跨
//     複習模式共用的狀態機——那些本來就不是模擬考專屬的，繼續留在
//     quiz-sync.js 裡，由它在對的時機呼叫這裡匯出的函式。
//   - 完全不修改 index.html：所有新增的操作列／續作卡片／歷史明細彈窗都是
//     用 document.createElement 動態插入，插入點沿用既有的
//     ensureMockExamBanner()／ensureSearchUI() 那一套「插在穩定錨點旁邊」
//     的做法。
//   - Firestore 同步文件（users/{uid}，myMockHistory 就存在裡面）本來就已
//     經有 myAnswers／myFlagged 等資料，這裡新增的「完整逐題明細」
//     （questionIds／answers／correctness）刻意只存本機 localStorage，不
//     塞進 myMockHistory／不同步到 Firestore，避免把共用文件養大；
//     myMockHistory 每筆紀錄只多一個很小的 attemptId 指標欄位，用來在
//     「同一台裝置」上把摘要跟本機的完整明細串起來。

// ---------------------------------------------------------------------------
// 常數與資料版本
// ---------------------------------------------------------------------------

export const SESSION_KEY = "rex_mock_session_v1";
export const ATTEMPTS_KEY = "rex_mock_attempts_v1";
export const SESSION_VERSION = 1;
export const ATTEMPT_VERSION = 1;
export const MAX_STORED_ATTEMPTS = 30; // 跟 myMockHistory 的上限一致

// ---------------------------------------------------------------------------
// 純函式 —— 不碰 document／window／localStorage，可以直接在 Node 匯入測試
// ---------------------------------------------------------------------------

let _attemptSeq = 0;
export function generateAttemptId() {
  _attemptSeq = (_attemptSeq + 1) % 1e6;
  return (
    "matt_" +
    Date.now().toString(36) +
    "_" +
    Math.random().toString(36).slice(2, 10) +
    "_" +
    _attemptSeq.toString(36)
  );
}

export function computeRemainingMs(deadline, now) {
  const t = typeof now === "number" ? now : Date.now();
  if (typeof deadline !== "number" || !isFinite(deadline)) return 0;
  return Math.max(0, deadline - t);
}

export function isExpired(deadline, now) {
  const t = typeof now === "number" ? now : Date.now();
  return typeof deadline === "number" && isFinite(deadline) && t >= deadline;
}

export function formatCountdown(totalMs) {
  const totalSec = Math.max(0, Math.round(totalMs / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
}

// 檢查一份從 localStorage 讀出來的物件，形狀是否符合目前版本的 session。
// 版本不符（例如未來改了欄位）或缺必要欄位一律視為無效，呼叫端應該當成
// "沒有可續作的 session" 處理，而不是硬塞進畫面狀態、之後某處爆炸。
export function isValidSessionShape(raw) {
  if (!raw || typeof raw !== "object") return false;
  if (raw.version !== SESSION_VERSION) return false;
  if (typeof raw.attemptId !== "string" || !raw.attemptId) return false;
  if (typeof raw.course !== "string" || !raw.course) return false;
  if (!Array.isArray(raw.questionIds) || raw.questionIds.length === 0) return false;
  if (!raw.answers || typeof raw.answers !== "object") return false;
  if (typeof raw.currentIndex !== "number") return false;
  if (typeof raw.deadline !== "number" || !isFinite(raw.deadline)) return false;
  if (typeof raw.startedAt !== "string") return false;
  return true;
}

// 交卷防重複觸發：跟 mobile app 的 decideFinishSection 是同一個道理——只
// 用一個「正在送出中」的旗標還不夠，必須連 attemptId 一起比對，才能同時擋掉
// 「同一瞬間連按兩次」跟「舊的一場模擬考所綁定的過期回呼，在使用者已經開始
// 下一場之後才觸發」這兩種情況。
export function decideSubmit(context) {
  if (!context || !context.currentAttemptId || context.boundAttemptId !== context.currentAttemptId) {
    return { allow: false, reason: "stale-attempt" };
  }
  if (context.isSubmitting) return { allow: false, reason: "already-submitting" };
  return { allow: true };
}

// 依「這次抽出的題目 id 順序」＋「作答內容」＋「怎麼查一題的正確答案」，
// 重新算一次最終成績。未作答的題目不計入 correct 也不計入 wrong，用
// unanswered 獨立列出（分數計算上兩者效果相同：都不會得分），這樣畫面／
// 保存的明細才能分別顯示「答對／答錯／未作答」三個數字，符合 Rex 的要求。
export function scoreAttempt(questionIds, answers, lookupQuestion) {
  let correct = 0;
  let wrong = 0;
  let unanswered = 0;
  const correctness = {};
  questionIds.forEach(function (qid, idx) {
    const picked = answers[idx];
    if (picked === undefined || picked === null) {
      unanswered++;
      return;
    }
    const q = lookupQuestion(qid);
    const ok = !!(q && Array.isArray(q.ans) && q.ans.includes(picked));
    correctness[idx] = ok;
    if (ok) correct++;
    else wrong++;
  });
  const total = questionIds.length;
  const score = total ? Math.round((correct / total) * 100) : 0;
  return { correct: correct, wrong: wrong, unanswered: unanswered, total: total, score: score, correctness: correctness };
}

// myMockHistory 裡，這次修正之前留下的紀錄只有摘要欄位、沒有 attemptId，
// 用這個判斷式一律視為「舊版」，畫面上顯示固定文案、不嘗試查明細、不報錯。
export function isLegacyHistoryEntry(entry) {
  return !entry || !entry.attemptId;
}

// 這個檔案是獨立的 ES module，跟 quiz-sync.js（本身有自己一份 escapeHtml）
// 及 index.html（自己也有一份 escapeQuizHtml，但是用 const 宣告、不會掛在
// window 上）都不共用作用域，所以另外備一份——題目文字理論上都是 Rex 自己
// 整理進題庫的內容，不是使用者輸入，風險很低，但插入 innerHTML 前一律跳脫
// 還是比較保險的作法。
export function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

// ---------------------------------------------------------------------------
// localStorage 存取 —— session（進行中）與 attempts（完整明細，本機專用）
// ---------------------------------------------------------------------------

export function saveSession(session) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    return true;
  } catch (e) {
    console.error("[quiz-mock-exam] session 保存失敗", e);
    return false;
  }
}

export function loadSession() {
  try {
    const raw = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
    return isValidSessionShape(raw) ? raw : null;
  } catch (e) {
    return null;
  }
}

export function clearSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch (e) {}
}

function loadAllAttempts() {
  try {
    const raw = JSON.parse(localStorage.getItem(ATTEMPTS_KEY) || "[]");
    return Array.isArray(raw) ? raw : [];
  } catch (e) {
    return [];
  }
}

function saveAllAttempts(list) {
  try {
    localStorage.setItem(ATTEMPTS_KEY, JSON.stringify(list));
    return true;
  } catch (e) {
    console.error("[quiz-mock-exam] 完整明細保存失敗", e);
    return false;
  }
}

// 交卷時呼叫。回傳是否保存成功——呼叫端（quiz-sync.js）必須先確認這裡回傳
// true，才可以清掉進行中的 session；保存失敗要保留 session、提示使用者
// 稍後再試，不能假裝已經交卷成功。
export function saveAttemptDetail(detail) {
  const list = loadAllAttempts();
  // 用 attemptId 去重：理論上交卷只會呼叫一次（有 decideSubmit 防重複），
  // 但保存本身是可以重試的操作（例如第一次 setItem 失敗、使用者手動重試），
  // 這裡多一層保險，同一個 attemptId 不會在明細清單裡出現兩筆。
  const filtered = list.filter(function (a) {
    return a.attemptId !== detail.attemptId;
  });
  filtered.unshift(detail);
  if (filtered.length > MAX_STORED_ATTEMPTS) filtered.length = MAX_STORED_ATTEMPTS;
  return saveAllAttempts(filtered);
}

export function loadAttemptDetail(attemptId) {
  return (
    loadAllAttempts().find(function (a) {
      return a.attemptId === attemptId;
    }) || null
  );
}

// ---------------------------------------------------------------------------
// UI 元件 —— 全部用 document.createElement 動態注入，不改 index.html。
// ---------------------------------------------------------------------------

const PALETTE = {
  navy: "#1F3B5C",
  teal: "#4BA6A1",
  tealDark: "#317f7a",
  tealLight: "#e3f1f0",
  white: "#fff",
  border: "rgba(31,59,92,.14)",
  muted: "#64748b",
  danger: "#993c1d",
  dangerBg: "#faece7",
};

// -------------------- 通用的自訂確認彈窗（可自訂按鈕文字） --------------------
// 原生 confirm() 沒辦法自訂按鈕文字（Rex 明確要求「繼續檢查答案」／
// 「交卷並查看解析」這種具體字樣），所以另外做一個輕量彈窗，樣式跟既有的
// gsearch-overlay／gsearch-panel 同一套（fixed 遮罩＋置中卡片）。
export function showMockConfirm(options) {
  const title = options.title || "";
  const message = options.message || "";
  const confirmText = options.confirmText || "確定";
  const cancelText = options.cancelText || "取消";
  const onConfirm = options.onConfirm || function () {};
  const onCancel = options.onCancel || function () {};
  const danger = !!options.danger;
  // 三選一情境（例如：偵測到已有未完成的模擬考 session，需要「繼續上次」／
  // 「放棄並開始新的」／「取消」三個各自獨立、後果不同的選項，不能只靠
  // 2 個按鈕硬湊）才需要帶 extraText/onExtra；不帶的話跟原本完全一樣，
  // 不影響既有呼叫端（50 題完成提示／交卷確認都只用 2 按鈕版本）。
  const extraText = options.extraText || null;
  const onExtra = options.onExtra || function () {};

  const overlay = document.createElement("div");
  overlay.className = "mock-confirm-overlay";
  overlay.style.cssText =
    "position:fixed;inset:0;background:rgba(15,23,32,.45);z-index:400;display:flex;align-items:center;justify-content:center;padding:20px";

  const card = document.createElement("div");
  card.style.cssText =
    "background:" +
    PALETTE.white +
    ";border-radius:20px;max-width:380px;width:100%;padding:24px 22px;box-shadow:0 20px 60px rgba(0,0,0,.28)";

  const titleEl = document.createElement("div");
  titleEl.style.cssText = "font-size:17px;font-weight:700;color:" + PALETTE.navy + ";margin-bottom:10px;line-height:1.5";
  titleEl.textContent = title;

  const msgEl = document.createElement("div");
  msgEl.style.cssText = "font-size:13.5px;color:" + PALETTE.muted + ";line-height:1.75;margin-bottom:20px;white-space:pre-wrap";
  msgEl.textContent = message;

  const btnRow = document.createElement("div");
  btnRow.style.cssText = "display:flex;gap:10px;flex-wrap:wrap";

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.textContent = cancelText;
  cancelBtn.style.cssText =
    "flex:1;min-width:110px;min-height:44px;border-radius:50px;border:1.5px solid " +
    PALETTE.border +
    ";background:0 0;color:" +
    PALETTE.navy +
    ";font-size:13.5px;font-weight:600;cursor:pointer;font-family:inherit";

  const confirmBtn = document.createElement("button");
  confirmBtn.type = "button";
  confirmBtn.textContent = confirmText;
  confirmBtn.style.cssText =
    "flex:1;min-width:110px;min-height:44px;border-radius:50px;border:none;background:" +
    (danger ? PALETTE.danger : PALETTE.teal) +
    ";color:#fff;font-size:13.5px;font-weight:700;cursor:pointer;font-family:inherit";

  function close() {
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
  }
  cancelBtn.onclick = function () {
    close();
    onCancel();
  };
  confirmBtn.onclick = function () {
    close();
    onConfirm();
  };
  overlay.onclick = function (e) {
    if (e.target === overlay) {
      close();
      onCancel();
    }
  };

  btnRow.appendChild(cancelBtn);
  if (extraText) {
    const extraBtn = document.createElement("button");
    extraBtn.type = "button";
    extraBtn.textContent = extraText;
    extraBtn.style.cssText =
      "flex:1;min-width:110px;min-height:44px;border-radius:50px;border:1.5px solid " +
      PALETTE.danger +
      ";background:0 0;color:" +
      PALETTE.danger +
      ";font-size:13.5px;font-weight:600;cursor:pointer;font-family:inherit";
    extraBtn.onclick = function () {
      close();
      onExtra();
    };
    btnRow.appendChild(extraBtn);
  }
  btnRow.appendChild(confirmBtn);
  card.appendChild(titleEl);
  card.appendChild(msgEl);
  card.appendChild(btnRow);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  return overlay;
}

// -------------------- 固定操作列（上一題／下一題／交卷） --------------------
// 刻意獨立於 #q-feedback 之外（直接掛在 document.body 上、position:fixed），
// 這樣不管 #q-feedback 顯示或隱藏都不會影響這排按鈕；這正是這次要修的根本
// 問題（原本的下一題按鈕在 #q-feedback 裡面，被模擬考的「隱藏即時解析」邏輯
// 一起藏起來）的正確修法方向。
let _barEls = null;
// 按鈕的 onclick 不能直接閉包捕捉呼叫當下的 handlers 參數——DOM
// （_barEls）只會建立一次，但「這是第幾場模擬考」的 handlers 每次開新的一
// 場都會換一份新的（不同的 attemptId）。原本 ensureOperationBar() 在
// _barEls 已存在時直接 return，於是第二場呼叫 showOperationBar() 時新的
// handlers 完全沒有機會生效，按鈕永遠沿用第一場的 onSubmit／onPrev／
// onNext（舊的 attemptId），第二場交卷等於沒反應（decideSubmit 會判定
// stale-attempt）。修法：onclick 一律透過這個可更新的 ref
// （_currentHandlers）間接呼叫，ensureOperationBar()／showOperationBar()
// 每次被呼叫、只要有帶 handlers，就立刻更新這個 ref，不管 DOM 是不是已經
// 建立過。
let _currentHandlers = null;

export function ensureOperationBar(handlers) {
  if (handlers) _currentHandlers = handlers;
  if (_barEls) return _barEls;
  if (!document.getElementById("mock-opbar-style")) {
    const style = document.createElement("style");
    style.id = "mock-opbar-style";
    style.textContent =
      "#mock-opbar{position:fixed;left:0;right:0;bottom:0;z-index:250;background:" +
      PALETTE.white +
      ";border-top:1px solid " +
      PALETTE.border +
      ";box-shadow:0 -8px 24px rgba(31,59,92,.12);padding:10px 14px calc(10px + env(safe-area-inset-bottom,0px));display:none;gap:8px}" +
      "#mock-opbar button{font-family:inherit;cursor:pointer;border:none;min-height:46px;border-radius:50px;font-size:13.5px;font-weight:700}" +
      "#mock-opbar .mo-prev,#mock-opbar .mo-next{flex:0 0 76px;background:" +
      PALETTE.tealLight +
      ";color:" +
      PALETTE.tealDark +
      "}" +
      "#mock-opbar .mo-prev:disabled,#mock-opbar .mo-next:disabled{opacity:.4;cursor:default}" +
      "#mock-opbar .mo-submit{flex:1;background:" +
      PALETTE.navy +
      ";color:#fff}" +
      "@media(max-width:400px){#mock-opbar .mo-prev,#mock-opbar .mo-next{flex-basis:64px;font-size:12px}#mock-opbar .mo-submit{font-size:12.5px}}";
    document.head.appendChild(style);
  }

  const bar = document.createElement("div");
  bar.id = "mock-opbar";

  const prevBtn = document.createElement("button");
  prevBtn.type = "button";
  prevBtn.className = "mo-prev";
  prevBtn.textContent = "← 上一題";

  const nextBtn = document.createElement("button");
  nextBtn.type = "button";
  nextBtn.className = "mo-next";
  nextBtn.textContent = "下一題 →";

  const submitBtn = document.createElement("button");
  submitBtn.type = "button";
  submitBtn.className = "mo-submit";
  submitBtn.textContent = "交卷並查看解析";

  prevBtn.onclick = function () {
    if (_currentHandlers && _currentHandlers.onPrev) _currentHandlers.onPrev();
  };
  nextBtn.onclick = function () {
    if (_currentHandlers && _currentHandlers.onNext) _currentHandlers.onNext();
  };
  submitBtn.onclick = function () {
    if (_currentHandlers && _currentHandlers.onSubmit) _currentHandlers.onSubmit();
  };

  bar.appendChild(prevBtn);
  bar.appendChild(nextBtn);
  bar.appendChild(submitBtn);
  document.body.appendChild(bar);

  _barEls = { bar: bar, prevBtn: prevBtn, nextBtn: nextBtn, submitBtn: submitBtn };
  return _barEls;
}

// 操作列顯示時，畫面最下面的內容才不會被固定列蓋住，需要幫 quiz-area 留一段
// 底部留白；隱藏操作列時要把留白還原，避免影響一般練習模式（一般練習從來
// 不會顯示這條操作列，但保險起見在 hide 的時候一併重設，不留殘值）。
function reserveBottomSpace(px) {
  const quizArea = document.getElementById("quiz-area");
  if (quizArea) quizArea.style.paddingBottom = px ? px + "px" : "";
}

export function showOperationBar(handlers) {
  const els = ensureOperationBar(handlers);
  els.bar.style.display = "flex";
  reserveBottomSpace(74);
  return els;
}

export function hideOperationBar() {
  if (_barEls) _barEls.bar.style.display = "none";
  reserveBottomSpace(0);
}

export function updateOperationBar(state) {
  if (!_barEls) return;
  _barEls.prevBtn.disabled = state.currentIndex <= 0;
  _barEls.nextBtn.disabled = state.currentIndex >= state.total - 1;
  _barEls.nextBtn.textContent = state.currentIndex >= state.total - 1 ? "已是最後一題" : "下一題 →";
}

// -------------------- 續作卡片（course-select 與 quiz-select 共用） --------------------
// 卡片本身是同一個 builder，兩個畫面各自呼叫一次、各自傳入自己的容器
// （container），內容一致，只有插入位置不同——course-select 版不管使用者
// 選了哪一科都會出現；quiz-select 版只在使用者選回同一科時出現。
export function buildResumeCardHtml(summary) {
  const remainMs = computeRemainingMs(summary.deadline, Date.now());
  const remainLabel = remainMs > 0 ? formatCountdown(remainMs) + " 後截止" : "已超過時限，將於繼續作答時自動送出";
  const lastUpdated = summary.updatedAt ? new Date(summary.updatedAt) : null;
  const pad = function (x) {
    return String(x).padStart(2, "0");
  };
  const lastUpdatedLabel = lastUpdated
    ? lastUpdated.getFullYear() + "/" + pad(lastUpdated.getMonth() + 1) + "/" + pad(lastUpdated.getDate()) + " " + pad(lastUpdated.getHours()) + ":" + pad(lastUpdated.getMinutes())
    : "";
  return (
    '<div style="display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;background:linear-gradient(135deg,#317f7a,#1F3B5C);color:#fff;border-radius:18px;padding:16px 20px;margin-bottom:16px;box-shadow:0 8px 20px rgba(31,59,92,.18)">' +
    '<div><div style="font-size:14.5px;font-weight:700;margin-bottom:4px">📝 繼續上次模擬考</div>' +
    '<div style="font-size:12px;opacity:.9;line-height:1.7">科目：' +
    (summary.courseLabel || summary.course) +
    "　·　已完成 " +
    summary.answeredCount +
    " / " +
    summary.total +
    ' 題<br>剩餘時間：' +
    remainLabel +
    (lastUpdatedLabel ? "　·　上次作答：" + lastUpdatedLabel : "") +
    "</div></div>" +
    '<button type="button" class="mock-resume-btn" style="flex-shrink:0;background:#fff;color:#1F3B5C;border:none;border-radius:50px;padding:10px 20px;font-size:13.5px;font-weight:700;cursor:pointer;font-family:inherit">繼續作答 →</button>' +
    "</div>"
  );
}

export function renderResumeCard(container, summary, onContinue) {
  removeResumeCard(container);
  const wrap = document.createElement("div");
  wrap.className = "mock-resume-card";
  wrap.innerHTML = buildResumeCardHtml(summary);
  container.insertBefore(wrap, container.firstChild);
  const btn = wrap.querySelector(".mock-resume-btn");
  if (btn) btn.onclick = onContinue;
  return wrap;
}

export function removeResumeCard(container) {
  const old = container.querySelector(".mock-resume-card");
  if (old) old.remove();
}

// -------------------- 歷次成績清單／明細彈窗 --------------------
// 沿用 gsearch-overlay 的「fixed 遮罩＋置中面板」模式，跟搜尋面板是同一種
// 元件、不同內容，兩者互不干擾（各自獨立的 id／z-index）。
export function openHistoryModal(options) {
  const entries = options.entries || [];
  const courseLabel = options.courseLabel || "";
  const getAttemptDetail = options.getAttemptDetail;
  const getQuestionByN = options.getQuestionByN;

  const overlay = document.createElement("div");
  overlay.id = "mock-history-overlay";
  overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:350;display:flex;align-items:flex-start;justify-content:center;padding:6vh 16px 16px;overflow-y:auto";

  const panel = document.createElement("div");
  panel.style.cssText =
    "background:#fff;max-width:640px;width:100%;border-radius:18px;box-shadow:0 20px 60px rgba(0,0,0,.28);overflow:hidden;margin-bottom:20px";

  const header = document.createElement("div");
  header.style.cssText = "padding:18px 20px;border-bottom:1px solid " + PALETTE.border + ";display:flex;align-items:center;justify-content:space-between;gap:10px";
  header.innerHTML =
    '<div style="font-size:15.5px;font-weight:700;color:' +
    PALETTE.navy +
    '">📊 ' +
    courseLabel +
    ' 模擬考歷次成績</div>';
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.textContent = "✕";
  closeBtn.setAttribute("aria-label", "關閉");
  closeBtn.style.cssText = "background:none;border:none;font-size:18px;color:" + PALETTE.muted + ";cursor:pointer;flex-shrink:0";
  closeBtn.onclick = function () {
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
  };
  header.appendChild(closeBtn);

  const body = document.createElement("div");
  body.style.cssText = "padding:8px 0";

  if (!entries.length) {
    body.innerHTML = '<div style="padding:30px 20px;text-align:center;color:' + PALETTE.muted + ';font-size:13.5px">這科目前還沒有模擬考成績。</div>';
  } else {
    entries.forEach(function (h) {
      const row = document.createElement("div");
      row.style.cssText =
        "display:flex;align-items:center;justify-content:space-between;gap:10px;padding:13px 20px;border-bottom:1px dashed " +
        PALETTE.border +
        ";cursor:pointer";
      const d = new Date(h.date);
      const pad = function (x) {
        return String(x).padStart(2, "0");
      };
      const dateStr = d.getFullYear() + "/" + pad(d.getMonth() + 1) + "/" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
      const badge = h.passed
        ? '<span style="color:#27500a;background:#eaf3de;padding:2px 10px;border-radius:20px;font-size:11px;font-weight:600">及格</span>'
        : '<span style="color:#993c1d;background:#faece7;padding:2px 10px;border-radius:20px;font-size:11px;font-weight:600">未達60分</span>';
      row.innerHTML =
        '<span style="color:' +
        PALETTE.muted +
        ';font-size:12.5px">' +
        dateStr +
        '</span><span style="display:flex;align-items:center;gap:8px"><strong style="color:' +
        PALETTE.navy +
        '">' +
        h.score +
        " 分</strong>" +
        badge +
        '<span style="color:' +
        PALETTE.muted +
        ';font-size:16px">›</span></span>';
      row.onclick = function () {
        renderHistoryDetail(panel, h, getAttemptDetail, getQuestionByN, function () {
          renderHistoryList();
        });
      };
      body.appendChild(row);
    });
  }

  function renderHistoryList() {
    panel.innerHTML = "";
    panel.appendChild(header);
    panel.appendChild(body);
  }
  renderHistoryList();

  overlay.appendChild(panel);
  overlay.onclick = function (e) {
    if (e.target === overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
  };
  document.body.appendChild(overlay);
  return overlay;
}

function renderHistoryDetail(panel, historyEntry, getAttemptDetail, getQuestionByN, onBack) {
  panel.innerHTML = "";

  const header = document.createElement("div");
  header.style.cssText = "padding:16px 20px;border-bottom:1px solid " + PALETTE.border + ";display:flex;align-items:center;gap:10px";
  const backBtn = document.createElement("button");
  backBtn.type = "button";
  backBtn.textContent = "‹ 返回清單";
  backBtn.style.cssText = "background:none;border:none;color:" + PALETTE.tealDark + ";font-size:13px;font-weight:700;cursor:pointer;font-family:inherit";
  backBtn.onclick = onBack;
  header.appendChild(backBtn);
  panel.appendChild(header);

  const body = document.createElement("div");
  body.style.cssText = "padding:18px 20px;max-height:70vh;overflow-y:auto";

  const detail = historyEntry.attemptId ? getAttemptDetail(historyEntry.attemptId) : null;

  if (isLegacyHistoryEntry(historyEntry)) {
    body.innerHTML = '<div style="padding:20px 4px;color:' + PALETTE.muted + ';font-size:13.5px;line-height:1.8">此為舊版成績紀錄，當時尚未保存逐題作答明細。</div>';
    panel.appendChild(body);
    return;
  }
  if (!detail) {
    // 有 attemptId、但這台裝置上查不到明細（例如換了裝置、或本機資料被清
    // 除）——這跟「真正的舊版紀錄」是不同的狀況，不能套用 Rex 指定的舊版
    // 文案（那樣會誤導成「這功能當時就不存在」），改用能反映實際狀況的說明。
    body.innerHTML =
      '<div style="padding:20px 4px;color:' +
      PALETTE.muted +
      ';font-size:13.5px;line-height:1.8">這次模擬考的逐題明細只保存在作答當時使用的裝置上，這台裝置目前查不到明細內容。</div>';
    panel.appendChild(body);
    return;
  }

  const summaryRow = document.createElement("div");
  summaryRow.style.cssText = "display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:18px";
  const stat = function (label, value, color) {
    return (
      '<div style="background:' +
      PALETTE.tealLight +
      ';border-radius:12px;padding:10px 6px;text-align:center">' +
      '<div style="font-size:17px;font-weight:800;color:' +
      (color || PALETTE.tealDark) +
      '">' +
      value +
      "</div>" +
      '<div style="font-size:10.5px;color:' +
      PALETTE.muted +
      ';margin-top:2px">' +
      label +
      "</div></div>"
    );
  };
  summaryRow.innerHTML =
    stat("得分", detail.score + "%", PALETTE.navy) +
    stat("答對", detail.correctCount, "#27500a") +
    stat("答錯", detail.wrongCount, PALETTE.danger) +
    stat("未作答", detail.unansweredCount, "#92400e");
  body.appendChild(summaryRow);

  if (detail.autoSubmitted) {
    const note = document.createElement("div");
    note.style.cssText = "font-size:11.5px;color:" + PALETTE.muted + ";margin-bottom:14px";
    note.textContent = "⏰ 這次是時間到自動交卷。";
    body.appendChild(note);
  }

  const list = document.createElement("div");
  const letters = ["A", "B", "C", "D"];
  detail.questionIds.forEach(function (qid, idx) {
    const q = getQuestionByN(qid);
    if (!q) return;
    const picked = detail.answers[idx];
    const answered = picked !== undefined && picked !== null;
    const ok = detail.correctness[idx];
    const row = document.createElement("div");
    const bg = !answered ? "#F5F1E6" : ok ? "#EAF3DE" : "#FAECE7";
    row.style.cssText = "margin-bottom:12px;padding:13px 15px;background:" + bg + ";border-radius:12px";
    const answerLine = !answered
      ? '<div style="font-size:12px;color:#92400e;margin-top:4px">這題當時未作答</div>'
      : '<div style="font-size:12px;color:' +
        (ok ? "#27500a" : "#7f2b10") +
        ';margin-top:4px">你的答案：' +
        (letters[picked] || "?") +
        "　正確答案：" +
        q.ans.map(function (a) {
          return letters[a];
        }).join(" 或 ") +
        "</div>";
    row.innerHTML =
      '<div style="font-size:11.5px;font-weight:700;color:' +
      PALETTE.muted +
      '">第 ' +
      (idx + 1) +
      " 題．" +
      escapeHtml(q.subj || "") +
      "</div>" +
      '<div style="font-size:13px;line-height:1.7;margin-top:4px;color:#1c2733">' +
      escapeHtml(q.q || "") +
      "</div>" +
      answerLine +
      (q.expl ? '<div style="font-size:12px;color:#475569;margin-top:8px;line-height:1.7">' + escapeHtml(q.expl) + "</div>" : "");
    list.appendChild(row);
  });
  body.appendChild(list);
  panel.appendChild(body);
}
