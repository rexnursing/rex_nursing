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

function ensureFlagButton() {
  let btn = document.getElementById("flag-btn");
  if (btn) return btn;
  const tagEl = document.getElementById("q-tag");
  if (!tagEl || !tagEl.parentElement) return null;
  btn = document.createElement("button");
  btn.id = "flag-btn";
  btn.type = "button";
  btn.style.cssText =
    "margin-left:8px;border:none;background:none;cursor:pointer;font-size:16px;vertical-align:middle;line-height:1;padding:0";
  btn.onclick = function () {
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
  btn.textContent = flagged ? "⭐" : "☆";
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

function startReviewList(getter, emptyMsg, title) {
  const questions = getter();
  if (!questions.length) {
    alert(emptyMsg);
    return;
  }
  inReviewMode = true;
  currentReviewGetter = getter;
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
  inReviewMode = false;
  currentReviewGetter = null;
  document.getElementById("quiz-result").style.display = "none";
  document.getElementById("quiz-area").style.display = "none";
  document.getElementById("quiz-select").style.display = "none";
  document.getElementById("course-select").style.display = "block";
  updateReviewBarCounts();
  hideStickyProgressBar();
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
    typeof window.backToSelect !== "function"
  ) {
    setTimeout(initQuizHooks, 200);
    return;
  }
  hooksInstalled = true;

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
      return;
    }
    origRestartQuiz();
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

onAuthStateChanged(auth, (user) => {
  currentUser = user;
  dispatchAuthChange();
  if (user) pullAndMergeOnLogin(user);
});

initQuizHooks();
ensureReviewBar();
ensureStickyProgressBar();
ensureSwipeGesture();

// 暴露給 index.html 現有（非 module）inline script 使用的介面。
window.quizSync = {
  login,
  logout,
  getUser: () => currentUser,
  exitReview,
};
