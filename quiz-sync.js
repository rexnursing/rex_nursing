// quiz-sync.js
// Rex Nursing 練習考題 —— Google 登入與跨裝置同步（Phase 2）
//
// 這支檔案獨立於 index.html 之外，用 ES module 方式載入（<script type="module" src="quiz-sync.js">），
// 不需要任何建構工具（webpack/vite等），直接透過 Firebase 官方 CDN 取得 SDK。
//
// 目前版本（第一步）：只做 Google 登入／登出與登入狀態顯示，尚未串接答題資料同步。
// 之後會在這支檔案裡擴充 saveAnswer() / loadRemoteState() 等函式，
// 屆時 index.html 內的 selectOpt()/renderQ()/startExam() 只需呼叫這裡暴露出的 window.quizSync.* 介面，
// 不需要再改動這支檔案以外的同步邏輯。

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
    // onAuthStateChanged 會自動觸發後續處理，這裡不用重複做事
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

onAuthStateChanged(auth, (user) => {
  currentUser = user;
  dispatchAuthChange();
});

// 暴露給 index.html 現有（非 module）inline script 使用的介面。
// index.html 不需要 import 這支檔案，只要讀取 window.quizSync 即可。
window.quizSync = {
  login,
  logout,
  getUser: () => currentUser,
  // db 先暴露出來，供下一階段（資料同步）擴充使用
  _db: db,
};
