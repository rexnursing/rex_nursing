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

  // 合併完成後，如果使用者正停留在某份考卷畫面，重新套用一次還原邏輯
  afterQuizListLoaded(true);
}

function recordAnswer(n, idx) {
  if (n === undefined || n === null) return;
  myAnswers[n] = idx;
  saveLocal();
  if (currentUser) pushToCloud();
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
// 掛勾層：在不改動 index.html 既有函式本體的前提下，
// 把「記錄作答」「還原進度」「疑難標記」接到既有的
// selectOpt / startExam / filterSubj / beginQuiz / renderQ 上。
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
    typeof window.updateDot !== "function"
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
  };
}

function afterQuizListLoaded(silentMergeCall) {
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

// 暴露給 index.html 現有（非 module）inline script 使用的介面。
window.quizSync = {
  login,
  logout,
  getUser: () => currentUser,
};
