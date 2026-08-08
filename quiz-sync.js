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

function loadLocal() {
  try {
    const raw = JSON.parse(localStorage.getItem(LOCAL_KEY) || "{}");
    return { answers: raw.answers || {}, flagged: raw.flagged || {} };
  } catch (e) {
    return { answers: {}, flagged: {} };
  }
}

let { answers: myAnswers, flagged: myFlagged } = loadLocal();

function saveLocal() {
  try {
    localStorage.setItem(
      LOCAL_KEY,
      JSON.stringify({ answers: myAnswers, flagged: myFlagged })
    );
  } catch (e) {
    console.error("[quiz-sync] 本機儲存失敗", e);
  }
}

async function pushToCloud() {
  if (!currentUser) return;
  try {
    await setDoc(doc(db, "users", currentUser.uid), {
      answers: myAnswers,
      flagged: myFlagged,
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    console.error("[quiz-sync] 寫入雲端失敗", err);
  }
}

async function pullAndMergeOnLogin(user) {
  const ref = doc(db, "users", user.uid);
  let cloudAnswers = {};
  let cloudFlagged = {};
  try {
    const snap = await getDoc(ref);
    if (snap.exists()) {
      const d = snap.data();
      cloudAnswers = d.answers || {};
      cloudFlagged = d.flagged || {};
    }
  } catch (err) {
    console.error("[quiz-sync] 讀取雲端資料失敗，暫時只用本機資料", err);
    return;
  }

  // 合併規則：雲端資料優先（代表其他裝置已同步過的狀態），
  // 本機這台裝置獨有、雲端還沒有的題目再補進去，不會互相覆蓋掉對方獨有的紀錄。
  let hasLocalOnly = false;
  for (const k in myAnswers) {
    if (!(k in cloudAnswers)) {
      cloudAnswers[k] = myAnswers[k];
      hasLocalOnly = true;
    }
  }
  for (const k in myFlagged) {
    if (!(k in cloudFlagged)) {
      cloudFlagged[k] = myFlagged[k];
      hasLocalOnly = true;
    }
  }

  myAnswers = cloudAnswers;
  myFlagged = cloudFlagged;
  saveLocal();

  if (hasLocalOnly) {
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

let inReviewMode = false;
let currentReviewGetter = null;
// 複習/練習結束後要回到哪裡：預設回最上層科目選擇（course-select）；
// 依標籤跨考卷練習則是從 quiz-select（已選好科目）進來，結束後應該回到
// 同一個科目的考卷列表，而不是整個退回最上層。
let reviewReturnTo = "course-select";
let reviewReturnCourse = null;
// 複習清單裡，只有「模擬國考」這個入口需要倒數計時；其他（標籤練習、
// 搜尋結果、錯題本、疑難標記）都不需要。這裡另外用一個旗標區分，
// startReviewList() 每次進來預設重置為 false，模擬國考自己的啟動函式
// 呼叫完 startReviewList() 之後才把它改回 true。
let reviewIsMockExam = false;

function startReviewList(getter, emptyMsg, title, returnTo, returnCourse) {
  const questions = getter();
  if (!questions.length) {
    alert(emptyMsg);
    return;
  }
  stopTimer(); // 複習／標籤練習不計時，不論從哪個入口進來都先停止碼表
  stopMockExamTimer(); // 換一份複習清單／重新開始模擬考，先清掉舊的倒數計時
  reviewIsMockExam = false;
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
  stopMockExamTimer();
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
    startReviewList(getWrongQuestions, "目前沒有錯題，繼續保持！", "📕 錯題本複習");
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
  { emoji: "🧠", label: "神經", value: "神經系統" },
  { emoji: "🫃", label: "消化", value: "消化系統" },
  { emoji: "🫀", label: "心臟", value: "心臟血管" },
  { emoji: "🫁", label: "呼吸", value: "呼吸系統" },
  { emoji: "🔬", label: "泌尿", value: "泌尿系統" },
  { emoji: "🧬", label: "內分泌", value: "內分泌系統" },
  { emoji: "💉", label: "腫瘤", value: "腫瘤血液" },
  { emoji: "🦴", label: "骨骼", value: "骨骼肌肉" },
  { emoji: "👁", label: "感官", value: "感官系統" },
  { emoji: "📌", label: "其他", value: "其他" },
];

const TAG_PRACTICE_COUNT = 20;

function getTagsForCourse(course) {
  if (window.SUBJ_FILTER_TAGS && window.SUBJ_FILTER_TAGS[course]) {
    return window.SUBJ_FILTER_TAGS[course];
  }
  return MEDSURG_DEFAULT_TAGS;
}

function getTagPracticeQuestions(course, tagValue) {
  if (!window.QS) return [];
  const pool = window.QS.filter(function (q) {
    return q.course === course && q.subj === tagValue;
  });
  // Fisher-Yates 洗牌，抽前 TAG_PRACTICE_COUNT 題
  const arr = pool.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr.slice(0, TAG_PRACTICE_COUNT);
}

let tagPracticeBarCourse = null;

function ensureTagPracticeBar() {
  const container = document.getElementById("quiz-select");
  if (!container) return;
  const course = window.currentCourse;
  if (course === tagPracticeBarCourse) return; // 同一科目不用重建
  const old = document.getElementById("tag-practice-bar");
  if (old) old.remove();
  tagPracticeBarCourse = course;
  if (!course) return;

  const tags = getTagsForCourse(course);
  const bar = document.createElement("div");
  bar.id = "tag-practice-bar";
  bar.style.cssText =
    "display:flex;flex-wrap:wrap;gap:8px;margin-bottom:20px;padding:14px;background:var(--teal-l);border-radius:var(--r)";

  const heading = document.createElement("div");
  heading.style.cssText =
    "width:100%;font-size:13px;font-weight:600;color:var(--teal-d);margin-bottom:2px";
  heading.textContent =
    "🔀 依標籤跨考卷練習（隨機抽 " + TAG_PRACTICE_COUNT + " 題）";
  bar.appendChild(heading);

  tags.forEach(function (t) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.style.cssText =
      "background:var(--white);border:1.5px solid var(--bd);border-radius:50px;padding:7px 14px;font-size:13px;cursor:pointer;font-family:inherit;color:var(--text)";
    btn.textContent = t.emoji + " " + t.label;
    btn.onclick = function () {
      startReviewList(
        function () {
          return getTagPracticeQuestions(course, t.value);
        },
        "這個標籤目前沒有題目。",
        "🔀 " + t.emoji + " " + t.label + " 標籤練習",
        "quiz-select",
        course
      );
    };
    bar.appendChild(btn);
  });

  // 插在「選擇考卷」標題列之後、考卷卡片列表之前（quiz-select 的第一個
  // 子節點是標題列，這裡插在它後面，不動標題列本身）。
  if (container.children.length > 1) {
    container.insertBefore(bar, container.children[1]);
  } else {
    container.appendChild(bar);
  }
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
let mockExamDeadline = null;
let mockExamIntervalId = null;

function getMockExamQuestions(course) {
  if (!window.QS) return [];
  const pool = window.QS.filter(function (q) {
    return q.course === course;
  });
  // Fisher-Yates 洗牌，抽前 MOCK_EXAM_QUESTION_COUNT 題（跟標籤練習用同一招）
  const arr = pool.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr.slice(0, MOCK_EXAM_QUESTION_COUNT);
}

function formatCountdown(totalSec) {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
}

function stopMockExamTimer() {
  if (mockExamIntervalId) {
    clearInterval(mockExamIntervalId);
    mockExamIntervalId = null;
  }
  mockExamDeadline = null;
}

function autoSubmitMockExam() {
  if (typeof window.showResult !== "function") return;
  window.showResult();
  const subEl = document.getElementById("res-sub");
  if (subEl) {
    subEl.textContent =
      "⏰ 60 分鐘時間到，已自動送出計分（未作答視為答錯）。" +
      (subEl.textContent ? " " + subEl.textContent : "");
  }
}

function tickMockExamTimer() {
  const el = document.getElementById("quiz-timer");
  const quizAreaEl = document.getElementById("quiz-area");
  if (
    !el ||
    !mockExamDeadline ||
    !quizAreaEl ||
    quizAreaEl.style.display === "none"
  ) {
    // 已經離開作答畫面（正常寫完自動看結果、或使用者手動離開），
    // 倒數計時沒有必要再繼續跑，順便清掉自己。
    stopMockExamTimer();
    return;
  }
  const remain = Math.max(
    0,
    Math.round((mockExamDeadline - Date.now()) / 1000)
  );
  el.textContent = "⏱ " + formatCountdown(remain);
  const urgent = remain <= 5 * 60;
  el.style.color = urgent ? "#993c1d" : "var(--teal-d)";
  el.style.background = urgent ? "#faece7" : "var(--teal-l)";
  if (remain <= 0) {
    stopMockExamTimer();
    autoSubmitMockExam();
  }
}

function startMockExamTimer() {
  mockExamDeadline = Date.now() + MOCK_EXAM_DURATION_SEC * 1000;
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
  const ok = confirm(
    "🎯 模擬國考模式\n\n隨機抽取 " +
      MOCK_EXAM_QUESTION_COUNT +
      " 題，限時 60 分鐘，時間到會自動送出計分（未作答視為答錯）。\n\n確定要開始嗎？"
  );
  if (!ok) return;
  startReviewList(
    function () {
      return getMockExamQuestions(course);
    },
    "目前題庫還沒有這個科目的題目，請稍後再試。",
    "🎯 模擬國考（限時 60 分鐘）",
    "quiz-select",
    course
  );
  reviewIsMockExam = true;
  startMockExamTimer();
}

function ensureMockExamBanner() {
  const container = document.getElementById("quiz-select");
  if (!container) return;
  const course = window.currentCourse;
  if (course === mockExamBannerCourse) return; // 同一科目不用重建
  const old = document.getElementById("mock-exam-banner");
  if (old) old.remove();
  mockExamBannerCourse = course;
  if (!course) return;

  const banner = document.createElement("div");
  banner.id = "mock-exam-banner";
  banner.style.cssText =
    "display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;" +
    "background:linear-gradient(135deg,#1d9e75,#085041);color:#fff;border-radius:var(--r);" +
    "padding:18px 22px;margin-bottom:16px;box-shadow:0 8px 20px rgba(8,80,65,.18)";
  banner.innerHTML =
    '<div><div style="font-size:15.5px;font-weight:700;margin-bottom:3px">🎯 模擬國考</div>' +
    '<div style="font-size:12.5px;opacity:.85">隨機抽取 ' +
    MOCK_EXAM_QUESTION_COUNT +
    ' 題．限時 60 分鐘．時間到自動送出，最貼近真實考試節奏</div></div>' +
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
  if (!el || !timerStartedAt) return;
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
    typeof window.selectCourse !== "function"
  ) {
    setTimeout(initQuizHooks, 200);
    return;
  }
  hooksInstalled = true;

  const origSelectCourse = window.selectCourse;
  window.selectCourse = function (n) {
    origSelectCourse(n);
    ensureTagPracticeBar();
    ensureMockExamBanner();
    pushQuizSubStateIfNeeded();
  };

  // backToCourseSelect()（「← 換科目」）是使用者自己主動退回科目選擇畫面，
  // 這裡把「瀏覽器上一頁」補丁用的旗標一併重置，避免下次選科目時漏補歷史紀錄。
  const origBackToCourseSelect = window.backToCourseSelect;
  window.backToCourseSelect = function () {
    origBackToCourseSelect();
    quizHistoryPushed = false;
  };

  const origSelectOpt = window.selectOpt;
  window.selectOpt = function (n) {
    const q = window.qList && window.qList[window.qIdx];
    origSelectOpt(n);
    if (q) recordAnswer(q.n, n);
    updateStickyProgressBar();
  };

  const origStartExam = window.startExam;
  window.startExam = function (examCode) {
    origStartExam(examCode);
    afterQuizListLoaded();
    startTimer();
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
  };

  const origRenderQ = window.renderQ;
  window.renderQ = function () {
    origRenderQ();
    updateFlagButton();
    enhanceQDots();
    scrollCurrentDotIntoView();
    updateStickyProgressBar();
  };

  // restartQuiz()（結果頁「再做一次」）原本會照 currentExamFilter／
  // currentSubjFilter 重新用 QS 篩一份單一考卷的 qList，這樣會把複習清單
  // 整個換掉；複習模式下改成用同一個 getter 重新篩一次（順便讓剛剛答對、
  // 已經不算錯題/標記的題目自然消失），維持在複習清單裡重來一次。
  const origRestartQuiz = window.restartQuiz;
  window.restartQuiz = function () {
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
      if (reviewIsMockExam) startMockExamTimer(); // 模擬國考「再做一次」要重新倒數 60 分鐘
      return;
    }
    origRestartQuiz();
    startTimer();
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
    if ((item.q && item.q.indexOf(query) !== -1) || (item.subj && item.subj.indexOf(query) !== -1)) {
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
    if ((q.q && q.q.indexOf(query) !== -1) || (q.subj && q.subj.indexOf(query) !== -1)) {
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
      "@keyframes gsearchPulse{0%,100%{box-shadow:0 0 0 0 rgba(29,158,117,.35)}50%{box-shadow:0 0 0 6px rgba(29,158,117,0)}}" +
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
        escapeHtml(item.subj) +
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
  stopMockExamTimer();
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

window.addEventListener("popstate", function () {
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

initQuizHooks();
ensureReviewBar();
ensureStickyProgressBar();
ensureSwipeGesture();
ensureSearchUI();

// 暴露給 index.html 現有（非 module）inline script 使用的介面。
window.quizSync = {
  login,
  logout,
  getUser: () => currentUser,
  exitReview,
};
