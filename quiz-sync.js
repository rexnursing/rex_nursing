// quiz-sync.js
// Rex Nursing 練習考題 —— Google 登入與跨裝置進度同步
//
// 獨立於 index.html 之外，用 ES module 方式載入（<script type="module" src="quiz-sync.js">），
// 不需要任何建構工具，直接透過 Firebase 官方 CDN 取得 SDK。
//
// 本檔案負責兩件事：
// 1) Google 登入／登出（維持原本行為）。
// 2) 答題進度的「本機永久保存＋登入後跨裝置同步」：
//    - 不論有沒有登入，答題狀態一律先存進 localStorage（key: rex_quiz_myprogress_v1），
//      重新整理、關掉分頁、下次再打開都還在。
//    - 登入後，會把本機資料跟 Firestore（users/{uid}）雲端資料合併（雲端優先、本機獨有的補進去），
//      之後每次作答都會同時寫回本機與雲端。
//    - 這裡完全不修改 index.html 既有的 selectOpt()/renderQ()/startExam() 等函式本體，
//      而是用「包一層」的方式在它們執行完之後，另外做記錄／還原，降低對現有程式碼的風險。
//      （前提：index.html 那邊把 qList/qIdx/answered/cntOk/cntBad 的宣告從 let 改成 var，
//        讓這些變數變成 window 底下可以存取的全域變數 —— 這是唯一動到 index.html 既有程式碼的地方。）

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.17.0/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/12.17.0/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.17.0/firebase-firestore.js";
import * as mockExam from "./quiz-mock-exam.js";

// ---------------------------------------------------------------------------
// 章節分類合併：exam-data.js 的每一題（window.QS）原本沒有 section/chapter
// 欄位，這裡用 chapter-taxonomy.js 提供的 id→[section,chapter] 對照表
// （window.CHAPTER_TAXONOMY_BY_ID，key 是題號字串）把新分類欄位掛上去。
// exam-data.js 和 chapter-taxonomy.js 都是一般 <script>（非 module），會在
// 這支 module script 執行前就已經載入完成，所以這裡一定拿得到兩份資料；
// 任一份還沒準備好就直接跳過，不影響頁面其他功能運作（只是章節相關功能
// 會拿不到分類，subj-filter/模擬考/標籤練習等功能會拿不到資料而顯示空白，
// 但不會噴錯讓整頁掛掉）。
// ---------------------------------------------------------------------------
(function mergeChapterTaxonomy() {
  if (!window.QS || !window.CHAPTER_TAXONOMY_BY_ID) return;
  const tax = window.CHAPTER_TAXONOMY_BY_ID;
  window.QS.forEach(function (q) {
    const entry = tax[q.n];
    if (entry) {
      q.section = entry[0];
      q.chapter = entry[1];
    }
  });
})();

const firebaseConfig = {
  apiKey: "AIzaSyDTZqe69W7bOsKypP-dbI5IUllWpVkGUWs",
  authDomain: "rex-nursing-quiz.firebaseapp.com",
  projectId: "rex-nursing-quiz",
  storageBucket: "rex-nursing-quiz.firebasestorage.app",
  messagingSenderId: "71721098366",
  appId: "1:71721098366:web:69245631ae7810c3978c2f",
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const provider = new GoogleAuthProvider();

let currentUser = null;

function dispatchAuthChange() {
  window.dispatchEvent(
    new CustomEvent("quizauthchange", { detail: { user: currentUser } })
  );
}

async function login() {
  try {
    await signInWithPopup(auth, provider);
  } catch (err) {
    console.error("[quiz-sync] 登入失敗", err);
    if (err && err.code === "auth/popup-blocked") {
      alert("瀏覽器封鎖了登入視窗，請允許彈出視窗後再試一次。");
    } else if (err && err.code === "auth/cancelled-popup-request") {
      // 使用者自己關掉視窗或連續點擊，不用特別提示
    } else {
      alert("登入時發生問題，請稍後再試一次。");
    }
  }
}

async function logout() {
  try {
    await signOut(auth);
  } catch (err) {
    console.error("[quiz-sync] 登出失敗", err);
  }
}

// ---------------------------------------------------------------------------
// 資料層：myAnswers = { [題目全站唯一 n]: 選了第幾個選項 }
//         myFlagged = { [n]: true }  （疑難標記，下一階段 UI 才會用到，這裡先把資料層一起做好）
// ---------------------------------------------------------------------------

const LOCAL_KEY = "rex_quiz_myprogress_v1";
const PENDING_SYNC_KEY = "rex_quiz_pending_sync_v1";

function loadLocal() {
  try {
    const raw = JSON.parse(localStorage.getItem(LOCAL_KEY) || "{}");
    return {
      answers: raw.answers || {},
      flagged: raw.flagged || {},
      mockHistory: raw.mockHistory || [],
    };
  } catch (e) {
    return { answers: {}, flagged: {}, mockHistory: [] };
  }
}

let { answers: myAnswers, flagged: myFlagged, mockHistory: myMockHistory } = loadLocal();

function saveLocal() {
  try {
    localStorage.setItem(
      LOCAL_KEY,
      JSON.stringify({
        answers: myAnswers,
        flagged: myFlagged,
        mockHistory: myMockHistory,
      })
    );
  } catch (e) {
    console.error("[quiz-sync] 本機儲存失敗", e);
  }
}

function markPendingSync(pending) {
  try {
    if (pending) localStorage.setItem(PENDING_SYNC_KEY, "1");
    else localStorage.removeItem(PENDING_SYNC_KEY);
  } catch (e) {}
}

function hasPendingSync() {
  try {
    return localStorage.getItem(PENDING_SYNC_KEY) === "1";
  } catch (e) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// PWA離線支援新增：安全合併同步。
//
// 舊版 pushToCloud() 是「整份覆蓋」寫入雲端——手機離線刷題後、恢復連線
// 才推送，如果同一段時間另一台裝置也同步過，整份覆蓋會讓那台裝置的
// 紀錄憑空消失。改成「每次寫雲端前先重新讀一次雲端最新狀態、合併後才
// 寫回」，兩個方向共用同一組合併函式，差別只在「誰蓋過誰」：
//   - mergeKeyMap(base, overlay)：answers／flagged 這種「key -> 目前狀態」
//     的資料，結果 = base 與 overlay 的聯集，衝突時 overlay 蓋過 base。
//     登入合併時 overlay 傳雲端（代表其他裝置已同步過的最新狀態）；
//     推送合併時 overlay 傳本機（本機剛做的動作要蓋過雲端上比較舊的值），
//     但雲端獨有、本機不知道的題目一樣會保留，不會整份蓋掉。
//   - mergeMockHistoryList()：mockHistory 是不會互相覆蓋的紀錄陣列，
//     用 date+course 當去重鍵取聯集即可，方向不影響結果。
// ---------------------------------------------------------------------------

function mergeKeyMap(base, overlay) {
  return Object.assign({}, base || {}, overlay || {});
}

function mergeMockHistoryList(a, b) {
  const merged = (a || []).slice();
  const seen = new Set(merged.map((h) => h.date + "|" + h.course));
  (b || []).forEach((h) => {
    const key = h.date + "|" + h.course;
    if (!seen.has(key)) {
      merged.push(h);
      seen.add(key);
    }
  });
  merged.sort((a, b) => (a.date < b.date ? 1 : -1));
  if (merged.length > 30) merged.length = 30;
  return merged;
}

async function readCloudDoc(uid) {
  const ref = doc(db, "users", uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) return { answers: {}, flagged: {}, mockHistory: [] };
  const d = snap.data();
  return {
    answers: d.answers || {},
    flagged: d.flagged || {},
    mockHistory: d.mockHistory || [],
  };
}

// pushInFlight/pushQueued：避免手機連續作答時，好幾次 pushToCloud() 同時
// 各自跑一次 getDoc+setDoc 互相打架；正在推送時新進來的請求先排隊，
// 等目前這次跑完再自動補推一次，不會漏掉、也不會同時交錯執行。
let pushInFlight = false;
let pushQueued = false;

async function pushToCloud() {
  if (!currentUser) return;
  if (pushInFlight) {
    pushQueued = true;
    return;
  }
  pushInFlight = true;
  try {
    let cloudData;
    try {
      cloudData = await readCloudDoc(currentUser.uid);
    } catch (err) {
      // 讀不到雲端最新狀態（通常是離線中）——不能安全合併就貿然覆蓋，
      // 先標記「還有本機變更沒同步」，本機資料維持原狀，
      // 等恢復連線（見下方 online 事件）或下次登入合併時再補推。
      console.warn("[quiz-sync] 離線或讀取雲端失敗，暫緩推送，等恢復連線後重試", err);
      markPendingSync(true);
      return;
    }

    myAnswers = mergeKeyMap(cloudData.answers, myAnswers);
    myFlagged = mergeKeyMap(cloudData.flagged, myFlagged);
    myMockHistory = mergeMockHistoryList(cloudData.mockHistory, myMockHistory);
    saveLocal();

    await setDoc(doc(db, "users", currentUser.uid), {
      answers: myAnswers,
      flagged: myFlagged,
      mockHistory: myMockHistory,
      updatedAt: serverTimestamp(),
    });
    markPendingSync(false);
  } catch (err) {
    console.error("[quiz-sync] 寫入雲端失敗", err);
    markPendingSync(true);
  } finally {
    pushInFlight = false;
    if (pushQueued) {
      pushQueued = false;
      pushToCloud();
    }
  }
}

// 手機恢復網路連線時，如果先前離線推送失敗留下「待同步」標記，
// 自動重試一次，不用等使用者剛好再手動作答一題才會觸發同步。
window.addEventListener("online", () => {
  if (currentUser && hasPendingSync()) {
    pushToCloud();
  }
});

async function pullAndMergeOnLogin(user) {
  let cloudData;
  try {
    cloudData = await readCloudDoc(user.uid);
  } catch (err) {
    console.error("[quiz-sync] 讀取雲端資料失敗，暫時只用本機資料", err);
    return;
  }

  // 合併規則：雲端資料優先（代表其他裝置已同步過的狀態），
  // 本機這台裝置獨有、雲端還沒有的題目再補進去，不會互相覆蓋掉對方獨有的紀錄。
  const mergedAnswers = mergeKeyMap(myAnswers, cloudData.answers);
  const mergedFlagged = mergeKeyMap(myFlagged, cloudData.flagged);
  const mergedMockHistory = mergeMockHistoryList(cloudData.mockHistory, myMockHistory);

  const changed =
    JSON.stringify(mergedAnswers) !== JSON.stringify(cloudData.answers) ||
    JSON.stringify(mergedFlagged) !== JSON.stringify(cloudData.flagged) ||
    JSON.stringify(mergedMockHistory) !== JSON.stringify(cloudData.mockHistory);

  myAnswers = mergedAnswers;
  myFlagged = mergedFlagged;
  myMockHistory = mergedMockHistory;
  saveLocal();

  if (changed || hasPendingSync()) {
    await pushToCloud();
  }

  // 合併完成後，如果使用者正停留在某份考卷畫面，重新套用一次還原邏輯；
  // 錯題本／疑難標記的題數也可能因為合併雲端資料而改變，一併更新。
  afterQuizListLoaded(true);
  updateReviewBarCounts();
}

function recordAnswer(n, idx) {
  if (n === undefined || n === null) return;
  myAnswers[n] = idx;
  saveLocal();
  if (currentUser) pushToCloud();
  updateReviewBarCounts();
}

function toggleFlag(n) {
  if (n === undefined || n === null) return;
  if (myFlagged[n]) {
    delete myFlagged[n];
  } else {
    myFlagged[n] = true;
  }
  saveLocal();
  if (currentUser) pushToCloud();
  updateReviewBarCounts();
}

// ---------------------------------------------------------------------------
// ⭐ 疑難標記按鈕：注入到題目標籤（q-tag）旁邊，狀態跟著目前題目走。
// q-tag 這個節點本身是既有程式碼重複使用、只改 textContent，不會被整個換掉，
// 所以標記按鈕只要注入一次，之後每次 renderQ() 只需要更新它的顯示狀態即可。
// ---------------------------------------------------------------------------

function ensureQCardResponsiveStyle() {
  if (document.getElementById("qcard-responsive-style")) return;
  const style = document.createElement("style");
  style.id = "qcard-responsive-style";
  style.textContent =
    "@media (max-width:480px){" +
    "#q-card>div:first-child{flex-wrap:wrap}" +
    "#q-card>div:first-child #q-text{flex:1 1 100%;margin-top:8px}" +
    "}";
  document.head.appendChild(style);
}

function ensureFlagButtonStyle() {
  if (document.getElementById("flagbtn-style")) return;
  const style = document.createElement("style");
  style.id = "flagbtn-style";
  style.textContent =
    "@keyframes flagBtnPulse{0%,100%{box-shadow:0 0 0 0 rgba(217,119,6,.4)}50%{box-shadow:0 0 0 6px rgba(217,119,6,0)}}" +
    "#flag-btn.flagbtn-pulse{animation:flagBtnPulse 1.4s ease-in-out 3}";
  document.head.appendChild(style);
}

function ensureFlagButton() {
  let btn = document.getElementById("flag-btn");
  if (btn) return btn;
  const tagEl = document.getElementById("q-tag");
  if (!tagEl || !tagEl.parentElement) return null;
  ensureFlagButtonStyle();

  // 第一次看到這顆按鈕時加脈動動畫提醒，點過一次（或用 localStorage 記錄過）
  // 之後就不再顯示——跟搜尋圖示用的是同一套邏輯。
  const FLAG_SEEN_KEY = "rex_flagbtn_seen_v1";
  let isFirstTimeSeeing = true;
  try {
    isFirstTimeSeeing = !localStorage.getItem(FLAG_SEEN_KEY);
  } catch (e) {
    isFirstTimeSeeing = false;
  }

  btn = document.createElement("button");
  btn.id = "flag-btn";
  btn.type = "button";
  btn.style.cssText =
    "margin-left:8px;display:inline-flex;align-items:center;gap:4px;border:1.5px solid var(--bd);" +
    "background:var(--white);border-radius:50px;padding:4px 12px;font-size:11.5px;font-weight:500;" +
    "color:var(--text);cursor:pointer;font-family:inherit;vertical-align:middle;line-height:1.4";
  if (isFirstTimeSeeing) {
    btn.classList.add("flagbtn-pulse");
  }
  btn.onclick = function () {
    try {
      localStorage.setItem(FLAG_SEEN_KEY, "1");
    } catch (e) {}
    btn.classList.remove("flagbtn-pulse");
    const q = window.qList && window.qList[window.qIdx];
    if (!q) return;
    toggleFlag(q.n);
    updateFlagButton();
  };
  tagEl.parentElement.insertBefore(btn, tagEl.nextSibling);
  return btn;
}

function updateFlagButton() {
  const btn = ensureFlagButton();
  if (!btn) return;
  const q = window.qList && window.qList[window.qIdx];
  const flagged = !!(q && myFlagged[q.n]);
  btn.innerHTML = flagged
    ? "<span>⭐</span><span>已標記</span>"
    : "<span>☆</span><span>標記</span>";
  btn.style.background = flagged ? "#fef3c7" : "var(--white)";
  btn.style.borderColor = flagged ? "#f2c94c" : "var(--bd)";
  btn.style.color = flagged ? "#92400e" : "var(--text)";
  btn.title = flagged ? "取消疑難標記" : "標記為疑難題目，方便之後複習";
}

// ---------------------------------------------------------------------------
// 📕 永久錯題本 ／ ⭐ 疑難標記複習清單
//
// 兩份清單都是「即時從 myAnswers / myFlagged 重新篩出 window.QS」算出來的，
// 不另外維護一份獨立資料——好處是：錯題本裡的題目只要哪天答對了，
// myAnswers[n] 會被更新成正確選項，下次重新打開錯題本時，
// 這一題自然就不在篩選結果裡了（等於自動移出），不用額外寫「移除」的邏輯。
//
// 這兩個複習清單借用既有的 beginQuiz()／renderQ()／selectOpt()／nextQ()／
// showResult() 等函式來呈現（qList 換成這裡組出來的題目陣列即可），
// 但 beginQuiz() 原本假設是從「已選好考卷」畫面（quiz-select）進來，
// 不會主動隱藏最上層的科目選擇畫面（course-select），也不會處理
// 科目篩選列（subj-filter-bar）——這兩件事情原本的程式碼裡沒有對應
// 「跨考卷複習清單」的情境，所以由這裡自己補上，避免畫面同時疊在一起、
// 或是「換考卷」「再做一次」等按鈕跑回去用舊的單一考卷邏輯覆蓋掉複習清單。
// ---------------------------------------------------------------------------

function getWrongQuestions() {
  if (!window.QS) return [];
  return window.QS.filter(function (q) {
    const a = myAnswers[q.n];
    return a !== undefined && !q.ans.includes(a);
  });
}

function getFlaggedQuestions() {
  if (!window.QS) return [];
  return window.QS.filter(function (q) {
    return !!myFlagged[q.n];
  });
}

// 錯題本不再把所有題目直接混成一份。先提供「依科目／章節」與「依考試
// 日期」兩種分類入口，使用者選定範圍後才進入既有的逐題複習畫面。
let wrongBookView = "chapter";
let wrongBookCourse = null;

function wrongBookCourseLabel(course) {
  return (
    (typeof SEARCH_COURSE_LABELS !== "undefined" && SEARCH_COURSE_LABELS[course]) ||
    course ||
    "未分類"
  );
}

function wrongBookExamLabel(exam, questions) {
  const sample = (questions || []).find(function (q) {
    return wrongBookExamKey(q) === exam;
  });
  return (sample && getExamOriginLabel(sample)) || exam || "日期未分類";
}

function wrongBookExamKey(q) {
  const raw = (q && q.exam) || "";
  // 各科代碼有些會帶科目前綴（例如 psych-115-1），分類日期時應和
  // medsurg 的 115-1 視為同一梯次，而不是拆成兩張日期卡。
  const m = /(\d+)-(\d+)$/.exec(raw);
  return m ? m[1] + "-" + m[2] : raw || "未分類";
}

function sortWrongBookExams(a, b) {
  function score(code) {
    const m = /(\d+)-(\d+)$/.exec(code || "");
    return m ? Number(m[1]) * 10 + Number(m[2]) : -1;
  }
  return score(b) - score(a) || String(b).localeCompare(String(a));
}

function makeWrongBookButton(text, count, onClick, options) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.style.cssText =
    "display:flex;align-items:center;justify-content:space-between;gap:10px;" +
    "width:100%;min-height:44px;padding:10px 14px;border:1px solid var(--bd);" +
    "border-radius:10px;background:" + ((options && options.active) ? "var(--teal-l)" : "var(--white)") + ";" +
    "color:var(--text);font-family:inherit;font-size:13px;cursor:pointer;text-align:left";
  const label = document.createElement("span");
  label.textContent = text;
  const badge = document.createElement("span");
  badge.textContent = count + " 題";
  badge.style.cssText =
    "flex-shrink:0;border-radius:20px;padding:2px 9px;background:#faece7;color:#993c1d;" +
    "font-size:11.5px;font-weight:600";
  btn.appendChild(label);
  btn.appendChild(badge);
  btn.onclick = onClick;
  return btn;
}

function startWrongBookGroup(filter, title) {
  startReviewList(
    function () {
      return getWrongQuestions().filter(filter);
    },
    "這個分類目前沒有錯題。",
    "📕 " + title
  );
}

function renderWrongBookPanel() {
  const panel = document.getElementById("wrong-book-panel");
  if (!panel) return;
  const questions = getWrongQuestions();
  panel.innerHTML = "";

  const head = document.createElement("div");
  head.style.cssText = "display:flex;align-items:flex-start;gap:12px;margin-bottom:14px";
  const titleBox = document.createElement("div");
  titleBox.style.cssText = "flex:1;min-width:0";
  const title = document.createElement("div");
  title.textContent = "📕 錯題分類";
  title.style.cssText = "font-size:17px;font-weight:700;color:var(--teal-d)";
  const summary = document.createElement("div");
  summary.textContent = "共 " + questions.length + " 題，選擇分類後開始複習";
  summary.style.cssText = "font-size:12.5px;color:var(--muted);margin-top:3px";
  titleBox.appendChild(title);
  titleBox.appendChild(summary);
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "關閉";
  close.style.cssText =
    "border:1px solid var(--bd);border-radius:20px;background:var(--white);padding:5px 12px;" +
    "color:var(--muted);font-family:inherit;cursor:pointer";
  close.onclick = function () {
    panel.remove();
  };
  head.appendChild(titleBox);
  head.appendChild(close);
  panel.appendChild(head);

  if (!questions.length) {
    const empty = document.createElement("div");
    empty.textContent = "目前沒有錯題，繼續保持！";
    empty.style.cssText = "padding:22px;text-align:center;color:var(--muted);font-size:13px";
    panel.appendChild(empty);
    return;
  }

  const allBtn = makeWrongBookButton("全部錯題", questions.length, function () {
    startWrongBookGroup(function () { return true; }, "全部錯題複習");
  });
  allBtn.style.marginBottom = "12px";
  panel.appendChild(allBtn);

  const tabs = document.createElement("div");
  tabs.style.cssText = "display:flex;gap:8px;margin-bottom:12px";
  [
    ["chapter", "依科目／章節"],
    ["exam", "依考試日期"],
  ].forEach(function (entry) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = entry[1];
    btn.style.cssText =
      "flex:1;min-height:42px;border-radius:9px;border:1px solid " +
      (wrongBookView === entry[0] ? "var(--teal)" : "var(--bd)") +
      ";background:" + (wrongBookView === entry[0] ? "var(--teal-l)" : "var(--white)") +
      ";color:var(--teal-d);font-family:inherit;font-weight:600;cursor:pointer";
    btn.onclick = function () {
      wrongBookView = entry[0];
      renderWrongBookPanel();
    };
    tabs.appendChild(btn);
  });
  panel.appendChild(tabs);

  const content = document.createElement("div");
  content.style.cssText = "display:grid;gap:8px";

  if (wrongBookView === "exam") {
    const byExam = {};
    questions.forEach(function (q) {
      const key = wrongBookExamKey(q);
      if (!byExam[key]) byExam[key] = [];
      byExam[key].push(q);
    });
    Object.keys(byExam).sort(sortWrongBookExams).forEach(function (exam) {
      const examBtn = makeWrongBookButton(wrongBookExamLabel(exam, questions), byExam[exam].length, function () {
        startWrongBookGroup(function (q) { return wrongBookExamKey(q) === exam; }, wrongBookExamLabel(exam, questions));
      });
      examBtn.dataset.wrongExam = exam;
      content.appendChild(examBtn);
    });
  } else {
    const byCourse = {};
    questions.forEach(function (q) {
      const key = q.course || "未分類";
      if (!byCourse[key]) byCourse[key] = [];
      byCourse[key].push(q);
    });
    const courses = Object.keys(byCourse).sort(function (a, b) {
      return wrongBookCourseLabel(a).localeCompare(wrongBookCourseLabel(b), "zh-Hant");
    });
    if (!wrongBookCourse || !byCourse[wrongBookCourse]) wrongBookCourse = courses[0];

    const courseGrid = document.createElement("div");
    courseGrid.style.cssText = "display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;margin-bottom:4px";
    courses.forEach(function (course) {
      const courseBtn = makeWrongBookButton(wrongBookCourseLabel(course), byCourse[course].length, function () {
        wrongBookCourse = course;
        renderWrongBookPanel();
      }, { active: wrongBookCourse === course });
      courseBtn.dataset.wrongCourse = course;
      courseGrid.appendChild(courseBtn);
    });
    content.appendChild(courseGrid);

    const selected = byCourse[wrongBookCourse] || [];
    const courseAll = makeWrongBookButton("此科全部錯題", selected.length, function () {
      const course = wrongBookCourse;
      startWrongBookGroup(function (q) { return (q.course || "未分類") === course; }, wrongBookCourseLabel(course) + "錯題");
    });
    courseAll.style.marginTop = "6px";
    content.appendChild(courseAll);

    const byChapter = {};
    selected.forEach(function (q) {
      const key = q.chapter || q.section || "章節未分類";
      if (!byChapter[key]) byChapter[key] = [];
      byChapter[key].push(q);
    });
    Object.keys(byChapter).sort(function (a, b) { return a.localeCompare(b, "zh-Hant"); }).forEach(function (chapter) {
      const course = wrongBookCourse;
      const chapterBtn = makeWrongBookButton(chapter, byChapter[chapter].length, function () {
        startWrongBookGroup(
          function (q) {
            return (q.course || "未分類") === course && (q.chapter || q.section || "章節未分類") === chapter;
          },
          wrongBookCourseLabel(course) + " · " + chapter
        );
      });
      chapterBtn.dataset.wrongChapter = chapter;
      content.appendChild(chapterBtn);
    });
  }
  panel.appendChild(content);
}

function openWrongBookPanel() {
  const questions = getWrongQuestions();
  if (!questions.length) {
    alert("目前沒有錯題，繼續保持！");
    return;
  }
  const container = document.getElementById("course-select");
  const bar = document.getElementById("review-bar");
  if (!container || !bar) return;
  let panel = document.getElementById("wrong-book-panel");
  if (!panel) {
    panel = document.createElement("section");
    panel.id = "wrong-book-panel";
    panel.style.cssText =
      "background:var(--white);border:1px solid var(--bd);border-radius:14px;padding:18px;" +
      "margin:-6px 0 20px;box-shadow:0 8px 24px rgba(31,59,92,.06)";
    bar.insertAdjacentElement("afterend", panel);
  }
  renderWrongBookPanel();
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

let inReviewMode = false;
let currentReviewGetter = null;
// 複習/練習結束後要回到哪裡：預設回最上層科目選擇（course-select）；
// 依標籤跨考卷練習則是從 quiz-select（已選好科目）進來，結束後應該回到
// 同一個科目的考卷列表，而不是整個退回最上層。
let reviewReturnTo = "course-select";
let reviewReturnCourse = null;
// 複習清單裡，只有「模擬國考」這個入口需要倒數計時、也只有它需要在題目
// 標籤顯示「OO年第X次．第Y題」的考卷來源。這裡用一個旗標區分。
// 旗標必須在 startReviewList() 內部、呼叫 window.beginQuiz()（會觸發第一次
// renderQ()）之前就設定正確，不能等 startReviewList() 呼叫完才由外部改——
// 否則模擬國考「第一題」render 當下旗標還是 false，標籤會來不及套用新格式
// （這是實際部署後在瀏覽器直接測試才抓到的 timing bug，第 2 題以後都正常，
// 只有第 1 題會誤植，故改成用參數傳入，由 startReviewList() 自己同步設定）。
let reviewIsMockExam = false;

function startReviewList(getter, emptyMsg, title, returnTo, returnCourse, isMockExam) {
  const questions = getter();
  if (!questions.length) {
    alert(emptyMsg);
    return;
  }
  stopTimer(); // 複習／標籤練習不計時，不論從哪個入口進來都先停止碼表
  stopMockExamTimer(); // 換一份複習清單／重新開始模擬考，先清掉舊的倒數計時
  reviewIsMockExam = !!isMockExam;
  inReviewMode = true;
  currentReviewGetter = getter;
  reviewReturnTo = returnTo || "course-select";
  reviewReturnCourse = returnCourse || null;
  window.qList = questions;
  document.getElementById("course-select").style.display = "none";
  document.getElementById("quiz-select").style.display = "none";
  document.getElementById("subj-filter-bar").innerHTML =
    '<div style="font-size:13.5px;font-weight:500">' +
    title +
    ' <span style="font-weight:400;color:var(--muted)">共 ' +
    questions.length +
    ' 題</span></div>' +
    '<button onclick="window.quizSync.exitReview()" style="margin-left:auto;padding:5px 12px;border-radius:20px;border:1px solid var(--bd);background:0 0;color:var(--muted);font-size:12px;cursor:pointer;font-family:inherit">← 返回</button>';
  suppressResumeCheck = true;
  window.beginQuiz();
}

function exitReview() {
  leaveActiveMockExamView();
  reviewIsMockExam = false;
  inReviewMode = false;
  currentReviewGetter = null;
  document.getElementById("quiz-result").style.display = "none";
  document.getElementById("quiz-area").style.display = "none";
  updateReviewBarCounts();
  hideStickyProgressBar();
  const returnTo = reviewReturnTo;
  const returnCourse = reviewReturnCourse;
  reviewReturnTo = "course-select";
  reviewReturnCourse = null;
  if (
    returnTo === "quiz-select" &&
    returnCourse &&
    typeof window.selectCourse === "function"
  ) {
    // 依標籤跨考卷練習是從「已選好科目」的畫面進來的，退出時回到同一個
    // 科目的考卷列表，而不是整個退回最上層科目選擇。
    window.selectCourse(returnCourse);
  } else {
    document.getElementById("quiz-select").style.display = "none";
    document.getElementById("course-select").style.display = "block";
    quizHistoryPushed = false; // 已經人工回到最上層科目選擇，上一頁補丁狀態可以重置
  }
  syncAndroidBetaCardVisibility();
}

function ensureReviewBar() {
  if (document.getElementById("review-bar")) return;
  const container = document.getElementById("course-select");
  if (!container) {
    setTimeout(ensureReviewBar, 300);
    return;
  }
  const bar = document.createElement("div");
  bar.id = "review-bar";
  bar.style.cssText = "display:flex;gap:10px;margin-bottom:20px;flex-wrap:wrap";
  bar.innerHTML =
    '<button id="review-wrong-btn" style="display:inline-flex;align-items:center;gap:7px;background:var(--white);border:1.5px solid var(--bd);border-radius:50px;padding:9px 18px;font-size:13.5px;font-weight:500;cursor:pointer;font-family:inherit;color:var(--text)">📕 錯題本 <span id="review-wrong-count" style="background:#faece7;color:#993c1d;border-radius:20px;padding:1px 9px;font-size:12px;font-weight:600">0</span></button>' +
    '<button id="review-flagged-btn" style="display:inline-flex;align-items:center;gap:7px;background:var(--white);border:1.5px solid var(--bd);border-radius:50px;padding:9px 18px;font-size:13.5px;font-weight:500;cursor:pointer;font-family:inherit;color:var(--text)">⭐ 疑難標記 <span id="review-flagged-count" style="background:var(--teal-l);color:var(--teal-d);border-radius:20px;padding:1px 9px;font-size:12px;font-weight:600">0</span></button>';
  container.insertBefore(bar, container.firstChild);
  document.getElementById("review-wrong-btn").onclick = function () {
    openWrongBookPanel();
  };
  document.getElementById("review-flagged-btn").onclick = function () {
    startReviewList(
      getFlaggedQuestions,
      "目前沒有標記疑難題目。",
      "⭐ 疑難標記複習"
    );
  };
  updateReviewBarCounts();
}

function updateReviewBarCounts() {
  const wrongEl = document.getElementById("review-wrong-count");
  const flaggedEl = document.getElementById("review-flagged-count");
  if (wrongEl) wrongEl.textContent = getWrongQuestions().length;
  if (flaggedEl) flaggedEl.textContent = getFlaggedQuestions().length;
  if (document.getElementById("wrong-book-panel")) renderWrongBookPanel();
}

// ---------------------------------------------------------------------------
// 🔀 依標籤跨考卷練習
//
// 沿用既有的科目標籤（跟每份考卷內「科目篩選列」用的是同一套資料）：
// medsurg 這個科目的標籤是寫死在 index.html 的 #subj-filter-bar 原始 HTML
// 裡（這裡列的 MEDSURG_DEFAULT_TAGS 是照那份原始清單抄一份，兩邊要對得
// 起來才不會篩不到題目）；其他科目則是 exam-data.js 裡 SUBJ_FILTER_TAGS
// 這個物件已經有的資料，直接沿用、不重複定義。
//
// 範圍固定在「同一科目」：因為每個科目的標籤定義彼此不通用（例如婦兒科
// 沒有「骨骼肌肉」這個標籤），跨科目合併會出現「這個標籤在另一科目裡
// 根本不存在」的情況，所以只在使用者已經選定的科目內、跨該科目全部
// 考卷抽題。
//
// 題數固定隨機抽 20 題（不足 20 題就有多少出多少）：抽題邏輯本身沒有
// 額外保存「這次抽到哪幾題」，每次呼叫都是重新隨機抽一次——這樣「再做
// 一次」時會自然換一批題目，不用額外處理「重新抽題」的邏輯。
// ---------------------------------------------------------------------------

const MEDSURG_DEFAULT_TAGS = [
  { emoji: "🧠", label: "腦神經", value: "腦神經系統" },
  { emoji: "🫃", label: "消化", value: "消化系統" },
  { emoji: "🦴", label: "肌肉骨骼", value: "肌肉骨骼系統" },
  { emoji: "👂", label: "眼耳鼻喉", value: "眼耳鼻喉" },
  { emoji: "🫀", label: "心臟血管", value: "心臟血管系統" },
  { emoji: "💉", label: "血液腫瘤", value: "血液腫瘤" },
  { emoji: "🩹", label: "皮膚", value: "皮膚" },
  { emoji: "🛡️", label: "免疫", value: "免疫系統" },
  { emoji: "🫁", label: "呼吸", value: "呼吸系統" },
  { emoji: "🚽", label: "腎臟泌尿", value: "腎臟與泌尿系統" },
  { emoji: "🧬", label: "內分泌", value: "內分泌系統" },
  { emoji: "🚨", label: "急症", value: "急症護理" },
  { emoji: "🦠", label: "傳染病", value: "傳染病護理" },
];

const TAG_PRACTICE_COUNT = 20;

function getTagsForCourse(course) {
  if (window.SUBJ_FILTER_TAGS && window.SUBJ_FILTER_TAGS[course]) {
    return window.SUBJ_FILTER_TAGS[course];
  }
  return MEDSURG_DEFAULT_TAGS;
}

function getTagPracticeQuestions(course, tagValues, count) {
  if (!Array.isArray(tagValues) || tagValues.length === 0) return [];
  const uniqueTags = [...new Set(tagValues)];
  const pool = window.QS.filter(function (q) {
    return q.course === course && uniqueTags.indexOf(q.chapter) !== -1;
  });
  const byChapter = {};
  uniqueTags.forEach(function (tv) { byChapter[tv] = []; });
  pool.forEach(function (q) { byChapter[q.chapter].push(q); });

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }
  uniqueTags.forEach(function (tv) { shuffle(byChapter[tv]); });

  let result = [];
  if (count === "all") {
    // 全部：每個已選章節的題目全部納入，不設上限
    uniqueTags.forEach(function (tv) { result = result.concat(byChapter[tv]); });
  } else {
    // 依題數在已選章節間平均分配（餘數隨機分給部分章節，避免同一章節每次都多抽）
    const n = uniqueTags.length;
    const base = Math.floor(count / n);
    let remainder = count % n;
    const order = shuffle(uniqueTags.slice());
    order.forEach(function (tv) {
      const quota = base + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder--;
      // 不足配額就該章節有多少出多少，不會跨章節補題
      result = result.concat(byChapter[tv].slice(0, quota));
    });
  }
  return shuffle(result);
}

let tagPracticeBarCourse = null;
let tagPracticeSelectedTags = [];

function ensureTagPracticeBar() {
  const container = document.getElementById("quiz-select");
  if (!container) return;
  const course = window.currentCourse;
  if (!course) return;
  const existing = document.getElementById("tag-practice-bar");
  if (tagPracticeBarCourse === course && existing) return;
  if (existing) existing.remove();
  tagPracticeBarCourse = course;
  tagPracticeSelectedTags = [];

  const tags = getTagsForCourse(course);
  if (!tags || !tags.length) return;

  const bar = document.createElement("div");
  bar.id = "tag-practice-bar";
  bar.style.cssText =
    "display:flex;flex-direction:column;gap:10px;margin-bottom:20px;padding:14px;background:var(--teal-l);border-radius:var(--r);";

  const chipRow = document.createElement("div");
  chipRow.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;";

  const startBtn = document.createElement("button");
  const countLabel = document.createElement("span");

  function renderStartBtn() {
    const n = tagPracticeSelectedTags.length;
    startBtn.textContent = "🔀 開始練習";
    startBtn.disabled = n === 0;
    startBtn.style.opacity = n === 0 ? "0.5" : "1";
    startBtn.style.cursor = n === 0 ? "not-allowed" : "pointer";
    countLabel.textContent = n === 0 ? "請選擇至少一個章節" : "已選 " + n + " 個章節";
  }

  tags.forEach(function (t) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = t.emoji + " " + t.label;
    btn.dataset.value = t.value;
    function paint() {
      const selected = tagPracticeSelectedTags.indexOf(t.value) !== -1;
      btn.style.cssText =
        "border-radius:50px;padding:7px 14px;font-size:13px;cursor:pointer;font-family:inherit;" +
        (selected
          ? "background:var(--teal);border:1.5px solid var(--teal);color:var(--white);"
          : "background:var(--white);border:1.5px solid var(--bd);color:var(--text);");
    }
    paint();
    btn.onclick = function () {
      const idx = tagPracticeSelectedTags.indexOf(t.value);
      if (idx === -1) tagPracticeSelectedTags.push(t.value);
      else tagPracticeSelectedTags.splice(idx, 1);
      paint();
      renderStartBtn();
    };
    chipRow.appendChild(btn);
  });

  const actionRow = document.createElement("div");
  actionRow.style.cssText = "display:flex;align-items:center;gap:12px;flex-wrap:wrap;";

  startBtn.type = "button";
  startBtn.style.cssText =
    "background:var(--teal);border:1.5px solid var(--teal);border-radius:50px;padding:8px 18px;font-size:14px;font-weight:600;font-family:inherit;color:var(--white);";
  startBtn.onclick = function () {
    if (!tagPracticeSelectedTags.length) return;
    openTagPracticeCountModal(course, tagPracticeSelectedTags.slice(), tags);
  };

  countLabel.style.cssText = "font-size:13px;color:var(--muted);";

  renderStartBtn();
  actionRow.appendChild(startBtn);
  actionRow.appendChild(countLabel);

  bar.appendChild(chipRow);
  bar.appendChild(actionRow);
  container.insertBefore(bar, container.children[1]);
}

function openTagPracticeCountModal(course, selectedValues, allTags) {
  const old = document.getElementById("tag-practice-count-modal");
  if (old) old.remove();

  const selectedLabels = allTags
    .filter(function (t) { return selectedValues.indexOf(t.value) !== -1; })
    .map(function (t) { return t.label; });
  const titleText =
    selectedLabels.length <= 3
      ? "🔀 " + selectedLabels.join("、") + " 標籤練習"
      : "🔀 已選 " + selectedLabels.length + " 個章節標籤練習";

  const overlay = document.createElement("div");
  overlay.id = "tag-practice-count-modal";
  overlay.style.cssText =
    "position:fixed;inset:0;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;z-index:9999;padding:20px;";
  overlay.onclick = function (e) {
    if (e.target === overlay) overlay.remove();
  };

  const card = document.createElement("div");
  card.style.cssText =
    "background:var(--white);border-radius:var(--r);padding:24px;max-width:340px;width:100%;box-shadow:0 8px 30px rgba(0,0,0,0.2);";
  card.onclick = function (e) { e.stopPropagation(); };

  const title = document.createElement("div");
  title.textContent = titleText;
  title.style.cssText = "font-size:15px;font-weight:600;color:var(--text);margin-bottom:4px;";

  const subtitle = document.createElement("div");
  subtitle.textContent = "選擇要練習的題數";
  subtitle.style.cssText = "font-size:13px;color:var(--muted);margin-bottom:16px;";

  const optRow = document.createElement("div");
  optRow.style.cssText = "display:flex;flex-direction:column;gap:8px;";

  const options = [
    { value: 10, label: "10 題" },
    { value: 20, label: "20 題", recommended: true },
    { value: 50, label: "50 題" },
    { value: "all", label: "全部（不設上限）" },
  ];

  options.forEach(function (opt) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = opt.label + (opt.recommended ? "（推薦）" : "");
    btn.style.cssText =
      "background:var(--white);border:1.5px solid " +
      (opt.recommended ? "var(--teal)" : "var(--bd)") +
      ";border-radius:var(--rs);padding:12px;font-size:14px;font-family:inherit;color:var(--text);cursor:pointer;text-align:center;";
    btn.onclick = function () {
      overlay.remove();
      startReviewList(
        function () { return getTagPracticeQuestions(course, selectedValues, opt.value); },
        "這些標籤目前沒有題目。",
        titleText,
        "quiz-select",
        course
      );
    };
    optRow.appendChild(btn);
  });

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.textContent = "取消";
  cancelBtn.style.cssText =
    "margin-top:14px;background:none;border:none;color:var(--muted);font-size:13px;font-family:inherit;cursor:pointer;width:100%;text-align:center;";
  cancelBtn.onclick = function () { overlay.remove(); };

  card.appendChild(title);
  card.appendChild(subtitle);
  card.appendChild(optRow);
  card.appendChild(cancelBtn);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
}

// ---------------------------------------------------------------------------
// 🎯 模擬國考：從目前科目的全部歷屆題目中隨機抽 50 題、限時 60 分鐘，
// 時間到自動送出計分（未作答視為答錯）。UI 上刻意做成一個獨立的顯眼色塊，
// 插在「依標籤跨考卷練習」之前（selectCourse 裡先插練習列、再插這塊，
// 兩塊都用「插在第一個子節點之後」的邏輯，所以後插的會排在前面）。
// ---------------------------------------------------------------------------

const MOCK_EXAM_QUESTION_COUNT = 50;
const MOCK_EXAM_DURATION_SEC = 60 * 60;

let mockExamBannerCourse = null;
let currentMockAttemptId = null;
let currentMockCourse = null;
let currentMockStartedAt = null;
let currentMockDeadline = null;
let mockSubmitting = false; // 防止快速連按「交卷」產生兩筆成績（跟 attemptId 一起比對，見 mockExam.decideSubmit）
let hasPromptedFiftyComplete = false; // 這次作答期間，「已完成全部50題」的提示只主動跳一次
let mockExamIntervalId = null;

function shuffleArr(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = a[i];
    a[i] = a[j];
    a[j] = tmp;
  }
  return a;
}

// 依大章（section）平均分配抽題，而不是整科純隨機——符合模擬考規格（每科 50
// 題、按大章平均）。內外科、基礎醫學只有一層分類，section 等於 chapter，效果
// 等同直接依章節平均；基本護理、產兒、精神社區為兩層分類，這裡依「大章」
// （例如產兒科的「產科護理學」/「兒科護理學」）平均，避免章節數多、單章題數
// 差異大的科目（例如基本護理「領導統御與控制」一章就有 366 題）被過度抽到。
// 新分類不保留「其他」，每一題都會落在某個正式章節，全部計入。
function normChapter(subj) {
  return CHAPTER_ALIAS[subj] || subj;
}

function getMockExamQuestions(course) {
  if (!window.QS) return [];
  const pool = window.QS.filter(function (q) {
    return q.course === course;
  });
  const bySection = {};
  pool.forEach(function (q) {
    const key = q.section;
    if (!key) return;
    if (!bySection[key]) bySection[key] = [];
    bySection[key].push(q);
  });
  const sections = shuffleArr(Object.keys(bySection));
  if (!sections.length) {
    return shuffleArr(pool.slice()).slice(0, MOCK_EXAM_QUESTION_COUNT);
  }
  const base = Math.floor(MOCK_EXAM_QUESTION_COUNT / sections.length);
  const remainder = MOCK_EXAM_QUESTION_COUNT % sections.length;
  let picked = [];
  sections.forEach(function (name, idx) {
    const quota = base + (idx < remainder ? 1 : 0);
    picked = picked.concat(shuffleArr(bySection[name].slice()).slice(0, quota));
  });
  // 保險：正常情況下每個大章題數都遠大於配額，這裡只是避免萬一有大章題數不足
  // 時抽不滿 50 題——用同一科其餘題目補滿。
  if (picked.length < MOCK_EXAM_QUESTION_COUNT) {
    const pickedSet = new Set(picked.map(function (q) { return q.n; }));
    const rest = shuffleArr(
      pool.filter(function (q) { return !pickedSet.has(q.n); })
    );
    picked = picked.concat(rest.slice(0, MOCK_EXAM_QUESTION_COUNT - picked.length));
  }
  return shuffleArr(picked).slice(0, MOCK_EXAM_QUESTION_COUNT);
}

// ---------------------------------------------------------------------------
// 🏷️ 模擬國考題目標籤：標出題目來源「OO年第X次・第Y題」。
// 資料面：exam-data.js 每一題都有 .exam（來源考卷代碼，如 "115-1"／"psych-108-1"），
// 但原始題號 .no 不是每科都有——內外科完全沒有，其他科少數梯次也缺。
// ensureNoForExam() 用「同一份考卷的題目依內部序號 n 排序、算出第幾題」這個通用
// 邏輯即時補齊，不管哪一科都能得到正確題號，且完全不改動 exam-data.js 本身。
// ---------------------------------------------------------------------------

const _noFilledExams = {};
function ensureNoForExam(examCode) {
  if (!examCode || _noFilledExams[examCode]) return;
  _noFilledExams[examCode] = true;
  if (!window.QS) return;
  const group = window.QS.filter(function (q) {
    return q.exam === examCode;
  }).sort(function (a, b) {
    return a.n - b.n;
  });
  group.forEach(function (q, idx) {
    if (q.no === undefined || q.no === null) q.no = idx + 1;
  });
}

const SESSION_CN = { 1: "一", 2: "二", 3: "三", 4: "四", 5: "五" };
function getExamOriginLabel(q) {
  if (!q || !q.exam) return "";
  const sessions = window.EXAM_SESSIONS && window.EXAM_SESSIONS[q.course];
  if (sessions) {
    const found = sessions.find(function (s) {
      return s.code === q.exam;
    });
    if (found && found.title) return found.title;
  }
  // 沒有 EXAM_SESSIONS 條目（目前是內外科的情況）：直接從 exam code 解析，
  // 格式如 "115-1" → "115年第一次"。
  const m = /(\d+)-(\d+)$/.exec(q.exam);
  if (!m) return q.exam;
  const year = m[1];
  const session = m[2];
  return year + "年第" + (SESSION_CN[session] || session) + "次";
}

function applyMockExamTag() {
  if (!reviewIsMockExam) return;
  const q = window.qList && window.qList[window.qIdx];
  const tagEl = document.getElementById("q-tag");
  if (!q || !tagEl) return;
  ensureNoForExam(q.exam);
  const label = getExamOriginLabel(q);
  const no = q.no || q.n;
  tagEl.textContent = (label ? label + " · " : "") + "第" + no + "題";
}



function stopMockExamTimer() {
  if (mockExamIntervalId) {
    clearInterval(mockExamIntervalId);
    mockExamIntervalId = null;
  }
}

// 目前這場模擬考的科目中文名稱——沿用既有的 SEARCH_COURSE_LABELS（後面搜尋
// 功能那段已經定義），不重複維護第二份對照表。函式只在被呼叫當下才會讀取
// SEARCH_COURSE_LABELS，跟它在檔案裡的宣告順序無關（模組全部載入完成後才
// 會真的被呼叫）。
function mockCourseLabel(course) {
  return (typeof SEARCH_COURSE_LABELS !== "undefined" && SEARCH_COURSE_LABELS[course]) || course || "";
}

// 把目前 window.qList／window.answered／window.qIdx 的即時狀態，連同這場
// 模擬考的身份資訊（attemptId／course／startedAt／deadline）一起寫進
// localStorage。requirement 四要求「每次選答案、修改答案、切換題目」都要
// 自動保存，所以這個函式會在 selectOpt 的兩個模擬考分支、以及 renderQ
// （涵蓋操作列上一題/下一題、答題地圖點擊、滑動切題——所有會改變 qIdx 的
// 途徑最後都會呼叫 renderQ）裡各呼叫一次，兩邊都呼叫並不浪費：寫
// localStorage 很便宜，重複呼叫只是把同一份最新狀態再寫一次。
function persistCurrentMockSession() {
  if (!reviewIsMockExam || !currentMockAttemptId || !window.qList || !window.qList.length) return;
  mockExam.saveSession({
    version: mockExam.SESSION_VERSION,
    attemptId: currentMockAttemptId,
    course: currentMockCourse,
    questionIds: window.qList.map(function (q) {
      return q.n;
    }),
    answers: Object.assign({}, window.answered),
    currentIndex: window.qIdx,
    startedAt: currentMockStartedAt,
    deadline: currentMockDeadline,
    updatedAt: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// 模擬考歷次成績：跟 answers/flagged 存在同一份 LOCAL_KEY／同一份 Firestore
// 文件裡（見 loadLocal/saveLocal/pushToCloud），不另外開一個 key，
// 避免 setDoc 沒有帶 merge:true 時互相覆蓋掉對方欄位。
// ---------------------------------------------------------------------------

// attemptId 是這次修正新增的參數：只在本機把「這筆摘要」跟「本機保存的完整
// 逐題明細」串起來（見 quiz-mock-exam.js 開頭的說明），不會讓同步到
// Firestore 的 myMockHistory 文件變大——這裡新增的只有一個短字串欄位。

// 開啟「這一科的模擬考歷次成績」彈窗——結果頁（剛交卷）跟 quiz-select
// （離開結果頁之後）共用同一個函式、同一份清單／明細元件
// （quiz-mock-exam.js 的 openHistoryModal，跟搜尋面板一樣的 overlay 模式），
// 這樣兩個入口點進去看到的畫面、可以查看的明細內容完全一致。
function openMockHistoryForCourse(course) {
  const entries = myMockHistory.filter(function (h) {
    return h.course === course;
  });
  mockExam.openHistoryModal({
    entries: entries,
    courseLabel: mockCourseLabel(course),
    getAttemptDetail: mockExam.loadAttemptDetail,
    getQuestionByN: function (n) {
      return window.QS && window.QS.find(function (q) {
        return q.n === n;
      });
    },
  });
}

// 結果頁（剛交卷那一刻）裡插一個「查看完整歷次成績」的小按鈕，取代舊版直接
// 把最近 5 筆平舖在結果頁下面的做法——同一份資料現在點進去就能看到逐題明細
// （requirement 八），不需要在結果頁重複做一份摘要清單。
function ensureMockHistoryLink(course) {
  let box = document.getElementById("mock-history-box");
  const wrongList = document.getElementById("wrong-list");
  if (!box) {
    if (!wrongList || !wrongList.parentElement) return;
    box = document.createElement("div");
    box.id = "mock-history-box";
    box.style.cssText = "margin-top:18px;text-align:center";
    wrongList.parentElement.insertBefore(box, wrongList.nextSibling);
  }
  const hasHistory = myMockHistory.some(function (h) {
    return h.course === course;
  });
  if (!hasHistory) {
    box.innerHTML = "";
    return;
  }
  box.innerHTML =
    '<button type="button" id="mock-history-link-btn" style="background:none;border:1.5px solid var(--bd);color:var(--teal-d);border-radius:50px;padding:9px 20px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit">📊 查看這科的模擬考歷次成績</button>';
  document.getElementById("mock-history-link-btn").onclick = function () {
    openMockHistoryForCourse(course);
  };
}

// 交卷（不管是使用者主動按、還是倒數時間到／還原時發現已經過期自動觸發）
// 全部匯流到這一個函式，只有這裡會真的寫入成績——跟 mobile app
// finishSection() 的設計原則一樣：先確定 DB／這裡是 localStorage 完整明細
// 真的保存成功，才可以視為交卷完成、清掉 session；保存失敗要讓使用者可以
// 重試，不能假裝已經交卷。boundAttemptId 是呼叫端在「設定這次交卷動作」的
// 當下就綁定好的值（例如彈窗設定時），不是呼叫當下才去讀目前的
// currentMockAttemptId，這樣才能靠 mockExam.decideSubmit() 擋掉「舊的一場
// 模擬考所綁定的過期回呼，在使用者已經開始下一場之後才觸發」這種情況。
function finishMockAttempt(boundAttemptId, opts) {
  const decision = mockExam.decideSubmit({
    boundAttemptId: boundAttemptId,
    currentAttemptId: currentMockAttemptId,
    isSubmitting: mockSubmitting,
  });
  if (!decision.allow) return;
  if (mockExam.loadAttemptDetail(boundAttemptId)) {
    // 這個 attemptId 先前已經成功保存過完整明細了——decideSubmit() 只擋得住
    // 「attemptId 不是目前這場」跟「正在交卷中」兩種情況，擋不住「同一場已經
    // 交卷成功、但因為某個我們沒預期到的路徑（例如防禦性的 showResult 轉接
    // 又被觸發一次）再次呼叫」這種情況——那時 mockSubmitting 早就已經被重設
    // 回 false 了，decideSubmit() 本身並不知道「這場其實已經交過了」。這裡
    // 用「明細是否已經存在」當作額外一層、獨立於 decideSubmit() 之外的保險，
    // 確保同一個 attemptId 絕對不會產生第二筆歷次成績紀錄（requirement 九）。
    return;
  }
  mockSubmitting = true;

  const questionIds = window.qList.map(function (q) {
    return q.n;
  });
  const answersSnapshot = Object.assign({}, window.answered);
  const scored = mockExam.scoreAttempt(questionIds, answersSnapshot, function (n) {
    return window.QS && window.QS.find(function (q) {
      return q.n === n;
    });
  });
  const detail = {
    version: mockExam.ATTEMPT_VERSION,
    attemptId: boundAttemptId,
    course: currentMockCourse,
    questionIds: questionIds,
    answers: answersSnapshot,
    correctness: scored.correctness,
    correctCount: scored.correct,
    wrongCount: scored.wrong,
    unansweredCount: scored.unanswered,
    score: scored.score,
    startedAt: currentMockStartedAt,
    submittedAt: new Date().toISOString(),
    autoSubmitted: !!(opts && opts.autoSubmitted),
  };

  const saved = mockExam.saveAttemptDetail(detail);
  if (!saved) {
    // requirement 九：保存失敗要保留 session、提示稍後重試，不能清掉進行中
    // 的作答內容。session 本身在每次作答／切題時已經持續保存，這裡什麼都
    // 不用做，作答內容自然還在。
    mockSubmitting = false;
    alert("成績保存失敗，作答內容仍保留在這個瀏覽器，請稍後再試一次交卷。");
    return;
  }

  recordMockResult(detail.course, detail.score, detail.correctCount, detail.questionIds.length, detail.score >= 60, detail.attemptId);

  // 保存成功之後才清掉進行中的 session。
  mockExam.clearSession();
  stopMockExamTimer();
  mockExam.hideOperationBar();
  mockSubmitting = false;
  renderMockResultFromDetail(detail);
}

// 結果畫面完全從剛剛保存成功的 detail 重新畫，不讀取任何即時的
// qList／answered——跟 mobile app 的 ResultView 同一個原則：畫面顯示的內容
// 必須跟實際保存的資料保證一致，不會因為使用者在保存過程中還能互動而產生
// 兩者不同步的情況。
function renderMockResultFromDetail(detail) {
  document.getElementById("quiz-area").style.display = "none";
  document.getElementById("quiz-result").style.display = "block";
  syncAndroidBetaCardVisibility();
  const score = detail.score;
  let emoji = "🌟",
    title = "表現很好！",
    sub = "再衝一波就滿分了！";
  if (score < 60) {
    emoji = "😅";
    title = "還需要加強！";
    sub = "回去看影片再重新挑戰！";
  } else if (score < 80) {
    emoji = "💪";
    title = "不錯！繼續加油";
    sub = "再多練習幾次就能穩穩過關！";
  } else if (score >= 100) {
    emoji = "🎉";
    title = "太厲害了！";
    sub = "接近滿分，繼續保持！";
  }
  if (detail.autoSubmitted) {
    sub = "⏰ 60 分鐘時間到，已自動送出計分（未作答視為答錯）。 " + sub;
  }

  document.getElementById("res-emoji").textContent = emoji;
  document.getElementById("res-title").textContent = title;
  document.getElementById("res-sub").textContent = sub;
  document.getElementById("res-pct").textContent = score + "%";
  document.getElementById("res-ok").textContent = detail.correctCount + "題";
  document.getElementById("res-bad").textContent = detail.wrongCount + detail.unansweredCount + "題";

  const letters = ["A", "B", "C", "D"];
  let html = "";
  detail.questionIds.forEach(function (qid, idx) {
    const q = window.QS && window.QS.find(function (item) {
      return item.n === qid;
    });
    if (!q) return;
    const picked = detail.answers[idx];
    const answered = picked !== undefined && picked !== null;
    const ok = detail.correctness[idx];
    if (answered && ok) return; // 只列答錯／未作答，跟原本"錯題複習"清單的定位一致
    const label = answered ? "答錯" : "未作答";
    const answerLine = answered
      ? "你的答案：" + (letters[picked] || "?") + "　正確答案：" + (q.ans || []).map(function (a) {
          return letters[a];
        }).join(" 或 ")
      : "這題未作答　正確答案：" + (q.ans || []).map(function (a) {
          return letters[a];
        }).join(" 或 ");
    html +=
      '<div style="margin-bottom:14px;padding:14px 16px;background:#FAECE7;border-radius:var(--rs)">' +
      '<div style="font-size:12.5px;font-weight:500;color:#993C1D;margin-bottom:5px">第' +
      (idx + 1) +
      "題（" +
      escapeHtml(q.subj || "") +
      "）· " +
      label +
      "</div>" +
      '<div style="font-size:13px;line-height:1.7;margin-bottom:6px">' +
      escapeHtml(q.q || "") +
      "</div>" +
      '<div style="font-size:12px;color:#7f2b10">' +
      answerLine +
      "</div>" +
      '<div style="font-size:12px;color:#7c3a1e;margin-top:6px;line-height:1.75">' +
      escapeHtml(getExplSafe(q.n)) +
      "</div>" +
      "</div>";
  });
  document.getElementById("wrong-list").innerHTML =
    html || '<div style="text-align:center;color:var(--teal);font-size:14px;padding:10px 0">🎊 全部答對，完美！</div>';

  // 模擬考結果頁不提供「只練錯題」快速入口（見檔案開頭的取捨說明：那是
  // 針對「剛做完的這一份」的練習捷徑，跟模擬考「完整明細留存」的定位不同，
  // 一般練習／複習清單模式的「只練錯題」完全不受影響，仍然照舊可用）。
  const retryBtn = document.getElementById("retry-wrong-btn");
  if (retryBtn) retryBtn.style.display = "none";

  ensureMockHistoryLink(detail.course);
}

// getExpl() 是 index.html 用 `function getExpl(n){...}` 宣告的全域函式
// （函式宣告會掛在 window 上，這點跟同一支檔案裡另一個用 const 宣告、不會
// 掛上 window 的 escapeQuizHtml 不一樣）。這裡防禦性地檢查一下再呼叫，避免
// 未來 index.html 那邊萬一改名/移除時，這裡整個當掉而不是優雅降級成空字串。
function getExplSafe(n) {
  return typeof window.getExpl === "function" ? window.getExpl(n) || "" : "";
}

// origSelectOpt() 本體會直接更新 #cnt-ok／#cnt-bad 這兩個「✓ N / ✗ N」計數
// 徽章（累加對錯次數），這是即時對錯以外，另一個會洩漏正確性的地方——即使
// #q-feedback 整個被藏起來，這兩個徽章仍在標題列上持續可見，使用者只要看
// 「✗」的數字有沒有跳動，一樣能反推剛剛那題答錯了。這是 Rex 原始六點根本
// 原因沒有列到、但同樣違反「操作列不得透露答案正確或錯誤」這條要求的地方，
// 這裡一併修掉：模擬考期間直接隱藏這兩個徽章，離開模擬考時要記得還原
// （見 leaveActiveMockExamView()），否則會連一般練習模式都被誤藏。
function hideMockScoreBadges() {
  const ok = document.getElementById("cnt-ok");
  const bad = document.getElementById("cnt-bad");
  if (ok && ok.parentElement) ok.parentElement.style.display = "none";
  if (bad && bad.parentElement) bad.parentElement.style.display = "none";
}
function showMockScoreBadges() {
  const ok = document.getElementById("cnt-ok");
  const bad = document.getElementById("cnt-bad");
  if (ok && ok.parentElement) ok.parentElement.style.display = "";
  if (bad && bad.parentElement) bad.parentElement.style.display = "";
}

// 離開「正在顯示中」的模擬考畫面時的共用收尾：不管是使用者主動換科目、
// 瀏覽器上一頁、或切去網站其他分頁，都要讓 position:fixed 的操作列消失
// （它掛在 document.body 上，不受 #quiz-area／#page-quiz 顯示與否影響，
// 不主動處理就會一直飄在畫面上）、把成績徽章還原、停止倒數計時。不清掉
// session 本身——session 是「這場模擬考還在不在」的真相來源，離開畫面
// 不代表放棄這場模擬考，使用者之後還能透過「繼續上次模擬考」卡片還原。
function leaveActiveMockExamView() {
  mockExam.hideOperationBar();
  showMockScoreBadges();
  stopMockExamTimer();
}

// 「Android 封閉測試招募」卡片（#android-beta-card）是 index.html 自己內嵌的
// <script> 寫死注入進 #page-quiz 的，跟 course-select／quiz-select／
// quiz-area／quiz-result 這幾個畫面的顯示切換完全無關，原本會不管使用者在
// 哪個畫面都一路跟著顯示、包含實際作答中——很占版面。這裡不去動
// index.html 那段注入邏輯本身（它會被另一個工具整批重新產生，直接改動
// 風險較高），改成由這裡讀「目前哪個畫面實際可見」重新判斷一次是否該
// 顯示：只在真的停留在最上層「選科目」畫面時顯示，選考卷／作答中／結果頁
// 一律隱藏。是唯讀、等冪的操作，呼叫多次或呼叫在不影響的時機都無害，所以
// 掛在每一個會改變目前畫面的既有掛勾點之後即可，不需要精準對應每一種進出
// 方式。
function syncAndroidBetaCardVisibility() {
  const card = document.getElementById("android-beta-card");
  if (!card) return;
  const courseSelectEl = document.getElementById("course-select");
  const quizSelectEl = document.getElementById("quiz-select");
  const quizAreaEl = document.getElementById("quiz-area");
  const quizResultEl = document.getElementById("quiz-result");
  const onCourseSelectOnly =
    !!courseSelectEl &&
    courseSelectEl.style.display !== "none" &&
    (!quizSelectEl || quizSelectEl.style.display === "none") &&
    (!quizAreaEl || quizAreaEl.style.display === "none") &&
    (!quizResultEl || quizResultEl.style.display === "none");
  card.style.display = onCourseSelectOnly ? "block" : "none";
}

// requirement 二：答完全部題目的當下主動提示，不必等使用者自己發現、也
// 不需要等倒數時間。只在「這場模擬考」第一次達成全部作答時提示一次
// （hasPromptedFiftyComplete），使用者選「繼續檢查答案」之後如果又去改答案
// 也不會被重複打擾。
function maybePromptFiftyComplete(boundAttemptId) {
  if (hasPromptedFiftyComplete) return;
  if (!window.qList || !window.answered) return;
  const total = window.qList.length;
  if (Object.keys(window.answered).length < total) return;
  hasPromptedFiftyComplete = true;
  mockExam.showMockConfirm({
    title: "已完成全部" + total + "題",
    message: "是否立即交卷並查看解析？",
    confirmText: "交卷並查看解析",
    cancelText: "繼續檢查答案",
    onConfirm: function () {
      finishMockAttempt(boundAttemptId, { autoSubmitted: false });
    },
  });
}

// requirement 三：操作列「交卷並查看解析」——隨時可按；還有未作答題目時，
// 顯示未作答數量並要求再次確認，確認後未作答一律視為答錯（在
// finishMockAttempt -> scoreAttempt 裡已經是這樣算，這裡只是提示文字）。
function requestMockSubmit(boundAttemptId) {
  if (mockSubmitting) return;
  const total = window.qList ? window.qList.length : 0;
  const answeredCount = window.answered ? Object.keys(window.answered).length : 0;
  const unansweredCount = Math.max(0, total - answeredCount);
  const message =
    unansweredCount > 0
      ? "還有 " + unansweredCount + " 題尚未作答，未作答的題目將視為答錯。確定要交卷嗎？"
      : "交卷後將無法再修改答案，確定要交卷嗎？";
  mockExam.showMockConfirm({
    title: "交出這場模擬考？",
    message: message,
    confirmText: "交卷並查看解析",
    cancelText: "繼續檢查答案",
    danger: unansweredCount > 0,
    onConfirm: function () {
      finishMockAttempt(boundAttemptId, { autoSubmitted: false });
    },
  });
}

// 操作列「上一題／下一題」：純粹移動，不管有沒有作答、也絕不會像原本
// nextQ() 那樣「答完最後一題自動觸發交卷」——模擬考交卷現在一律要走
// requestMockSubmit() 的明確確認流程（requirement 二／三）。
function moveMockQuestion(delta) {
  if (!window.qList || !window.qList.length) return;
  const next = Math.max(0, Math.min(window.qList.length - 1, window.qIdx + delta));
  if (next === window.qIdx) return;
  window.qIdx = next;
  window.renderQ();
}

// deadline 現在一律由呼叫端傳入（新開一場＝現在＋60分鐘；還原一場＝直接用
// session 裡保存的絕對時間），這個函式本身不再自己決定要給多少剩餘時間
// ——requirement 六要求的「不要在重新開啟頁面時重新給60分鐘」，正是靠這一
// 點來保證：沒有任何路徑會在還原時呼叫「現在＋60分鐘」這個算法。

// 開始一場全新的模擬考——固定是「唯一入口」：attemptId 在這裡產生一次，
// 之後同一場模擬考（不管是即時作答還是重新整理後還原）都沿用同一個值，
// 交卷防重複（decideSubmit）與完整明細保存都靠這個 id 串起來。

// 實際開新一場模擬考的流程，從 startMockExam() 抽出來，讓「偵測到已有未
// 完成 session、使用者明確選擇放棄」之後，可以重新呼叫同一套流程，不用另外
// 複製一份平行的開考邏輯。
function proceedStartMockExam(course) {
  const ok = confirm(
    "🎯 模擬國考模式\n\n隨機抽取 " +
      MOCK_EXAM_QUESTION_COUNT +
      " 題，限時 60 分鐘，時間到會自動送出計分（未作答視為答錯）。\n\n確定要開始嗎？"
  );
  if (!ok) return;

  const attemptId = mockExam.generateAttemptId();
  const startedAtIso = new Date().toISOString();
  const deadline = Date.now() + MOCK_EXAM_DURATION_SEC * 1000;
  currentMockAttemptId = attemptId;
  currentMockCourse = course;
  currentMockStartedAt = startedAtIso;
  mockSubmitting = false;
  hasPromptedFiftyComplete = false;

  startReviewList(
    function () {
      return getMockExamQuestions(course);
    },
    "目前題庫還沒有這個科目的題目，請稍後再試。",
    "🎯 模擬國考（限時 60 分鐘）",
    "quiz-select",
    course,
    true // isMockExam
  );
  startMockExamTimer(deadline);
  mockExam.showOperationBar({
    onPrev: function () {
      moveMockQuestion(-1);
    },
    onNext: function () {
      moveMockQuestion(1);
    },
    onSubmit: function () {
      requestMockSubmit(attemptId);
    },
  });
  persistCurrentMockSession();
}

// requirement 五／六：把一份已保存的 session 完整還原——重建同一份 50 題、
// 同一個順序、同樣的作答內容跟目前題號，不重新抽題。用 beginQuiz() 不行，
// 它本體會把 qIdx/answered 整個重設成空的（見 index.html 的
// beginQuiz()），所以這裡自己動手做 beginQuiz() 該做的畫面切換，但跳過
// 「歸零」那一步。如果發現已經超過 deadline，直接自動交卷，不需要使用者
// 再做任何動作（requirement 六）。
function resumeMockSession(session) {
  const qList = session.questionIds
    .map(function (n) {
      return window.QS && window.QS.find(function (q) {
        return q.n === n;
      });
    })
    .filter(Boolean);
  if (qList.length !== session.questionIds.length) {
    // 題庫對不起來（理論上不該發生：exam-data.js 沒換過），保守起見放棄還原，
    // 避免用不完整的題目清單造成後續索引錯亂，並清掉這個壞掉的 session。
    alert("這場模擬考的題目資料異常，無法還原，請重新開始一場模擬考。");
    mockExam.clearSession();
    return;
  }

  stopTimer();
  stopMockExamTimer();
  currentMockAttemptId = session.attemptId;
  currentMockCourse = session.course;
  currentMockStartedAt = session.startedAt;
  // 這裡一定要先設好 currentMockDeadline，不能只靠等一下才呼叫的
  // startMockExamTimer(session.deadline) 去設——中間的 window.renderQ() 呼叫
  // 會先觸發一次 persistCurrentMockSession()（把 deadline: currentMockDeadline
  // 寫回 session），如果這時候 currentMockDeadline 還沒設好，就會把還原後的
  // session 覆寫成錯的 deadline（實測會被覆寫成 null）。
  currentMockDeadline = session.deadline;
  mockSubmitting = false;

  window.qList = qList;
  window.answered = Object.assign({}, session.answers);
  window.qIdx = Math.min(session.currentIndex || 0, qList.length - 1);
  hasPromptedFiftyComplete = Object.keys(window.answered).length >= qList.length;

  reviewIsMockExam = true;
  inReviewMode = true;
  currentReviewGetter = function () {
    return getMockExamQuestions(session.course);
  };
  reviewReturnTo = "quiz-select";
  reviewReturnCourse = session.course;
  suppressResumeCheck = true; // 這是模擬考自己的還原機制，不要再跳「一般練習」那套 myAnswers 續作提示

  if (mockExam.isExpired(session.deadline, Date.now())) {
    // requirement 六：還原當下已經超過截止時間，直接自動交卷，不需要使用者
    // 再按任何按鈕、也不會先把逾時的畫面呈現給使用者看。
    document.getElementById("course-select").style.display = "none";
    document.getElementById("quiz-select").style.display = "none";
    document.getElementById("quiz-area").style.display = "none";
    finishMockAttempt(session.attemptId, { autoSubmitted: true });
    return;
  }

  document.getElementById("course-select").style.display = "none";
  document.getElementById("quiz-select").style.display = "none";
  document.getElementById("quiz-area").style.display = "block";
  document.getElementById("quiz-result").style.display = "none";
  document.getElementById("q-tot").textContent = qList.length;
  window.buildDots();
  Object.keys(window.answered).forEach(function (idxStr) {
    window.updateDot(parseInt(idxStr, 10), "answered");
  });
  window.renderQ();
  startMockExamTimer(session.deadline);
  mockExam.showOperationBar({
    onPrev: function () {
      moveMockQuestion(-1);
    },
    onNext: function () {
      moveMockQuestion(1);
    },
    onSubmit: function () {
      requestMockSubmit(session.attemptId);
    },
  });
}

// requirement 五：「繼續上次模擬考」卡片——依 Rex 的選擇，course-select
// （最上層科目選擇頁）跟對應科目的 quiz-select 頁面都會顯示。這裡統一在
// 兩個畫面各自的容器就緒時呼叫，卡片內容／還原邏輯共用同一份。
function renderMockResumeCards() {
  const session = mockExam.loadSession();
  const courseSelectEl = document.getElementById("course-select");
  const quizSelectEl = document.getElementById("quiz-select");

  if (!session) {
    if (courseSelectEl) mockExam.removeResumeCard(courseSelectEl);
    if (quizSelectEl) mockExam.removeResumeCard(quizSelectEl);
    return;
  }

  const total = session.questionIds.length;
  const answeredCount = Object.keys(session.answers || {}).length;
  const summary = {
    course: session.course,
    courseLabel: mockCourseLabel(session.course),
    total: total,
    answeredCount: answeredCount,
    deadline: session.deadline,
    updatedAt: session.updatedAt,
  };

  if (courseSelectEl && courseSelectEl.style.display !== "none") {
    mockExam.renderResumeCard(courseSelectEl, summary, function () {
      resumeMockSession(session);
    });
  }
  if (quizSelectEl) {
    if (window.currentCourse === session.course) {
      mockExam.renderResumeCard(quizSelectEl, summary, function () {
        resumeMockSession(session);
      });
    } else {
      mockExam.removeResumeCard(quizSelectEl);
    }
  }
}

// requirement 八常駐入口：緊鄰模擬考橫幅（Rex 選定的位置）。獨立成一個
// 函式、每次 ensureMockExamBanner() 執行都會呼叫（不管是不是走「同科目不
// 重建橫幅」那條快速路徑）——因為 myMockHistory 是否「這科已經有歷次成績」
// 這件事，可能在「同一科目」的情況下也會改變（最常見：使用者在同一個
// 頁面沒重新整理，剛交完這科的第一次模擬考、從結果頁換考卷退回來，
// mockExamBannerCourse 沒變但 myMockHistory 已經多了一筆），舊版把這段邏輯
// 整個包在「科目不同才重建」的區塊裡，會漏掉這個情況，導致剛交卷完的那科
// 入口按鈕要重新整理頁面才會出現。
function refreshMockHistoryEntryButton(course) {
  const banner = document.getElementById("mock-exam-banner");
  if (!banner) return;
  let wrap = document.getElementById("mock-history-entry");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.id = "mock-history-entry";
    wrap.style.cssText = "margin-bottom:16px";
    banner.insertAdjacentElement("afterend", wrap);
  }
  const hasHistory = myMockHistory.some(function (h) {
    return h.course === course;
  });
  if (!hasHistory) {
    wrap.innerHTML = "";
    return;
  }
  if (!document.getElementById("mock-history-entry-btn")) {
    wrap.innerHTML =
      '<button type="button" id="mock-history-entry-btn" style="background:none;border:1.5px solid var(--bd);color:var(--teal-d);border-radius:50px;padding:8px 18px;font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit">📊 查看這科的模擬考歷次成績</button>';
    document.getElementById("mock-history-entry-btn").onclick = function () {
      openMockHistoryForCourse(course);
    };
  }
}

// ---------------------------------------------------------------------------
// 模擬考歷次成績：跟 answers/flagged 存在同一份 LOCAL_KEY／同一份 Firestore
// 文件裡（見 loadLocal/saveLocal/pushToCloud），不另外開一個 key，
// 避免 setDoc 沒有帶 merge:true 時互相覆蓋掉對方欄位。
// ---------------------------------------------------------------------------

function recordMockResult(course, score, correct, total, passed, attemptId) {
  if (!course) return;
  // 第二層防重複保險：即使呼叫端（finishMockAttempt）不知為何還是對同一個
  // attemptId 呼叫了兩次，這裡也不會讓 myMockHistory 出現兩筆一樣的紀錄。
  // myMockHistory 本身只是陣列、沒有任何唯一性約束，這一關不能省。
  if (attemptId && myMockHistory.some(function (h) { return h.attemptId === attemptId; })) {
    return;
  }
  myMockHistory.unshift({
    course: course,
    date: new Date().toISOString(),
    score: score,
    correct: correct,
    total: total,
    passed: passed,
    attemptId: attemptId,
  });
  if (myMockHistory.length > 30) myMockHistory.length = 30;
  saveLocal();
  if (currentUser) pushToCloud();
}







function tickMockExamTimer() {
  const el = document.getElementById("quiz-timer");
  const quizAreaEl = document.getElementById("quiz-area");
  const pageQuizEl = document.getElementById("page-quiz");
  if (
    !el ||
    !currentMockDeadline ||
    !quizAreaEl ||
    quizAreaEl.style.display === "none" ||
    !pageQuizEl ||
    !pageQuizEl.classList.contains("active")
  ) {
    // 已經離開作答畫面（正常寫完自動看結果、使用者手動離開、或透過上方主
    // 導覽切到別的頁面），倒數計時沒有必要再繼續跑，順便清掉自己。
    // 額外檢查 #page-quiz 是否還是 active：只看 quiz-area 的 inline
    // display 沒辦法偵測到「透過主導覽切到別頁」這種情況——那只會讓
    // #page-quiz 失去 active class，quiz-area 本身的 inline style 不會
    // 被動到——若不補這個檢查，計時到期後會在使用者早已離開的情況下，
    // 仍在背景呼叫 finishMockAttempt()，把一次幾乎都沒作答的模擬考
    // 成績誤存進歷次成績（且會同步到雲端）。
    stopMockExamTimer();
    return;
  }
  const remainMs = mockExam.computeRemainingMs(currentMockDeadline, Date.now());
  el.textContent = "⏱ " + mockExam.formatCountdown(remainMs);
  const urgent = remainMs <= 5 * 60 * 1000;
  el.style.color = urgent ? "#993c1d" : "var(--teal-d)";
  el.style.background = urgent ? "#faece7" : "var(--teal-l)";
  if (mockExam.isExpired(currentMockDeadline, Date.now())) {
    stopMockExamTimer();
    const boundAttemptId = currentMockAttemptId;
    finishMockAttempt(boundAttemptId, { autoSubmitted: true });
  }
}

function startMockExamTimer(deadline) {
  currentMockDeadline = deadline;
  const el = ensureTimerDisplay();
  if (!el) return;
  tickMockExamTimer();
  if (mockExamIntervalId) clearInterval(mockExamIntervalId);
  mockExamIntervalId = setInterval(tickMockExamTimer, 1000);
}

function startMockExam(course) {
  if (!course) return;
  const preview = getMockExamQuestions(course);
  if (!preview.length) {
    alert("目前題庫還沒有這個科目的題目，請稍後再試。");
    return;
  }

  // requirement（發布前阻擋問題三）：開始新的一場模擬考之前，一定要先檢查
  // 是否已經有「未完成」的模擬考 session——SESSION_KEY 全站只有一格、不分
  // 科目，同一時間只能有一場「進行中」的模擬考。原本這裡完全沒有檢查，直接
  // 生成新的 attemptId，第一次 persistCurrentMockSession() 就會把舊 session
  // 整個蓋掉，使用者會在不知情的狀況下弄丟上一場還沒交卷的進度，不論新開的
  // 是不是同一個科目都一樣。
  const existingSession = mockExam.loadSession();
  if (existingSession) {
    const sameCourse = existingSession.course === course;
    const existingLabel = mockCourseLabel(existingSession.course);
    const answeredCount = Object.keys(existingSession.answers || {}).length;
    const totalCount = existingSession.questionIds.length;
    mockExam.showMockConfirm({
      title: "已經有一場未完成的模擬考",
      message:
        "科目：" +
        existingLabel +
        "　已完成 " +
        answeredCount +
        " / " +
        totalCount +
        " 題\n\n" +
        (sameCourse
          ? "要繼續上次的進度，還是放棄後重新開始一場新的？"
          : "要先回去繼續完成上次的進度，還是放棄它、直接開始這科新的模擬考？"),
      confirmText: "繼續上次模擬考",
      extraText: "放棄上次進度並開始新考試",
      cancelText: "取消",
      onConfirm: function () {
        // 使用者選了「繼續」：不論剛剛點的是不是同一科目，一律回去繼續
        // 原本那一場，不能悄悄開始新的一場、也不能把舊的丟掉。
        resumeMockSession(existingSession);
      },
      onExtra: function () {
        // 只有明確選「放棄上次進度」才可以清掉舊 session、往下走開新考試
        // 的正常流程；取消／點背景關閉都不會走到這裡，舊 session 完全不變。
        mockExam.clearSession();
        proceedStartMockExam(course);
      },
      onCancel: function () {
        // 使用者選「取消」：什麼都不做，舊 session 原封不動留著。
      },
    });
    return;
  }

  proceedStartMockExam(course);
}

function ensureMockExamBanner() {
  const container = document.getElementById("quiz-select");
  if (!container) return;
  const course = window.currentCourse;
  if (course === mockExamBannerCourse) {
    refreshMockHistoryEntryButton(course);
    renderMockResumeCards();
    return; // 同一科目不用重建橫幅，但續作卡片／歷史入口每次都要重新檢查
  }
  const old = document.getElementById("mock-exam-banner");
  if (old) old.remove();
  const oldHistory = document.getElementById("mock-history-entry");
  if (oldHistory) oldHistory.remove();
  mockExamBannerCourse = course;
  if (!course) return;

  const banner = document.createElement("div");
  banner.id = "mock-exam-banner";
  banner.style.cssText =
    "display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;" +
    "background:linear-gradient(135deg,#4BA6A1,#1F3B5C);color:#fff;border-radius:var(--r);" +
    "padding:18px 22px;margin-bottom:12px;box-shadow:0 8px 20px rgba(31,59,92,.18)";
  banner.innerHTML =
    '<div><div style="font-size:15.5px;font-weight:700;margin-bottom:3px">🎯 模擬國考</div>' +
    '<div style="font-size:12.5px;opacity:.85">隨機抽取 ' +
    MOCK_EXAM_QUESTION_COUNT +
    ' 題．限時 60 分鐘．時間到自動送出，最貼近真實考試節奏 <a href="mock-exam-guide.html" target="_blank" style="color:#fff;text-decoration:underline;opacity:.85">怎麼用？</a></div></div>' +
    '<button type="button" id="mock-exam-start-btn" style="flex-shrink:0;background:#fff;color:var(--teal-d);' +
    'border:none;border-radius:50px;padding:10px 22px;font-size:14px;font-weight:700;cursor:pointer;' +
    'font-family:inherit;white-space:nowrap">開始模擬考 →</button>';

  // 跟 ensureTagPracticeBar() 用同一招插在「標題列之後」；因為這個函式
  // 是在 selectCourse 裡排在練習列「之後」呼叫，所以會插到練習列前面，
  // 排出「標題 → 模擬國考 → 標籤練習 → 考卷列表」的順序。
  if (container.children.length > 1) {
    container.insertBefore(banner, container.children[1]);
  } else {
    container.appendChild(banner);
  }
  const startBtn = document.getElementById("mock-exam-start-btn");
  if (startBtn) {
    startBtn.onclick = function () {
      startMockExam(course);
    };
  }

  refreshMockHistoryEntryButton(course);
  renderMockResumeCards();
}

// ---------------------------------------------------------------------------
// 📊 固定式進度條：題目或解析內容較長、捲動離開畫面最上方的原本進度條之後，
// 畫面頂端會浮現一條細進度條（跟 #prog-bar 的寬度同步），不用滑回頂端
// 也能看到目前作答進度。只在 quiz-area 顯示中才會出現。
// ---------------------------------------------------------------------------

let stickyBarInited = false;

function ensureStickyProgressBar() {
  if (stickyBarInited) return;
  stickyBarInited = true;
  const track = document.createElement("div");
  track.id = "sticky-progress-track";
  track.style.cssText =
    "position:fixed;top:0;left:0;right:0;height:4px;background:var(--teal-l);z-index:9999;display:none";
  const fill = document.createElement("div");
  fill.id = "sticky-progress-fill";
  fill.style.cssText =
    "height:100%;background:var(--teal);width:0%;transition:width .3s";
  track.appendChild(fill);
  document.body.appendChild(track);
  window.addEventListener("scroll", updateStickyProgressBar, {
    passive: true,
  });
}

function updateStickyProgressBar() {
  const track = document.getElementById("sticky-progress-track");
  const fill = document.getElementById("sticky-progress-fill");
  const srcBar = document.getElementById("prog-bar");
  const quizAreaEl = document.getElementById("quiz-area");
  if (!track || !fill || !srcBar || !quizAreaEl) return;
  if (quizAreaEl.style.display === "none") {
    track.style.display = "none";
    return;
  }
  const srcRect = srcBar.getBoundingClientRect();
  track.style.display = srcRect.top < 0 ? "block" : "none";
  fill.style.width = srcBar.style.width || "0%";
}

function hideStickyProgressBar() {
  const track = document.getElementById("sticky-progress-track");
  if (track) track.style.display = "none";
}

// ---------------------------------------------------------------------------
// 📱 題目圓點導覽（#qdots）題數多（50～80題）時原本會換行變好幾排，把題目
// 卡往下推很遠。這裡只改既有元素的 style（不動 index.html 的 buildDots()/
// CSS），讓它變成單排、可橫向滑動，並在每次切換題目時把目前題號捲到看得見
// 的位置。
// ---------------------------------------------------------------------------

function enhanceQDots() {
  const qdots = document.getElementById("qdots");
  if (!qdots || qdots.dataset.enhanced) return;
  qdots.dataset.enhanced = "1";
  qdots.style.flexWrap = "nowrap";
  qdots.style.overflowX = "auto";
  qdots.style.overflowY = "hidden";
  qdots.style.webkitOverflowScrolling = "touch";
  qdots.style.paddingBottom = "6px";
  // 注意：這裡故意不設成 "smooth"。scrollCurrentDotIntoView() 是用直接指定
  // scrollLeft 的方式做「立即定位」，但瀏覽器對 scrollLeft/scrollTop 的
  // setter 也會套用 CSS scroll-behavior:smooth（不是只有 scrollTo() 才會），
  // 如果這裡設成 smooth，會讓原本想要「立即生效」的定位變成一段動畫，
  // 動畫還沒跑完就被下一次 renderQ() 蓋掉，導致目前題號其實沒有真的捲到
  // 看得見的位置。明確設成 "auto" 確保是立即捲動。
  qdots.style.scrollBehavior = "auto";
}

function scrollCurrentDotIntoView() {
  const qdots = document.getElementById("qdots");
  if (!qdots) return;
  const cur =
    qdots.querySelector(".qdot.cur") || qdots.children[window.qIdx || 0];
  if (!cur) return;
  // 用 offsetLeft 自己算出「讓目前題號置中」需要的捲動位置，
  // 不用 scrollIntoView——它在某些瀏覽器/情境下對巢狀捲動容器的支援不一致。
  const target = cur.offsetLeft - qdots.clientWidth / 2 + cur.offsetWidth / 2;
  const left = Math.max(0, target);
  // 直接設定 scrollLeft（而非 smooth 動畫）：實測發現部分瀏覽器/情境下
  // smooth 捲動動畫不會確實完成，導致目前題號沒有真的捲到看得見的位置；
  // 這裡改成立即定位＋強制觸發一次 reflow，確保每次都會確實生效。
  qdots.scrollLeft = left;
  void qdots.offsetHeight;
}

// ---------------------------------------------------------------------------
// 👆 左右滑動切換題目（僅題目卡 #q-card 範圍內偵測，避免和一般垂直捲動、
// 點選項按鈕互相干擾）：
//   向左滑＝下一題，沿用原本「答完才會出現下一題」的規則，不會讓人滑過去
//   跳過作答；向右滑＝回上一題，跟點圓點導覽一樣隨時可以回去看。
// ---------------------------------------------------------------------------

let swipeInited = false;
let touchStartX = 0;
let touchStartY = 0;

function ensureSwipeGesture() {
  if (swipeInited) return;
  const qCard = document.getElementById("q-card");
  if (!qCard) {
    setTimeout(ensureSwipeGesture, 300);
    return;
  }
  swipeInited = true;
  qCard.addEventListener(
    "touchstart",
    function (e) {
      if (!e.touches || !e.touches.length) return;
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
    },
    { passive: true }
  );
  qCard.addEventListener(
    "touchend",
    function (e) {
      if (!e.changedTouches || !e.changedTouches.length) return;
      const dx = e.changedTouches[0].clientX - touchStartX;
      const dy = e.changedTouches[0].clientY - touchStartY;
      if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      const qList = window.qList;
      if (!qList || !qList.length) return;
      if (dx < 0) {
        if (window.answered && window.answered[window.qIdx] !== undefined) {
          window.nextQ();
        }
      } else if (window.qIdx > 0) {
        window.qIdx -= 1;
        window.renderQ();
      }
    },
    { passive: true }
  );
}

// ---------------------------------------------------------------------------
// ⏱ 正向碼表：只在「一般整份考卷」作答時顯示（錯題本／疑難標記複習、
// 依標籤跨考卷練習不算，那些是複習/練習性質，不計時——由 startReviewList()
// 一律呼叫 stopTimer() 來保證，不管從哪個入口進複習模式都會停止/隱藏）。
// 從進入考卷那一刻從 0 開始正向累計（MM:SS），純參考用途：不會限制作答、
// 不會強制交卷、也不會跳出任何提示視窗；累計超過參考時長（60分鐘）後
// 只是文字變色提醒，之後仍會繼續正常累加。
// ---------------------------------------------------------------------------

const TIMER_REFERENCE_SECONDS = 60 * 60; // 參考時長 60 分鐘
let timerIntervalId = null;
let timerStartedAt = null;

function formatElapsed(totalSec) {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
}

function ensureTimerDisplay() {
  let el = document.getElementById("quiz-timer");
  if (el) return el;
  // 插在「✓ /✗」計數徽章那個小容器的最前面（跟現有的作答統計並排）。
  const cntOkEl = document.getElementById("cnt-ok");
  const badgeRow = cntOkEl && cntOkEl.closest("div");
  if (!badgeRow) return null;
  el = document.createElement("span");
  el.id = "quiz-timer";
  el.style.cssText =
    "font-size:13px;color:var(--teal-d);background:var(--teal-l);padding:3px 12px;border-radius:20px;font-variant-numeric:tabular-nums";
  el.textContent = "⏱ 00:00";
  badgeRow.insertBefore(el, badgeRow.firstChild);
  return el;
}

function tickTimer() {
  const el = document.getElementById("quiz-timer");
  const pageQuizEl = document.getElementById("page-quiz");
  if (!el || !timerStartedAt) return;
  if (!pageQuizEl || !pageQuizEl.classList.contains("active")) {
    // 同上（見 tickMockExamTimer 的說明）：透過主導覽切到別頁時只有
    // #page-quiz 會失去 active class，這裡額外清掉自己，正向碼表才不會
    // 在使用者離開後繼續在背景累計、白白佔用計時器資源。
    stopTimer();
    return;
  }
  const elapsed = Math.floor((Date.now() - timerStartedAt) / 1000);
  el.textContent = "⏱ " + formatElapsed(elapsed);
  const overTime = elapsed >= TIMER_REFERENCE_SECONDS;
  el.style.color = overTime ? "#993c1d" : "var(--teal-d)";
  el.style.background = overTime ? "#faece7" : "var(--teal-l)";
}

function startTimer() {
  if (inReviewMode) return; // 複習／標籤練習不計時
  const el = ensureTimerDisplay();
  if (!el) return;
  timerStartedAt = Date.now();
  el.textContent = "⏱ 00:00";
  el.style.color = "var(--teal-d)";
  el.style.background = "var(--teal-l)";
  if (timerIntervalId) clearInterval(timerIntervalId);
  timerIntervalId = setInterval(tickTimer, 1000);
}

function stopTimer() {
  if (timerIntervalId) {
    clearInterval(timerIntervalId);
    timerIntervalId = null;
  }
  timerStartedAt = null;
  const el = document.getElementById("quiz-timer");
  if (el) el.remove();
}

// ---------------------------------------------------------------------------
// 掛勾層：在不改動 index.html 既有函式本體的前提下，
// 把「記錄作答」「還原進度」「疑難標記」「錯題本／疑難標記複習」接到既有的
// selectOpt / startExam / filterSubj / beginQuiz / renderQ /
// restartQuiz / backToSelect 上。
// ---------------------------------------------------------------------------

let hooksInstalled = false;

function initQuizHooks() {
  if (hooksInstalled) return;
  if (
    typeof window.selectOpt !== "function" ||
    typeof window.startExam !== "function" ||
    typeof window.filterSubj !== "function" ||
    typeof window.beginQuiz !== "function" ||
    typeof window.renderQ !== "function" ||
    typeof window.updateDot !== "function" ||
    typeof window.restartQuiz !== "function" ||
    typeof window.backToSelect !== "function" ||
    typeof window.backToCourseSelect !== "function" ||
    typeof window.selectCourse !== "function" ||
    typeof window.showResult !== "function" ||
    typeof window.nextQ !== "function" ||
    typeof window.goPage !== "function"
  ) {
    setTimeout(initQuizHooks, 200);
    return;
  }
  hooksInstalled = true;

  const origSelectCourse = window.selectCourse;
  window.selectCourse = function (n) {
    leaveActiveMockExamView();
    origSelectCourse(n);
    ensureTagPracticeBar();
    ensureMockExamBanner();
    pushQuizSubStateIfNeeded();
    syncAndroidBetaCardVisibility();
  };

  // backToCourseSelect()（「← 換科目」）是使用者自己主動退回科目選擇畫面，
  // 這裡把「瀏覽器上一頁」補丁用的旗標一併重置，避免下次選科目時漏補歷史紀錄。
  const origBackToCourseSelect = window.backToCourseSelect;
  window.backToCourseSelect = function () {
    leaveActiveMockExamView();
    origBackToCourseSelect();
    // 防禦性收尾：origBackToCourseSelect() 本體只在正常情況下（從
    // quiz-select 按「← 換科目」）才會被呼叫，這時 quiz-area／quiz-result
    // 本來就已經是隱藏的，這裡再明確隱藏一次不會有副作用；但如果未來出現
    // 其他非預期呼叫路徑（例如從結果頁直接呼叫），也能確保三個子畫面跟
    // course-select 不會同時「看起來都可見」，讓下面的卡片顯示判斷永遠準確。
    const quizAreaEl = document.getElementById("quiz-area");
    const quizResultEl = document.getElementById("quiz-result");
    if (quizAreaEl) quizAreaEl.style.display = "none";
    if (quizResultEl) quizResultEl.style.display = "none";
    quizHistoryPushed = false;
    renderMockResumeCards();
    syncAndroidBetaCardVisibility();
  };

  // goPage()（頂層分頁切換：首頁／考題／筆記…）是 index.html 自己的路由
  // 函式，跟 quiz-area 顯示邏輯本來無關，但模擬考操作列是 position:fixed
  // 掛在 document.body 上、刻意獨立於 #quiz-area 之外（見 quiz-mock-exam.js
  // 開頭的設計說明），不會因為 #page-quiz 整個被切成非 active 而自動隱藏
  // ——不主動處理，使用者切到別的分頁（例如首頁）時，這排固定操作列會
  // 繼續飄在畫面上。這裡統一在任何分頁切換前先隱藏；回到模擬考時會由
  // resumeMockSession()／startMockExam() 重新顯示，不受影響。
  const origGoPage = window.goPage;
  window.goPage = function (page) {
    // requirement（發布前阻擋問題二）：從頂層導覽切走時，如果目前真的正在
    // 一場模擬考「作答中」，要先把最新作答狀態存檔，「再」把畫面層的複習模式
    // 旗標（reviewIsMockExam／inReviewMode／currentReviewGetter）安全關掉——
    // 順序不能反過來，persistCurrentMockSession() 內部本身就是靠
    // reviewIsMockExam 才會存檔，旗標一旦先關掉，存檔會變成 no-op。
    //
    // 這裡刻意多判斷一個條件——quiz-area 目前是不是真的顯示中，不能只看
    // reviewIsMockExam：reviewIsMockExam 在使用者「已經交卷、正在看結果頁」
    // 的狀態下也還是 true（restartQuiz() 的「再做一次」需要靠它才能正確判斷
    // 要開新的一場模擬考，不能提早關掉），但這時 window.qList／window.answered
    // 還留著剛剛那場「已經交完、session 已經被清掉」的舊資料。如果只看
    // reviewIsMockExam 就呼叫 persistCurrentMockSession()，會把這份已交卷、
    // 已清除的舊資料重新寫回 localStorage，變成一個「假的未完成 session」，
    // 下次開新考試時會被 startMockExam() 誤判成「有未完成進度」而跳出不必要
    // 的三選一提示——這是實際寫測試（開兩場模擬考、第一場交卷後從結果頁直接
    // 切分頁再切回來）時真的重現到的 bug，不是假設情境。
    const quizAreaEl = document.getElementById("quiz-area");
    const actuallyMidMockExam = reviewIsMockExam && quizAreaEl && quizAreaEl.style.display !== "none";
    if (actuallyMidMockExam) {
      persistCurrentMockSession();
    }
    reviewIsMockExam = false;
    inReviewMode = false;
    currentReviewGetter = null;
    leaveActiveMockExamView();
    // 原始 goPage() 會回傳 false，供導覽列的
    // onclick='return goPage("quiz")' 阻止 <a href="quiz.html"> 的預設跳轉。
    // 包裝後也必須把這個回傳值原樣交回去；若漏掉 return，inline handler
    // 取得 undefined，瀏覽器就會繼續開啟獨立的 quiz.html 介紹頁。
    const routeResult = origGoPage(page);
    if (page === "quiz") {
      // 立刻畫一次：多數情況下（例如本來就停在 course-select 或另一個
      // 分頁）#course-select 這時已經是唯一可見的畫面，可以馬上看到卡片。
      renderMockResumeCards();
      // origGoPage() 對 "quiz" 這個分頁的畫面重置是包在它自己內部的
      // setTimeout(..., 10) 裡（非同步、晚 10ms 才真的把 course-select 切回
      // display:block、quiz-select/quiz-area/quiz-result 切回 none）。如果
      // 呼叫當下使用者是從作答中／結果頁離開，上面那次立刻呼叫時
      // #course-select 讀到的還是重置前的 display:none，
      // renderMockResumeCards() 自己「只在 course-select 目前可見才插卡片」
      // 的判斷會直接略過，卡片就不會出現、也沒有人再補畫一次。這裡一定要再
      // 排一次在延遲重置「之後」執行，確保不管呼叫當下是什麼畫面狀態，卡片
      // 最後都會正確出現。
      setTimeout(function () {
        renderMockResumeCards();
        syncAndroidBetaCardVisibility();
      }, 20);
    }
    return routeResult;
  };

  // 正式模擬考的題目卡上，只標出「目前選了哪一個」（中性樣式，不透露對錯），
  // selectOpt()／renderQ() 都要套用同一份邏輯，抽成共用函式。
  function applyMockAnswerHighlight() {
    hideMockScoreBadges();
    const fb = document.getElementById("q-feedback");
    if (fb) fb.style.display = "none";
    const sel = window.answered ? window.answered[window.qIdx] : undefined;
    document.querySelectorAll("#q-opts .opt-btn").forEach(function (btn, idx) {
      btn.classList.remove("correct", "wrong", "show-ans");
      btn.disabled = false; // 交卷前隨時可以改答案，不能維持 origSelectOpt() 上的 disabled
      btn.style.borderColor = idx === sel ? "var(--teal)" : "";
      btn.style.background = idx === sel ? "var(--teal-l)" : "";
    });
  }

  const origSelectOpt = window.selectOpt;
  window.selectOpt = function (n) {
    const wasAnswered =
      window.answered && window.answered[window.qIdx] !== undefined;

    // 正式模擬考且這題已經答過一次：不能再呼叫 origSelectOpt()，因為它本體
    // 一開始就寫死「已作答直接 return」，改答案永遠不會生效。這裡改成自己
    // 直接覆蓋 answered，不去動 cntOk/cntBad 那組累加計數器——反正交卷時
    // （見 showResult 掛勾）會重新用 qList+answered 整個算一次最終分數，
    // 不依賴這兩個只在「第一次作答」當下才準的計數器。
    if (reviewIsMockExam && wasAnswered) {
      window.answered[window.qIdx] = n;
      const q = window.qList && window.qList[window.qIdx];
      if (q) recordAnswer(q.n, n);
      applyMockAnswerHighlight();
      updateStickyProgressBar();
      persistCurrentMockSession(); // requirement 四：修改答案也要自動保存
      maybePromptFiftyComplete(currentMockAttemptId);
      return;
    }

    const q = window.qList && window.qList[window.qIdx];
    origSelectOpt(n);
    if (q) recordAnswer(q.n, n);
    updateStickyProgressBar();
    // 正式模擬考：作答當下不能看到對錯，這裡沿用 selectOpt() 本體（避免另外
    // 複製一份平行的作答流程），只在它上色／顯示解析／鎖定按鈕「之後」立刻
    // 復原。這一段跟 origSelectOpt() 都在同一次同步呼叫、畫面還沒真正畫出
    // 來，所以使用者不會看到「先顯示對錯又馬上消失」的閃爍。
    if (reviewIsMockExam) {
      applyMockAnswerHighlight();
      persistCurrentMockSession();
      maybePromptFiftyComplete(currentMockAttemptId);
    }
  };

  const origStartExam = window.startExam;
  window.startExam = function (examCode) {
    showMockScoreBadges(); // 防禦性還原：一般練習模式的成績徽章一定要看得到
    origStartExam(examCode);
    afterQuizListLoaded();
    startTimer();
    syncAndroidBetaCardVisibility();
  };

  const origFilterSubj = window.filterSubj;
  window.filterSubj = function (el, subj) {
    origFilterSubj(el, subj);
    afterQuizListLoaded();
  };

  const origBeginQuiz = window.beginQuiz;
  window.beginQuiz = function () {
    origBeginQuiz();
    afterQuizListLoaded();
    syncAndroidBetaCardVisibility();
  };

  // 正式模擬考的答題地圖（qdots）不能用顏色透露對錯，所以這裡整個接管、
  // 不呼叫 origUpdateDot——一般練習模式完全不受影響。
  const origUpdateDot = window.updateDot;
  window.updateDot = function (n, s) {
    if (reviewIsMockExam) {
      const el = document.getElementById("dot" + n);
      if (el) {
        el.classList.remove("cur", "ok", "bad");
        el.style.background = "var(--teal-l)";
        el.style.color = "var(--teal-d)";
        el.style.fontWeight = "600";
      }
      return;
    }
    origUpdateDot(n, s);
  };

  // 一般練習：沿用 nextQ() 本體（寫完最後一題時它會直接呼叫 showResult()，
  // 這是一般練習「寫完自動看結果」的既有行為，不能動）。
  // 正式模擬考：nextQ() 本體同一段邏輯完全不能用——絕不能讓滑動手勢（見
  // ensureSwipeGesture()，它在「目前題已作答」時會呼叫 window.nextQ()）在
  // 剛好答完全部題目那一刻意外觸發自動交卷；交卷一律要走
  // requestMockSubmit()／maybePromptFiftyComplete() 的明確確認流程。這裡
  // 改成單純移動到下一題，跟固定操作列的「下一題」按鈕（moveMockQuestion）
  // 是同一個函式、行為完全一致，不呼叫 origNextQ，也絕對不會呼叫
  // showResult()。
  const origNextQ = window.nextQ;
  window.nextQ = function () {
    if (reviewIsMockExam) {
      moveMockQuestion(1);
      return;
    }
    origNextQ();
  };

  // 模擬國考現在完全不會走到這裡交卷——所有正常路徑都已經改成透過
  // requestMockSubmit()/maybePromptFiftyComplete() -> finishMockAttempt()
  // 明確交卷。這裡只保留一層防護：如果真的有沒預期到的呼叫路徑（例如未來
  // 新增的呼叫點）在模擬考進行中觸發了這個函式，寧可統一導去正式的交卷
  // 流程（真正保存明細＋清 session＋顯示正確的結果畫面），也不要沿用舊
  // 行為（沒有確認、沒有保存明細、也不會清掉 session，導致畫面跟實際保存
  // 的資料不同步）。
  const origShowResult = window.showResult;
  window.showResult = function () {
    if (reviewIsMockExam) {
      if (currentMockAttemptId) {
        finishMockAttempt(currentMockAttemptId, { autoSubmitted: false });
      }
      return;
    }
    origShowResult();
    syncAndroidBetaCardVisibility();
  };

  const origRenderQ = window.renderQ;
  window.renderQ = function () {
    origRenderQ();
    updateFlagButton();
    applyMockExamTag();
    enhanceQDots();
    scrollCurrentDotIntoView();
    updateStickyProgressBar();
    if (reviewIsMockExam) {
      applyMockAnswerHighlight();
      mockExam.updateOperationBar({
        currentIndex: window.qIdx,
        total: window.qList ? window.qList.length : 0,
      });
      persistCurrentMockSession();
    }
    syncAndroidBetaCardVisibility();
  };

  // restartQuiz()（結果頁「再做一次」）原本會照 currentExamFilter／
  // currentSubjFilter 重新用 QS 篩一份單一考卷的 qList，這樣會把複習清單
  // 整個換掉；複習模式下改成用同一個 getter 重新篩一次（順便讓剛剛答對、
  // 已經不算錯題/標記的題目自然消失），維持在複習清單裡重來一次。
  const origRestartQuiz = window.restartQuiz;
  window.restartQuiz = function () {
    if (reviewIsMockExam) {
      // 模擬國考「再做一次」＝真正開新的一場（新的 attemptId、重新抽題、
      // 重新給滿 60 分鐘），不是舊版那種「用同一個 getter 重新篩一次」的
      // 複習玩法——那一套只適用於錯題本／標籤練習，模擬考需要的是完全
      // 獨立的下一場 session，避免新舊兩場的 attemptId／deadline 混在一起。
      // startMockExam() 內建confirm() 詢問，跟從橫幅開始一場新模擬考是同一
      // 個入口、同一套確認流程，不另外做一條平行的免確認捷徑。
      const course = reviewReturnCourse;
      exitReview();
      if (course) startMockExam(course);
      return;
    }
    if (inReviewMode && currentReviewGetter) {
      const questions = currentReviewGetter();
      if (!questions.length) {
        alert("這份複習清單已經清空囉！");
        exitReview();
        return;
      }
      window.qList = questions;
      suppressResumeCheck = true;
      window.beginQuiz();
      return;
    }
    origRestartQuiz();
    startTimer();
    syncAndroidBetaCardVisibility();
  };

  // backToSelect()（「換考卷」）原本只會回到 quiz-select（考卷列表）畫面；
  // 複習模式下沒有對應的考卷列表可回，改成回到最上層的科目選擇畫面。
  const origBackToSelect = window.backToSelect;
  window.backToSelect = function () {
    if (inReviewMode) {
      exitReview();
      return;
    }
    origBackToSelect();
    hideStickyProgressBar();
    stopTimer();
  };

  // ---------------------------------------------------------------------------
  // 競速修正：quiz-sync.js 這個 module（含它 import 的 quiz-mock-exam.js）
  // 是非同步載入的，網路慢的時候可能在使用者已經呼叫「還沒被包裝」的原始
  // selectCourse()、quiz-select 畫面都已經顯示出來之後，這個函式才終於執行
  // 到這裡。這種情況下，剛剛那次 selectCourse() 呼叫走的是 index.html 內嵌
  // script 的原始版本，不會執行到上面 window.selectCourse 包裝層裡的
  // ensureTagPracticeBar()／ensureMockExamBanner()，使用者會看到 quiz-select
  // 畫面上沒有依標籤練習列、沒有模擬考橫幅／開始按鈕，而且不能要求使用者
  // 自己退回上一層再重新選一次科目才能補上——這裡在 hooks 真正裝好的當下，
  // 主動偵測「使用者是不是已經在 quiz-select 畫面、而且已經選了科目」，是的
  // 話立刻補畫一次，跟使用者正常走 selectCourse() 包裝層看到的結果完全一致。
  const quizSelectEl = document.getElementById("quiz-select");
  if (quizSelectEl && quizSelectEl.style.display !== "none" && window.currentCourse) {
    ensureTagPracticeBar();
    ensureMockExamBanner();
    renderMockResumeCards();
    syncAndroidBetaCardVisibility();
  }
}

// 從外部（例如「開始複習」流程）呼叫 beginQuiz() 時，代表 qList 是刻意重新組出來的
// 複習清單，不需要再跳「要不要繼續上次進度」的提示，所以用這個旗標跳過一次。
let suppressResumeCheck = false;

function afterQuizListLoaded(silentMergeCall) {
  if (suppressResumeCheck) {
    suppressResumeCheck = false;
    return;
  }
  const qList = window.qList;
  if (!qList || !qList.length) return;
  // quiz-area 沒有顯示中，代表使用者不在作答畫面（例如剛登入合併資料時人還在選科目頁），不用彈提示
  const quizAreaEl = document.getElementById("quiz-area");
  if (silentMergeCall && (!quizAreaEl || quizAreaEl.style.display === "none")) {
    return;
  }

  const priorAnswered = {};
  let answeredCount = 0;
  qList.forEach((q, i) => {
    if (myAnswers[q.n] !== undefined) {
      priorAnswered[i] = myAnswers[q.n];
      answeredCount++;
    }
  });
  if (answeredCount === 0) return;

  const allAnswered = answeredCount >= qList.length;
  const msg = allAnswered
    ? "這份考卷你之前已經全部作答完成，要重新作答一次嗎？\n（確定＝重新開始；取消＝直接看上次的作答結果）"
    : "偵測到你之前寫到第 " +
      answeredCount +
      " / " +
      qList.length +
      " 題，要繼續上次的進度嗎？\n（確定＝繼續上次進度；取消＝從頭開始）";
  const proceed = confirm(msg);

  if (!proceed) {
    qList.forEach((q) => {
      delete myAnswers[q.n];
    });
    saveLocal();
    if (currentUser) pushToCloud();
    return;
  }

  Object.assign(window.answered, priorAnswered);
  let ok = 0;
  let bad = 0;
  Object.keys(window.answered).forEach((i) => {
    const q = qList[i];
    const correct = q.ans.includes(window.answered[i]);
    if (correct) ok++;
    else bad++;
    window.updateDot(parseInt(i, 10), correct ? "ok" : "bad");
  });
  window.cntOk = ok;
  window.cntBad = bad;
  const okEl = document.getElementById("cnt-ok");
  const badEl = document.getElementById("cnt-bad");
  const barEl = document.getElementById("prog-bar");
  if (okEl) okEl.textContent = ok;
  if (badEl) badEl.textContent = bad;
  if (barEl) {
    barEl.style.width =
      (Object.keys(window.answered).length / qList.length) * 100 + "%";
  }

  let resumeIdx = qList.findIndex((q, i) => window.answered[i] === undefined);
  if (resumeIdx === -1) resumeIdx = qList.length - 1;
  window.qIdx = resumeIdx;
  window.renderQ();
}

// ============ 全站搜尋（考題全文 + 教學影片） ============
// 影片目錄是獨立的靜態 JSON（video-catalog.json），跟 exam-data.js／quiz-sync.js
// 完全分開，不需要動到 index.html。每筆影片盡量從標題解析出對應的題號（n）跟
// 考試場次提示（examHint，例如 "114-3"），讓搜尋結果可以直接連到「練習這一題」。
let VIDEO_CATALOG = null;
function loadVideoCatalog() {
  if (VIDEO_CATALOG !== null) return Promise.resolve(VIDEO_CATALOG);
  return fetch("video-catalog.json")
    .then((r) => (r.ok ? r.json() : []))
    .then((data) => {
      VIDEO_CATALOG = data;
      return data;
    })
    .catch(() => {
      VIDEO_CATALOG = [];
      return [];
    });
}

const SEARCH_Q_LIMIT = 25;
const SEARCH_V_LIMIT = 10;

function searchQuestions(query) {
  if (!window.QS || !query) return [];
  const results = [];
  for (let i = 0; i < window.QS.length && results.length < SEARCH_Q_LIMIT; i++) {
    const item = window.QS[i];
    if ((item.q && item.q.indexOf(query) !== -1) || (item.chapter && item.chapter.indexOf(query) !== -1)) {
      results.push(item);
    }
  }
  return results;
}

// 影片目錄裡，凡是能對應到題目（有 n）的影片就不重複存標題文字——搜尋比對
// 直接用 QS 裡對應題目的題幹／科目，顯示時也是秀那一題的內容，影片本身只是
// 「這題的講解影片」。只有真的對不到題目的極少數影片（約 1.8%）才保留自己
// 的標題（entry.t）另外比對。
function matchVideoEntry(v, query) {
  if (v.n !== undefined) {
    const q = window.QS && window.QS.find((x) => x.n === v.n);
    if (!q) return null;
    if ((q.q && q.q.indexOf(query) !== -1) || (q.chapter && q.chapter.indexOf(query) !== -1)) {
      return { id: v.i, n: v.n, displayText: q.q, linkedQ: q };
    }
    return null;
  }
  if (v.t && v.t.indexOf(query) !== -1) {
    return { id: v.i, n: undefined, displayText: v.t, linkedQ: null };
  }
  return null;
}

function searchVideos(query) {
  if (!VIDEO_CATALOG || !query) return [];
  const results = [];
  for (let i = 0; i < VIDEO_CATALOG.length && results.length < SEARCH_V_LIMIT; i++) {
    const m = matchVideoEntry(VIDEO_CATALOG[i], query);
    if (m) results.push(m);
  }
  return results;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

function highlightMatch(text, query) {
  const escaped = escapeHtml(text);
  if (!query) return escaped;
  const idx = text.indexOf(query);
  if (idx === -1) return escaped;
  const before = escapeHtml(text.slice(0, idx));
  const mid = escapeHtml(text.slice(idx, idx + query.length));
  const after = escapeHtml(text.slice(idx + query.length));
  return before + '<mark style="background:#fde68a;border-radius:2px">' + mid + "</mark>" + after;
}

const SEARCH_COURSE_LABELS = { medsurg: "內外科", psych: "精神科", basic: "基本護理", basicmed: "基礎醫學", obpeds: "婦兒科" };

function ensureSearchUI() {
  if (document.getElementById("gsearch-btn")) return;
  const nav = document.querySelector("nav");
  if (!nav) return;

  if (!document.getElementById("gsearch-style")) {
    const style = document.createElement("style");
    style.id = "gsearch-style";
    style.textContent =
      "@keyframes gsearchPulse{0%,100%{box-shadow:0 0 0 0 rgba(75,166,161,.35)}50%{box-shadow:0 0 0 6px rgba(75,166,161,0)}}" +
      "#gsearch-btn.gsearch-pulse{animation:gsearchPulse 1.4s ease-in-out 3}" +
      "@media (max-width:480px){#gsearch-btn .gsearch-btn-label{display:none}#gsearch-btn{padding:7px 10px}}";
    document.head.appendChild(style);
  }

  const SEARCH_SEEN_KEY = "rex_gsearch_seen_v1";
  let isFirstTimeSeeing = true;
  try {
    isFirstTimeSeeing = !localStorage.getItem(SEARCH_SEEN_KEY);
  } catch (e) {
    isFirstTimeSeeing = false;
  }

  const btn = document.createElement("button");
  btn.id = "gsearch-btn";
  btn.type = "button";
  btn.setAttribute("aria-label", "搜尋考題與教學影片");
  btn.title = "搜尋考題與教學影片";
  btn.style.cssText = "position:relative;display:inline-flex;align-items:center;gap:5px;background:var(--teal-l);border:none;border-radius:20px;cursor:pointer;font-size:15px;font-weight:600;padding:7px 14px;color:var(--teal-d);flex-shrink:0;font-family:inherit";
  btn.innerHTML = '<span>🔍</span><span class="gsearch-btn-label">搜尋</span>';
  if (isFirstTimeSeeing) {
    btn.classList.add("gsearch-pulse");
    const badge = document.createElement("span");
    badge.setAttribute("data-gsearch-badge", "1");
    badge.style.cssText = "position:absolute;top:-2px;right:-2px;width:8px;height:8px;border-radius:50%;background:#ef4444;border:1.5px solid var(--white)";
    btn.appendChild(badge);
  }
  btn.onclick = function () {
    try {
      localStorage.setItem(SEARCH_SEEN_KEY, "1");
    } catch (e) {}
    btn.classList.remove("gsearch-pulse");
    const badgeEl = btn.querySelector("[data-gsearch-badge]");
    if (badgeEl) badgeEl.remove();
    openSearchPanel();
  };
  nav.appendChild(btn);

  const overlay = document.createElement("div");
  overlay.id = "gsearch-overlay";
  overlay.style.cssText = "display:none;position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:300";
  overlay.onclick = function (e) {
    if (e.target === overlay) closeSearchPanel();
  };

  const panel = document.createElement("div");
  panel.id = "gsearch-panel";
  panel.style.cssText = "background:var(--white);max-width:640px;margin:8vh auto 0;border-radius:var(--r);max-height:80vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.25)";

  const inputRow = document.createElement("div");
  inputRow.style.cssText = "padding:16px 18px;border-bottom:1px solid var(--bd);display:flex;align-items:center;gap:10px;flex-shrink:0";
  const input = document.createElement("input");
  input.id = "gsearch-input";
  input.type = "text";
  input.placeholder = "搜尋考題與影片關鍵字（例如：高血鉀、庫欣氏症候群）...";
  input.style.cssText = "flex:1;border:none;outline:none;font-size:16px;font-family:inherit;background:transparent;color:var(--text)";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.textContent = "✕";
  closeBtn.setAttribute("aria-label", "關閉搜尋");
  closeBtn.style.cssText = "background:none;border:none;cursor:pointer;font-size:18px;color:var(--muted)";
  closeBtn.onclick = closeSearchPanel;
  inputRow.appendChild(input);
  inputRow.appendChild(closeBtn);

  const resultsBox = document.createElement("div");
  resultsBox.id = "gsearch-results";
  resultsBox.style.cssText = "overflow-y:auto;padding:8px 0";

  panel.appendChild(inputRow);
  panel.appendChild(resultsBox);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  let debounceTimer = null;
  input.addEventListener("input", function () {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function () {
      renderSearchResults(input.value.trim());
    }, 150);
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && overlay.style.display !== "none") closeSearchPanel();
  });
}

function openSearchPanel() {
  const overlay = document.getElementById("gsearch-overlay");
  if (!overlay) return;
  overlay.style.display = "block";
  loadVideoCatalog();
  const input = document.getElementById("gsearch-input");
  input.value = "";
  document.getElementById("gsearch-results").innerHTML = '<div style="padding:32px 20px;text-align:center;color:var(--muted);font-size:14px">輸入關鍵字，搜尋考題與教學影片</div>';
  setTimeout(function () {
    input.focus();
  }, 50);
}

function closeSearchPanel() {
  const overlay = document.getElementById("gsearch-overlay");
  if (overlay) overlay.style.display = "none";
}

function renderSearchResults(q) {
  const box = document.getElementById("gsearch-results");
  if (!box) return;
  if (!q) {
    box.innerHTML = '<div style="padding:32px 20px;text-align:center;color:var(--muted);font-size:14px">輸入關鍵字，搜尋考題與教學影片</div>';
    return;
  }

  const qResults = searchQuestions(q);
  const vResults = searchVideos(q);

  if (qResults.length === 0 && vResults.length === 0) {
    box.innerHTML = '<div style="padding:32px 20px;text-align:center;color:var(--muted);font-size:14px">沒有找到符合「' + escapeHtml(q) + '」的考題或影片</div>';
    return;
  }

  let html = "";

  if (vResults.length > 0) {
    html += '<div style="padding:10px 18px 4px;font-size:12.5px;font-weight:600;color:var(--teal-d)">🎬 相關教學影片</div>';
    vResults.forEach(function (v) {
      html +=
        '<div style="display:flex;align-items:center;gap:10px;padding:8px 18px" class="gsearch-video-row" data-vid="' +
        escapeHtml(v.id) +
        '"' +
        (v.n !== undefined ? ' data-n="' + v.n + '"' : "") +
        '><img src="https://img.youtube.com/vi/' +
        escapeHtml(v.id) +
        '/default.jpg" style="width:64px;height:36px;object-fit:cover;border-radius:6px;flex-shrink:0;cursor:pointer" class="gsearch-video-thumb"><div style="flex:1;min-width:0">' +
        '<div style="font-size:13.5px;line-height:1.4;cursor:pointer" class="gsearch-video-title">' +
        highlightMatch(v.displayText, q) +
        "</div>" +
        (v.n !== undefined ? '<button type="button" class="gsearch-practice-btn" style="margin-top:3px;font-size:11.5px;background:var(--teal-l);color:var(--teal-d);border:none;border-radius:20px;padding:2px 10px;cursor:pointer">練習這一題</button>' : "") +
        "</div></div>";
    });
  }

  if (qResults.length > 0) {
    html +=
      '<div style="padding:10px 18px 4px;font-size:12.5px;font-weight:600;color:var(--teal-d)">📝 相關考題（' +
      qResults.length +
      (qResults.length >= SEARCH_Q_LIMIT ? "+" : "") +
      "）</div>";
    qResults.forEach(function (item) {
      html +=
        '<div style="padding:8px 18px;cursor:pointer" class="gsearch-q-row" data-n="' +
        item.n +
        '"><div style="font-size:13.5px;line-height:1.5">' +
        highlightMatch(item.q, q) +
        '</div><div style="margin-top:3px;font-size:11.5px;color:var(--muted)">' +
        (SEARCH_COURSE_LABELS[item.course] || item.course) +
        " · " +
        escapeHtml(item.chapter) +
        "</div></div>";
    });
    html +=
      '<div style="padding:6px 18px 12px"><button type="button" id="gsearch-practice-all" style="width:100%;background:var(--teal);color:#fff;border:none;border-radius:var(--rs);padding:9px;font-size:13.5px;cursor:pointer;font-family:inherit">練習全部 ' +
      qResults.length +
      " 題相關考題</button></div>";
  }

  box.innerHTML = html;

  box.querySelectorAll(".gsearch-video-row").forEach(function (row) {
    const vid = row.getAttribute("data-vid");
    const openVideo = function () {
      window.open("https://www.youtube.com/watch?v=" + vid, "_blank");
    };
    row.querySelector(".gsearch-video-thumb").onclick = openVideo;
    row.querySelector(".gsearch-video-title").onclick = openVideo;
    const practiceBtn = row.querySelector(".gsearch-practice-btn");
    if (practiceBtn) {
      practiceBtn.onclick = function (e) {
        e.stopPropagation();
        const n = parseInt(row.getAttribute("data-n"), 10);
        const item = window.QS.find(function (x) {
          return x.n === n;
        });
        if (item) startSearchPractice([item], "🔍 練習這一題");
      };
    }
  });

  box.querySelectorAll(".gsearch-q-row").forEach(function (row) {
    row.onclick = function () {
      const n = parseInt(row.getAttribute("data-n"), 10);
      const item = window.QS.find(function (x) {
        return x.n === n;
      });
      if (item) startSearchPractice([item], "🔍 搜尋「" + q + "」");
    };
  });

  const practiceAllBtn = document.getElementById("gsearch-practice-all");
  if (practiceAllBtn) {
    practiceAllBtn.onclick = function () {
      startSearchPractice(qResults, "🔍 搜尋「" + q + "」");
    };
  }
}

function startSearchPractice(questions, title) {
  closeSearchPanel();
  const pageQuizEl = document.getElementById("page-quiz");
  const alreadyOnQuizPage =
    pageQuizEl && pageQuizEl.classList.contains("active");
  const doStart = function () {
    startReviewList(
      function () {
        return questions;
      },
      "這組搜尋結果目前沒有題目。",
      title,
      "course-select",
      null
    );
  };
  if (!alreadyOnQuizPage && typeof window.goPage === "function") {
    // goPage("quiz") 才會把外層 #page-quiz 分頁切換成顯示狀態（首頁／其他分頁
    // 用 .page/.active 這組 class 控制可見度），只改 course-select/quiz-area
    // 的 display 只有在「原本就在考題分頁」時才看得到效果，這是先前搜尋結果
    // 點了沒反應的原因。goPage 內部有一個 10ms 延遲的重置動作（會把畫面重置
    // 回科目選擇頁），這裡等它跑完再塞入搜尋到的題目，避免兩邊互相蓋掉。
    window.goPage("quiz");
    setTimeout(doStart, 50);
  } else {
    doStart();
  }
}

onAuthStateChanged(auth, (user) => {
  currentUser = user;
  dispatchAuthChange();
  if (user) pullAndMergeOnLogin(user);
});

// ---------------------------------------------------------------------------
// ⬅️ 瀏覽器「上一頁」修正：index.html 的路由只認 location.hash（首頁／考題／
// 筆記…這種最上層分頁切換），選科目→選考卷→作答這三層都沒有各自的網址
// 狀態，所以原本從作答畫面按上一頁會直接跳回進分頁前的上一個 hash（通常是
// 首頁），而不是退一層回到科目選擇。
// 修法完全不動 index.html（那個檔案由 Rex 另一個衛教工具定期整份重新產生，
// 改了也可能被蓋掉），改成在這裡用 history.pushState 補一筆「虛擬」的瀏覽
// 記錄：只要離開科目選擇畫面就補一筆（網址本身不變，所以不會觸發既有的
// hashchange 路由邏輯），使用者按一次上一頁時瀏覽器會把這筆記錄彈掉、
// 觸發 popstate，這裡攔截下來強制顯示科目選擇畫面即可。
// ---------------------------------------------------------------------------
let quizHistoryPushed = false;

function pushQuizSubStateIfNeeded() {
  if (quizHistoryPushed) return; // 同一次「進入某科目」只補一筆，不用每個子畫面都補
  quizHistoryPushed = true;
  try {
    history.pushState({ __quizSub: true }, "", location.href);
  } catch (e) {}
}

function forceBackToCourseSelect() {
  const quizAreaEl = document.getElementById("quiz-area");
  const quizResultEl = document.getElementById("quiz-result");
  if (quizAreaEl) quizAreaEl.style.display = "none";
  if (quizResultEl) quizResultEl.style.display = "none";
  stopTimer();
  leaveActiveMockExamView();
  if (inReviewMode) {
    inReviewMode = false;
    currentReviewGetter = null;
    reviewIsMockExam = false;
    hideStickyProgressBar();
  }
  if (typeof window.backToCourseSelect === "function") {
    window.backToCourseSelect();
  }
  quizHistoryPushed = false;
}

window.addEventListener("popstate", function (e) {
  // 這次除錯過程中額外發現的獨立問題（跟 freshLoad()／banner 競速是同一類
  // 但不同成因）：瀏覽器在一般（非使用者按上一頁）的頁面載入／reload 過程
  // 中，Chromium 會在 DOMContentLoaded 前後自動補發一次 state 為 null 的
  // popstate（不是本頁自己 pushState 產生的、也跟使用者是否按過上一頁無關，
  // 任何一般網頁載入都可能出現這個瀏覽器原生行為）。以前這裡只看畫面狀態
  // （onQuizPage && !alreadyOnCourseSelect）就觸發 forceBackToCourseSelect()，
  // 沒有排除這個原生虛發事件，導致：網路慢、使用者已經用原始（尚未包裝）
  // selectCourse() 選好科目、quiz-select 已經顯示的情況下，一旦模組終於載入
  // 完成、DOMContentLoaded 觸發，這個虛發的 popstate 會被誤判成「使用者按了
  // 上一頁要退出科目」，把使用者強制退回科目選擇畫面、currentCourse 也被清空
  // ——不必使用者真的按任何鍵，且會完全蓋掉上面 initQuizHooks() 最後那段
  // 自動補畫模擬考橫幅／開始按鈕的自我修復效果。
  //
  // 第一層防護：只有在「我們自己確實呼叫過 pushQuizSubStateIfNeeded() 補過
  // 一筆 { __quizSub: true } 歷史紀錄」（quizHistoryPushed 為 true）的情況
  // 下，才代表這個 popstate 有可能是使用者真的按上一頁把那筆記錄彈掉。
  //
  // 但這樣還不夠：實測發現這個原生虛發 popstate 的實際觸發時間點會有
  // jitter，不保證剛好卡在 DOMContentLoaded 那一刻，偶爾會延遲個幾百 ms 才
  // 真的送達——如果剛好跟使用者「選科目」的時間點交錯，selectCourse()
  // 這時候已經是包裝過的版本、已經呼叫過 pushQuizSubStateIfNeeded()，
  // quizHistoryPushed 已經是 true，光看這個旗標還是會誤判成「使用者按了
  // 上一頁」。第二層防護：檢查當下 history.state 是不是「已經真的不是」
  // { __quizSub:true } 了——如果使用者真的按上一頁、把我們補的那筆記錄彈
  // 掉，history.state 這時候讀到的一定是彈掉之後、變成「上一筆」的狀態
  // （不會是 { __quizSub:true }，因為那筆已經被彈掉了）；但如果是這個原生
  // 虛發事件，並沒有真的移動瀏覽器的歷史位置，history.state 讀到的仍然會
  // 是目前這一筆、也就是還是 { __quizSub:true }。用這個差異就能可靠分辨
  // 「真的彈掉了」跟「虛發、位置根本沒變」，不受它實際送達時間點的 jitter
  // 影響。
  if (!quizHistoryPushed) return;
  const stillOnQuizSubEntry = !!(history.state && history.state.__quizSub);
  if (stillOnQuizSubEntry) return;
  const pageQuizEl = document.getElementById("page-quiz");
  const onQuizPage = !!(pageQuizEl && pageQuizEl.classList.contains("active"));
  const courseSelectEl = document.getElementById("course-select");
  const alreadyOnCourseSelect = !!(
    courseSelectEl && courseSelectEl.style.display !== "none"
  );
  if (onQuizPage && !alreadyOnCourseSelect) {
    forceBackToCourseSelect();
  }
});

// requirement 五：「手機暫時把瀏覽器切到背景」——瀏覽器分頁被背景化時，
// setInterval 常會被節流甚至暫停，倒數計時可能好一陣子都不會再 tick。
// 切回前景的當下主動補檢查一次是否已經過期：真的過期就直接自動交卷
// （不必等被節流的 tick 自己追上來才觸發），否則就立刻刷新一次倒數顯示。
document.addEventListener("visibilitychange", function () {
  if (document.visibilityState !== "visible") return;
  if (!reviewIsMockExam || !currentMockAttemptId || !currentMockDeadline) return;
  if (mockExam.isExpired(currentMockDeadline, Date.now())) {
    finishMockAttempt(currentMockAttemptId, { autoSubmitted: true });
  } else {
    tickMockExamTimer();
  }
});

initQuizHooks();
ensureReviewBar();
ensureStickyProgressBar();
ensureSwipeGesture();
ensureSearchUI();
ensureQCardResponsiveStyle();
renderMockResumeCards(); // 頁面剛載入、course-select 就已經在畫面上時，補畫一次續作卡片
syncAndroidBetaCardVisibility(); // 頁面剛載入時也要套用一次，涵蓋直接停在非 course-select 畫面的情況

// 暴露給 index.html 現有（非 module）inline script 使用的介面。
window.quizSync = {
  login,
  logout,
  getUser: () => currentUser,
  exitReview,
  startMockExam,
  // 競速修正：給測試（以及任何需要確認「module 真的初始化完成」的呼叫端）
  // 一個明確、可靠的信號——不能只看 window.selectCourse 是不是 function，
  // 那個是 index.html 內嵌 script 定義的原始函式，比這個 module 早準備好；
  // hooksInstalled 是 initQuizHooks() 真正把 selectCourse／startExam／
  // beginQuiz…等全部包裝完成之後才會設成 true 的旗標，只有這個才代表
  // ensureTagPracticeBar()／ensureMockExamBanner() 這些依賴包裝層的邏輯
  // 已經真正接上。
  isMockExamReady: () => hooksInstalled,
};
