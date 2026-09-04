import { chromium } from 'playwright';
import fs from 'fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './static-server.mjs';

// ---------------------------------------------------------------------------
// Rex Nursing 網站模擬考功能 —— 瀏覽器驗收測試（正式保存版，取代先前只存在
// 於暫存區、跑完就消失的版本）。
// 涵蓋：Part C 原始 11 個情境（S1-S11，S11 內已加入 q-card 375px 檢查）、
// Android 封閉測試招募卡片顯示範圍（SBanner）、以及 2026-09 複核後的
// 6 個發布前阻擋問題修正（S12＝操作列 handlers 沿用舊考試／
// S13a+S13b＝goPage 離開模擬考狀態殘留／S15＝新考試靜默覆蓋未完成
// session／S16＝375px q-card 標題列擠壓題目文字／S17＝quiz-sync.js module
// 慢載入時，原始 selectCourse() 先跑完造成的競速，含產品端的自動補救，
// 以及除錯過程中額外挖到的第二個獨立 bug——瀏覽器原生虛發 popstate 事件
// 會把競速中剛自我修復好的畫面打掉／S18＝S17 那個 popstate 修正的迴歸
// 保護，確認正常情況下真的按瀏覽器上一頁仍然正確退回科目選擇畫面）。
//
// 執行方式（第一次或 Chromium 還沒裝過）：
//   cd tests/browser
//   npm install                    ← 只會裝 Playwright 這個 npm 套件本身，
//                                     "postinstall" 腳本會接著自動執行
//                                     "playwright install chromium" 幫忙
//                                     把瀏覽器本體一起裝好。
//   npm test
// 如果 npm install 因為某些設定（例如 --ignore-scripts）沒有自動觸發
// postinstall，導致 npm test 出現「找不到瀏覽器執行檔」之類的錯誤，補跑一次：
//   npx playwright install chromium
// 之後重跑只需要 npm test（不需要每次都重新 npm install）。
// npm test 內部會自己起一個暫時的靜態伺服器、跑完再關掉，不需要另外手動開
// 伺服器，也不依賴 python。
// ---------------------------------------------------------------------------
//
// 完整跑完（沒有任何情境提前拋出例外）時，斷言總數固定是 EXPECTED_TOTAL
// （見下面常數＋main() 收尾處的核對）。如果某次執行印出的 TOTAL 比這個數字
// 小，代表某個情境中途拋出例外、後面的斷言根本沒有執行到，不是「這次剛好
// 比較少」——程式會在結尾明確印出警告，不用自己心算比對。
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = path.resolve(__dirname, '..', '..'); // rex_nursing/
const PORT = 8934;
const BASE = 'http://127.0.0.1:' + PORT;

// 完整跑完、沒有任何情境提前拋出例外時，斷言總數應該固定是這個數字——
// 每次新增／刪除斷言時要跟著手動更新，main() 收尾處會拿實際的 total 跟這個
// 數字核對，兩者不一樣時會明確印出警告，不會讓「總數變少」這件事被默默
// 忽略掉（2026-09 曾發生：某情境中途拋出例外，後面斷言沒跑到，總數從 91
// 變成 86，如果沒有這個核對就只能自己心算比對，容易誤判成「這次剛好比較
// 少」而不是「有情境失敗」）。
// 2026-09 這次修正（S17 重寫＋新增 S18＋freshLoad 穩健化）後，用乾淨複製的
// 專案檔案連續完整重跑三次（不是只挑一次），三次都是 TOTAL=101 PASSED=101
// FAILED=0，所以改成 101（S1-S18，扣掉不存在的 S6，加上 S13a/S13b 兩個
// 拆開的子情境、SBanner，以及新增的 S17 額外兩項斷言＋整個 S18＝101）。
//
// 2026-09 網站模擬考新版合併回 origin/main（逐函式合併：保留 origin/main
// 既有的新 taxonomy 章節分類／標籤練習複選＋自選題數／背景計時修正／橫幅
// 怎麼用連結，換上這幾次完成的模擬考新架構）後，新增 S19-S22 專門驗證這
// 4 項被保留的線上既有功能沒有被合併過程弄壞，總數改成 101+17=118（S19=3
// 項、S20=6 項、S21=4 項、S22=4 項）。用合併後的實際檔案連續完整重跑，
// 確認 TOTAL=118 PASSED=118 FAILED=0。
// 2026-09-04 修正錯題本缺少分類，以及新版 goPage 包裝漏回傳 false 造成
// 導覽列「線上歷屆考題測驗」誤跳 quiz.html，新增 S23 共 9 項（含 375px
// 錯題分類面板不產生橫向捲動），總數 127。
const EXPECTED_TOTAL = 127;

let total = 0, passed = 0;
const results = [];
function record(name, ok, detail) {
  total++;
  if (ok) passed++;
  const detailStr = detail !== undefined ? String(JSON.stringify(detail)).slice(0, 400) : undefined;
  results.push({ name, ok, detail: detailStr });
  console.log((ok ? 'PASS' : 'FAIL') + ' - ' + name + (ok || detailStr === undefined ? '' : '  DETAIL: ' + detailStr));
}

let browser, page, server, context;
const pageErrors = [];


// 競速修正（複核後發現的問題）：window.selectCourse 是不是 function，不能
// 拿來當作「quiz-sync.js 這個 module（含它 import 的 quiz-mock-exam.js）
// 已經初始化完成」的信號——selectCourse 本來就是 index.html 內嵌、非
// module 的 <script> 定義的原始函式，天生就會比非同步載入的 module 早準備
// 好。只等 typeof window.selectCourse==='function' 的舊寫法，在 module
// 還沒執行完（例如網路／磁碟較慢時）的空窗期就會判定「可以開始測試了」，
// 接下來呼叫的 selectCourse() 會是「還沒被包裝」的原始版本，不會執行到
// ensureTagPracticeBar()／ensureMockExamBanner()，#mock-exam-start-btn
// 就不會出現——這正是 Rex 在 Windows 上實測到的兩次不同情境（S8、S1）
// 隨機失敗的根本原因，不是巧合，是真正的載入競速（見 scenario17 的專門
// 重現測試，以及 quiz-sync.js 的 window.quizSync.isMockExamReady()）。
// 改成等待 module 初始化流程最後才會設定好的明確信號：window.quizSync
// 存在、而且 isMockExamReady() 回傳 true（代表 initQuizHooks() 真的已經
// 把 selectCourse／startExam…等全部包裝完成）。
async function waitForMockExamModuleReady() {
  await page.waitForFunction(
    () => !!(window.quizSync && typeof window.quizSync.isMockExamReady === 'function' && window.quizSync.isMockExamReady()),
    null,
    { timeout: 15000 }
  );
}

async function freshLoad() {
  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  await waitForMockExamModuleReady();
  await page.evaluate(() => { localStorage.clear(); });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForMockExamModuleReady();

  // 這次除錯過程中發現的第四個問題（獨立於前三個，出現機率遠比它們低，
  // 大約 30-40 次才會遇到 1 次）：index.html 的 initRouting() 用單一一個
  // 布林旗標 _routingSelf 分辨「這次 hashchange 是不是自己（goPage 內部）
  // 造成的」，藉此避免自己觸發的 hashchange 又反過來呼叫一次 goPage()。
  // 這個設計在「短時間內連續發生兩次程式自己改 hash」時不可靠——用逐行
  // stack trace／hashchange／popstate 事件時間戳交叉比對後證實：
  // freshLoad() 這裡 reload 完、initRouting() 把空 hash 設成 "#home" 所
  // 觸發的 hashchange，如果因為系統負載延遲送達（實測偶爾會晚 300ms 以
  // 上），可能會跟後面 goToQuizPage() 呼叫 goPage('quiz')（"#home"→"#quiz"）
  // 自己觸發的 hashchange 前後交錯，讓 _routingSelf 這個「單一格」旗標被
  // 錯誤的那次 hashchange 消耗掉，另一次因此被誤判成「外部造成」的
  // hashchange，反過來又呼叫一次 goPage("quiz")——這次呼叫是包裝過的
  // window.goPage，但 origGoPage 本體那段無條件的 10ms 延遲重置一樣會被
  // 排入，時間點如果剛好晚於 selectCourse()，就會把使用者剛選好的科目、
  // 已經顯示的 quiz-select 畫面清空。
  //
  // 這是 index.html 自己既有的 bug（不是這次要修的模擬考功能本身的問題，
  // 也不是這個檔案不宜改動——見檔案開頭關於 index.html 由 Rex 另一個衛教
  // 工具定期整份重新產生的說明），而且只有在「短時間內連續兩次程式改
  // hash」才會出現——真實使用者是用滑鼠點導覽連結，兩次點擊之間至少是
  // 人類反應時間等級（幾百 ms 到幾秒），不會像這裡測試用程式在幾十 ms
  // 內就連續觸發兩次 hash 變化，實務上幾乎不可能踩到。這裡選擇讓測試本身
  // 更穩健（多等一段夠長的緩衝時間，確保 reload 剛觸發的 hashchange 完全
  // 處理完，再進到下一步會再次改 hash 的操作），而不是去動 initRouting()
  // 本體——已回報給 Rex，由他決定要不要另外處理這個沒有使用者影響的邊角
  // 案例。
  await page.waitForFunction(() => location.hash === '#home', null, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(500);
}

async function goToQuizPage() {
  await page.evaluate(() => { window.goPage('quiz'); });
  await page.waitForTimeout(100); // let goPage()'s own internal 10ms reset fully settle first
}

async function startMockExam(course = 'medsurg') {
  await goToQuizPage();
  await page.evaluate((c) => { window.selectCourse(c); }, course);
  await page.waitForSelector('#mock-exam-start-btn', { timeout: 10000 });
  await page.click('#mock-exam-start-btn');
  await page.waitForFunction(() => window.qList && window.qList.length === 50, null, { timeout: 10000 });
}

async function answerQuestion(idx, optionIdx = 0) {
  await page.evaluate(({ idx, optionIdx }) => {
    window.qIdx = idx;
    window.renderQ();
    window.selectOpt(optionIdx);
  }, { idx, optionIdx });
}

// ===========================================================================

async function scenario1() {
  console.log('\n### Scenario 1: immediate 50-complete prompt + real operation-bar clicks ###');
  await freshLoad();
  await startMockExam();

  // 真的用滑鼠點操作列（不是呼叫底層函式），驗證上一題/下一題按鈕本身可用。
  await page.click('#mock-opbar .mo-next');
  const idxAfterNext = await page.evaluate(() => window.qIdx);
  record('S1: clicking 下一題 on the operation bar advances qIdx', idxAfterNext === 1, idxAfterNext);
  await page.click('#mock-opbar .mo-prev');
  const idxAfterPrev = await page.evaluate(() => window.qIdx);
  record('S1: clicking 上一題 on the operation bar goes back', idxAfterPrev === 0, idxAfterPrev);

  for (let i = 0; i < 49; i++) await answerQuestion(i, 0);
  const overlayBefore = await page.evaluate(() => !!document.querySelector('.mock-confirm-overlay'));
  record('S1: no 50-complete prompt while only 49/50 answered', overlayBefore === false);

  await answerQuestion(49, 0);
  await page.waitForTimeout(80);
  const overlay = await page.evaluate(() => {
    const el = document.querySelector('.mock-confirm-overlay');
    return el ? el.innerText : null;
  });
  record('S1: confirm overlay appears immediately after the 50th answer (no timer wait)', !!overlay, overlay);
  record('S1: overlay wording matches spec exactly', !!overlay && overlay.includes('已完成全部50題') && overlay.includes('是否立即交卷並查看解析'), overlay);
  record('S1: overlay has both required buttons', !!overlay && overlay.includes('繼續檢查答案') && overlay.includes('交卷並查看解析'), overlay);

  await page.locator('.mock-confirm-overlay button', { hasText: '繼續檢查答案' }).click();
  const stillInExam = await page.evaluate(() => document.getElementById('quiz-area').style.display !== 'none');
  const overlayGone = await page.evaluate(() => !document.querySelector('.mock-confirm-overlay'));
  record('S1: choosing 繼續檢查答案 dismisses the prompt without auto-submitting', stillInExam && overlayGone);
}

// ===========================================================================
async function scenario2() {
  console.log('\n### Scenario 2 (+6): manual early submit, unanswered count, immediate review ###');
  await freshLoad();
  await startMockExam();
  for (let i = 0; i < 30; i++) await answerQuestion(i, 0);
  await page.evaluate(() => { window.qIdx = 15; window.renderQ(); });

  const opBarVisible = await page.evaluate(() => {
    const bar = document.getElementById('mock-opbar');
    return !!bar && getComputedStyle(bar).display !== 'none';
  });
  record('S2: fixed operation bar is visible during active mock exam', opBarVisible);

  const nextBtnHidden = await page.evaluate(() => {
    const fb = document.getElementById('q-feedback');
    return fb && fb.style.display === 'none';
  });
  record('S2: #q-feedback (and the old next-btn inside it) stays hidden during mock exam', nextBtnHidden);

  await page.click('#mock-opbar .mo-submit');
  await page.waitForTimeout(80);
  const overlayText = await page.evaluate(() => {
    const el = document.querySelector('.mock-confirm-overlay');
    return el ? el.innerText : null;
  });
  record('S2: submit confirm shows the exact unanswered count (20)', !!overlayText && overlayText.includes('20') && overlayText.includes('未作答'), overlayText);
  record('S2: submit confirm states unanswered will be counted wrong', !!overlayText && overlayText.includes('視為答錯'), overlayText);

  await page.locator('.mock-confirm-overlay button', { hasText: '交卷並查看解析' }).click();
  await page.waitForFunction(() => document.getElementById('quiz-result').style.display !== 'none', null, { timeout: 5000 });

  const resultState = await page.evaluate(() => ({
    quizAreaHidden: document.getElementById('quiz-area').style.display === 'none',
    okText: document.getElementById('res-ok').textContent,
    badText: document.getElementById('res-bad').textContent,
    wrongListLen: document.getElementById('wrong-list').innerHTML.length,
    opBarHidden: getComputedStyle(document.getElementById('mock-opbar')).display === 'none',
  }));
  const detail = await page.evaluate(() => JSON.parse(localStorage.getItem('rex_mock_attempts_v1'))[0]);

  record('S2/S6: submit navigates to result page immediately (no extra wait)', resultState.quizAreaHidden);
  record('S2/S6: saved detail has exactly 20 unanswered (matches what was left blank)', detail.unansweredCount === 20, detail.unansweredCount);
  record('S2/S6: saved detail correct+wrong+unanswered totals 50', (detail.correctCount + detail.wrongCount + detail.unansweredCount) === 50, detail);
  record('S2/S6: on-screen 答對 count matches saved detail', resultState.okText === detail.correctCount + '題', resultState.okText + ' vs ' + detail.correctCount);
  record('S2/S6: on-screen 待加強 count matches saved wrong+unanswered', resultState.badText === (detail.wrongCount + detail.unansweredCount) + '題', resultState.badText);
  record('S2/S6: wrong-list is populated with full review content immediately after submit', resultState.wrongListLen > 200, resultState.wrongListLen);
  record('S2: operation bar hides once on the result page', resultState.opBarHidden);
}

// ===========================================================================
async function scenario3() {
  console.log('\n### Scenario 3: reload restores exact session state ###');
  await freshLoad();
  await startMockExam();
  const answers = {};
  for (let i = 0; i < 10; i++) {
    const opt = i % 4;
    answers[i] = opt;
    await answerQuestion(i, opt);
  }
  await page.evaluate(() => { window.qIdx = 5; window.renderQ(); });

  const before = await page.evaluate(() => ({
    qids: window.qList.map(q => q.n),
    answered: Object.assign({}, window.answered),
    qIdx: window.qIdx,
    session: JSON.parse(localStorage.getItem('rex_mock_session_v1')),
  }));

  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForMockExamModuleReady();

  const cardInfo = await page.evaluate(() => {
    const cs = document.getElementById('course-select');
    const card = cs ? cs.querySelector('.mock-resume-card') : null;
    return { visible: cs && cs.style.display !== 'none', present: !!card, text: card ? card.innerText : null };
  });
  record('S3: after reload, course-select shows a resume card (session was NOT auto-resumed)', cardInfo.visible && cardInfo.present, cardInfo);
  record('S3: resume card correctly shows 10/50 completed', !!cardInfo.text && /已完成\s*10\s*\/\s*50\s*題/.test(cardInfo.text), cardInfo.text);

  await page.locator('.mock-resume-card .mock-resume-btn').click();
  await page.waitForFunction(() => document.getElementById('quiz-area').style.display !== 'none', null, { timeout: 5000 });

  const after = await page.evaluate(() => ({
    qids: window.qList.map(q => q.n),
    answered: Object.assign({}, window.answered),
    qIdx: window.qIdx,
    session: JSON.parse(localStorage.getItem('rex_mock_session_v1')),
  }));
  record('S3: identical 50 question IDs in identical order restored', JSON.stringify(before.qids) === JSON.stringify(after.qids));
  record('S3: identical 10 answers restored', JSON.stringify(before.answered) === JSON.stringify(after.answered), JSON.stringify(after.answered));
  record('S3: identical current question index restored', before.qIdx === after.qIdx, before.qIdx + ' vs ' + after.qIdx);
  record('S3: deadline is the SAME absolute timestamp, not regenerated (60 min not re-granted)', before.session.deadline === after.session.deadline, before.session.deadline + ' vs ' + after.session.deadline);

  const timerText = await page.evaluate(() => document.getElementById('quiz-timer') && document.getElementById('quiz-timer').textContent);
  record('S3: countdown display shows a valid MM:SS after resume', !!timerText && /\d{2}:\d{2}/.test(timerText), timerText);
}

// ===========================================================================
async function scenario4() {
  console.log('\n### Scenario 4: navigate to another page and back shows resume card ###');
  await freshLoad();
  await startMockExam();
  await answerQuestion(0, 0);

  await page.evaluate(() => { window.goPage('home'); });
  const barHiddenOnHome = await page.evaluate(() => {
    const bar = document.getElementById('mock-opbar');
    return !bar || getComputedStyle(bar).display === 'none';
  });
  record('S4: fixed operation bar does not bleed onto another page after navigating away', barHiddenOnHome);

  await page.evaluate(() => { window.goPage('quiz'); });
  await page.waitForTimeout(80);
  const cardInfo = await page.evaluate(() => {
    const cs = document.getElementById('course-select');
    return { visible: cs && cs.style.display !== 'none', hasCard: !!(cs && cs.querySelector('.mock-resume-card')) };
  });
  record('S4: returning to the quiz page shows course-select with a resume card', cardInfo.visible && cardInfo.hasCard, cardInfo);
}

// ===========================================================================
async function scenario5() {
  console.log('\n### Scenario 5: expired deadline auto-submits on resume, unanswered = wrong ###');
  await freshLoad();
  await startMockExam();
  for (let i = 0; i < 5; i++) await answerQuestion(i, 0);
  await page.evaluate(() => { window.qIdx = 2; window.renderQ(); });

  await page.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem('rex_mock_session_v1'));
    raw.deadline = Date.now() - 10000;
    localStorage.setItem('rex_mock_session_v1', JSON.stringify(raw));
  });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForMockExamModuleReady();

  const cardPresent = await page.evaluate(() => !!document.querySelector('#course-select .mock-resume-card'));
  record('S5: resume card is still shown even though deadline already passed (expiry is checked on resume, not hidden)', cardPresent);

  await page.locator('.mock-resume-card .mock-resume-btn').click();
  await page.waitForFunction(() => document.getElementById('quiz-result').style.display !== 'none', null, { timeout: 5000 });

  const state = await page.evaluate(() => ({
    resultVisible: document.getElementById('quiz-result').style.display !== 'none',
    subText: document.getElementById('res-sub').textContent,
    sessionCleared: localStorage.getItem('rex_mock_session_v1') === null,
  }));
  const detail = await page.evaluate(() => JSON.parse(localStorage.getItem('rex_mock_attempts_v1'))[0]);

  record('S5: expired session auto-submits straight to the result page with no extra prompt', state.resultVisible);
  record('S5: result explicitly states this was a timeout auto-submit', state.subText.includes('60 分鐘時間到') || state.subText.includes('自動送出'), state.subText);
  record('S5: session is cleared after the auto-submit', state.sessionCleared);
  record('S5: saved detail has 45 unanswered (5 answered + 45 counted wrong)', detail.unansweredCount === 45, detail.unansweredCount);
  record('S5: saved detail is flagged autoSubmitted=true', detail.autoSubmitted === true, detail.autoSubmitted);
}

// ===========================================================================
async function scenario7() {
  console.log('\n### Scenario 7: revisit a finished attempt from history after leaving the result page ###');
  await freshLoad();
  await startMockExam();
  for (let i = 0; i < 50; i++) await answerQuestion(i, i % 4);
  await page.waitForTimeout(80);
  await page.locator('.mock-confirm-overlay button', { hasText: '交卷並查看解析' }).click();
  await page.waitForFunction(() => document.getElementById('quiz-result').style.display !== 'none', null, { timeout: 5000 });

  const submittedDetail = await page.evaluate(() => JSON.parse(localStorage.getItem('rex_mock_attempts_v1'))[0]);

  await page.locator('#quiz-result button', { hasText: '換考卷' }).click();
  await page.waitForFunction(() => document.getElementById('quiz-select').style.display !== 'none', null, { timeout: 5000 });

  await page.click('#mock-history-entry-btn');
  await page.waitForSelector('#mock-history-overlay', { timeout: 5000 });
  const rowCount = await page.locator('#mock-history-overlay div[style*="cursor: pointer"]').count();
  record('S7: history modal lists this course\'s attempt', rowCount >= 1, rowCount);

  await page.locator('#mock-history-overlay div[style*="cursor: pointer"]').first().click();
  await page.waitForTimeout(80);
  const detailText = await page.evaluate(() => document.getElementById('mock-history-overlay').innerText);
  record('S7: revisited detail shows the same score as when it was submitted', detailText.includes(String(submittedDetail.score) + '%'), detailText.slice(0, 150));
  record('S7: revisited detail includes per-question review content, not just the summary', detailText.length > 400, detailText.length);
}

// ===========================================================================
async function scenario8() {
  console.log('\n### Scenario 8: duplicate submit trigger must not create a duplicate history row ###');
  await freshLoad();
  await startMockExam();
  for (let i = 0; i < 50; i++) await answerQuestion(i, i % 4);
  await page.waitForTimeout(80);
  await page.locator('.mock-confirm-overlay button', { hasText: '交卷並查看解析' }).click();
  await page.waitForFunction(() => document.getElementById('quiz-result').style.display !== 'none', null, { timeout: 5000 });

  // reviewIsMockExam / currentMockAttemptId 在結果頁仍維持同一場，直接再呼叫
  // 兩次真正曝露在 window 上的 showResult()，模擬「同一個 attemptId 的交卷
  // 路徑不知為何又被觸發」的最壞情況（見 quiz-sync.js 新增的防禦性 redirect
  // 與 finishMockAttempt 內的第二層 attemptId 已存在檢查）。
  await page.evaluate(() => { window.showResult(); });
  await page.evaluate(() => { window.showResult(); });
  await page.waitForTimeout(80);

  const attemptsList = await page.evaluate(() => JSON.parse(localStorage.getItem('rex_mock_attempts_v1')));
  record('S8: attempt-detail store still has exactly 1 entry (its own internal de-dup)', attemptsList.length === 1, attemptsList.length);

  await page.locator('#quiz-result button', { hasText: '換考卷' }).click();
  await page.waitForFunction(() => document.getElementById('quiz-select').style.display !== 'none', null, { timeout: 5000 });
  await page.click('#mock-history-entry-btn');
  await page.waitForSelector('#mock-history-overlay', { timeout: 5000 });
  const rowCount = await page.locator('#mock-history-overlay div[style*="cursor: pointer"]').count();
  record('S8: history list shows exactly 1 row, not a duplicate', rowCount === 1, rowCount);
}

// ===========================================================================
async function scenario9() {
  console.log('\n### Scenario 9: legacy (summary-only) history record displays without crashing ###');
  await freshLoad();
  await page.evaluate(() => {
    localStorage.setItem('rex_quiz_myprogress_v1', JSON.stringify({
      answers: {}, flagged: {},
      mockHistory: [{ course: 'medsurg', date: new Date().toISOString(), score: 72, correct: 36, total: 50, passed: true }],
    }));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForMockExamModuleReady();
  await goToQuizPage();
  await page.evaluate(() => { window.selectCourse('medsurg'); });

  const historyBtnVisible = await page.evaluate(() => !!document.getElementById('mock-history-entry-btn'));
  record('S9: history entry button appears for a course with a legacy-only record', historyBtnVisible);

  await page.click('#mock-history-entry-btn');
  await page.waitForSelector('#mock-history-overlay', { timeout: 5000 });
  await page.locator('#mock-history-overlay div[style*="cursor: pointer"]').first().click();
  await page.waitForTimeout(80);
  const detailText = await page.evaluate(() => document.getElementById('mock-history-overlay').innerText);
  record('S9: legacy record shows the required exact fallback text, no crash', detailText.includes('此為舊版成績紀錄，當時尚未保存逐題作答明細。'), detailText);
}

// ===========================================================================
async function scenario10() {
  console.log('\n### Scenario 10: normal practice mode keeps immediate per-question feedback ###');
  await freshLoad();
  await goToQuizPage();
  await page.evaluate(() => { window.selectCourse('medsurg'); });
  await page.evaluate(() => { window.startExam('115-1'); });
  await page.waitForFunction(() => window.qList && window.qList.length > 0, null, { timeout: 10000 });

  const badgesVisibleBefore = await page.evaluate(() => {
    const ok = document.getElementById('cnt-ok');
    return !!(ok && ok.parentElement && getComputedStyle(ok.parentElement).display !== 'none');
  });
  record('S10: score badges (✓/✗) are visible in normal practice mode', badgesVisibleBefore);

  await page.locator('#q-opts .opt-btn').first().click();
  await page.waitForTimeout(80);
  const feedbackVisible = await page.evaluate(() => {
    const fb = document.getElementById('q-feedback');
    return !!fb && fb.style.display !== 'none';
  });
  record('S10: #q-feedback becomes visible immediately after answering (unaffected by mock-exam hiding logic)', feedbackVisible);

  const nextBtnReachable = await page.evaluate(() => {
    const btn = document.getElementById('next-btn');
    return !!btn && getComputedStyle(btn).display !== 'none';
  });
  record('S10: next-btn (下一題/查看成績) is reachable in normal mode', nextBtnReachable);

  const badgeUpdated = await page.evaluate(() => {
    const ok = parseInt(document.getElementById('cnt-ok').textContent, 10);
    const bad = parseInt(document.getElementById('cnt-bad').textContent, 10);
    return ok + bad === 1;
  });
  record('S10: score badge increments immediately on answer in normal mode', badgeUpdated);
}

// ===========================================================================
async function scenario11() {
  console.log('\n### Scenario 11: 375px mobile width layout check ###');
  await freshLoad();
  await page.setViewportSize({ width: 375, height: 812 });
  await startMockExam();
  for (let i = 0; i < 49; i++) await answerQuestion(i, 0);

  const opBarCheck = await page.evaluate(() => {
    const bar = document.getElementById('mock-opbar');
    const btns = Array.from(bar.querySelectorAll('button'));
    const vw = window.innerWidth;
    const rects = btns.map(b => { const r = b.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; });
    const withinViewport = rects.every(r => r.left >= -1 && r.right <= vw + 1);
    let noOverlap = true;
    for (let i = 0; i < rects.length - 1; i++) if (rects[i].right > rects[i + 1].left + 1) noOverlap = false;
    return { withinViewport, noOverlap, rects, vw, hasHScroll: document.documentElement.scrollWidth > window.innerWidth + 1 };
  });
  record('S11: operation bar buttons all fit within 375px width', opBarCheck.withinViewport, opBarCheck.rects);
  record('S11: operation bar buttons do not overlap', opBarCheck.noOverlap, opBarCheck.rects);
  record('S11: no horizontal page scroll from the operation bar', !opBarCheck.hasHScroll);
  await page.screenshot({ path: path.join(__dirname, 'screenshots', 'screenshot-375-opbar.png') });

  // 發布前阻擋問題五：q-card 標題列（q-tag + flag-btn + q-text）在 375px 下
  // 不能把 q-text 擠成沒辦法讀的細長欄位（見 quiz-sync.js 的
  // ensureQCardResponsiveStyle()）。模擬考跟一般歷屆試題共用同一份 q-card
  // 標記，這裡先驗證模擬考模式；一般模式另外在 scenario16 驗證。
  const qCardCheck = await page.evaluate(() => {
    const header = document.getElementById('q-card').firstElementChild;
    const tagR = document.getElementById('q-tag').getBoundingClientRect();
    const textR = document.getElementById('q-text').getBoundingClientRect();
    const flagR = document.getElementById('flag-btn') ? document.getElementById('flag-btn').getBoundingClientRect() : null;
    const headerR = header.getBoundingClientRect();
    return {
      flexWrap: getComputedStyle(header).flexWrap,
      qTextWidth: textR.width,
      headerWidth: headerR.width,
      qTextOnOwnLine: textR.top > tagR.bottom - 1,
      qTagFlagSameLine: !!flagR && Math.abs(tagR.top - flagR.top) < 6,
    };
  });
  record('S11: q-card header row wraps at 375px (flex-wrap:wrap active)', qCardCheck.flexWrap === 'wrap', qCardCheck);
  record('S11: q-text drops to its own full-width line, not squeezed beside q-tag', qCardCheck.qTextOnOwnLine && qCardCheck.qTextWidth > qCardCheck.headerWidth * 0.85, qCardCheck);
  record('S11: q-tag and flag-btn still share the first line', qCardCheck.qTagFlagSameLine, qCardCheck);

  await answerQuestion(49, 0);
  await page.waitForTimeout(80);
  const overlayCheck = await page.evaluate(() => {
    const card = document.querySelector('.mock-confirm-overlay > div');
    if (!card) return null;
    const r = card.getBoundingClientRect();
    return { withinViewport: r.left >= -1 && r.right <= window.innerWidth + 1, rect: { left: r.left, right: r.right, width: r.width } };
  });
  record('S11: 50-complete confirm card fits within 375px, not clipped', !!overlayCheck && overlayCheck.withinViewport, overlayCheck);
  await page.screenshot({ path: path.join(__dirname, 'screenshots', 'screenshot-375-confirm.png') });

  await page.locator('.mock-confirm-overlay button', { hasText: '交卷並查看解析' }).click();
  await page.waitForFunction(() => document.getElementById('quiz-result').style.display !== 'none', null, { timeout: 5000 });

  const resultCheck = await page.evaluate(() => {
    const hasHScroll = document.documentElement.scrollWidth > window.innerWidth + 1;
    const rects = Array.from(document.querySelectorAll('#quiz-result button')).map(b => { const r = b.getBoundingClientRect(); return { left: r.left, right: r.right }; });
    const withinViewport = rects.every(r => r.left >= -1 && r.right <= window.innerWidth + 1);
    return { hasHScroll, withinViewport, rects };
  });
  record('S11: result page has no horizontal overflow at 375px', !resultCheck.hasHScroll, resultCheck);
  record('S11: result page action buttons fit within 375px width', resultCheck.withinViewport, resultCheck.rects);
  await page.screenshot({ path: path.join(__dirname, 'screenshots', 'screenshot-375-result.png') });

  await page.setViewportSize({ width: 1280, height: 900 });
}


// ===========================================================================
async function scenarioBanner() {
  console.log('\n### Scenario Banner (Android 封閉測試招募卡片顯示範圍): 只在 course-select 顯示 ###');
  // 這張卡片本體是「另一個工具」注入到 live index.html 的一段獨立 <script>，
  // 本地 index.html 完全沒有這段標記，所以這裡用 page.evaluate() 自己模擬
  // 同樣的注入方式（建一個 #android-beta-card div，插在 #page-quiz 底下、
  // #course-select 前面），藉此單純驗證 quiz-sync.js 的
  // syncAndroidBetaCardVisibility() 邏輯本身是否正確。
  await freshLoad();
  await goToQuizPage();

  await page.evaluate(() => {
    if (document.getElementById('android-beta-card')) return;
    const pageQuiz = document.getElementById('page-quiz');
    const courseSelect = document.getElementById('course-select');
    const div = document.createElement('div');
    div.id = 'android-beta-card';
    div.innerHTML = '<h3>Android App 封閉測試招募｜限量 10 名</h3>';
    pageQuiz.insertBefore(div, courseSelect);
  });

  async function viewState() {
    return page.evaluate(() => {
      function d(id) { const el = document.getElementById(id); return el ? getComputedStyle(el).display : null; }
      return { courseSelect: d('course-select'), quizSelect: d('quiz-select'), quizArea: d('quiz-area'), quizResult: d('quiz-result'), betaCard: d('android-beta-card') };
    });
  }

  await page.evaluate(() => window.backToCourseSelect());
  await page.waitForTimeout(100);
  let s = await viewState();
  record('SBanner: 初始 course-select 顯示卡片', s.betaCard !== 'none' && s.courseSelect !== 'none', s);

  await page.evaluate(() => window.selectCourse('medsurg'));
  await page.waitForTimeout(100);
  s = await viewState();
  record('SBanner: selectCourse() 進入 quiz-select 卡片隱藏', s.betaCard === 'none' && s.quizSelect !== 'none', s);

  await page.evaluate(() => window.startExam('115-1'));
  await page.waitForTimeout(150);
  s = await viewState();
  record('SBanner: startExam() 進入 quiz-area（作答中）卡片隱藏', s.betaCard === 'none' && s.quizArea !== 'none', s);

  await page.evaluate(() => window.nextQ && window.nextQ());
  await page.waitForTimeout(100);
  s = await viewState();
  record('SBanner: 換下一題後卡片仍隱藏', s.betaCard === 'none', s);

  await page.evaluate(() => window.showResult());
  await page.waitForTimeout(150);
  s = await viewState();
  record('SBanner: showResult() 進入 quiz-result 卡片隱藏', s.betaCard === 'none' && s.quizResult !== 'none', s);

  await page.evaluate(() => window.backToSelect());
  await page.waitForTimeout(100);
  s = await viewState();
  record('SBanner: backToSelect()「換考卷」回到 quiz-select 卡片仍隱藏', s.betaCard === 'none' && s.quizSelect !== 'none', s);

  await page.evaluate(() => window.backToCourseSelect());
  await page.waitForTimeout(100);
  s = await viewState();
  record('SBanner: backToCourseSelect()「← 換科目」回到 course-select 卡片恢復顯示', s.betaCard !== 'none' && s.courseSelect !== 'none', s);

  await page.evaluate(() => window.selectCourse('medsurg'));
  await page.waitForTimeout(100);
  await page.evaluate(() => window.goPage('quiz'));
  await page.waitForTimeout(200);
  s = await viewState();
  record('SBanner: goPage(\'quiz\') 重置回到 course-select 卡片顯示', s.betaCard !== 'none' && s.courseSelect !== 'none', s);
}

// ===========================================================================
async function scenario12() {
  console.log('\n### Scenario 12 (發布前阻擋問題一): operation bar handlers must not go stale across 2 mock exams ###');
  await freshLoad();
  await startMockExam('medsurg');
  for (let i = 0; i < 50; i++) await answerQuestion(i, 0);
  await page.waitForTimeout(100);
  await page.locator('.mock-confirm-overlay button', { hasText: '交卷並查看解析' }).click();
  await page.waitForFunction(() => document.getElementById('quiz-result').style.display !== 'none', null, { timeout: 5000 });
  const attemptsAfterA = await page.evaluate(() => JSON.parse(localStorage.getItem('rex_mock_attempts_v1') || '[]'));
  record('S12: exam A saved exactly 1 attempt detail', attemptsAfterA.length === 1, attemptsAfterA.length);

  await page.evaluate(() => window.backToCourseSelect());
  await page.waitForTimeout(100);
  // 開第二場（同一科目，刻意重用同一個 DOM 操作列，這正是 bug 的重現條件）
  await startMockExam('medsurg');
  // 故意只答一部分（不要觸發自動的「50題完成」提示），改用操作列自己的
  // 交卷按鈕——這正是 bug 實際發生的路徑（原本會沿用第一場的 onSubmit）。
  for (let i = 0; i < 5; i++) await answerQuestion(i, 1);
  await page.waitForTimeout(80);
  const submitBtnExists = await page.evaluate(() => !!document.querySelector('#mock-opbar .mo-submit'));
  record('S12: operation bar submit button exists for exam B', submitBtnExists);
  await page.click('#mock-opbar .mo-submit');
  await page.waitForTimeout(80);
  const confirmShown = await page.evaluate(() => !!document.querySelector('.mock-confirm-overlay'));
  record('S12: clicking opbar submit for exam B shows the submit-confirm dialog', confirmShown);
  await page.locator('.mock-confirm-overlay button', { hasText: '交卷並查看解析' }).click();
  await page.waitForFunction(() => document.getElementById('quiz-result').style.display !== 'none', null, { timeout: 5000 }).catch(() => {});
  const quizResultVisibleForB = await page.evaluate(() => document.getElementById('quiz-result').style.display !== 'none');
  record('S12: exam B actually submits (quiz-result shown) — would silently no-op under the stale-handler bug', quizResultVisibleForB);

  const attemptsAfterB = await page.evaluate(() => JSON.parse(localStorage.getItem('rex_mock_attempts_v1') || '[]'));
  record('S12: exactly 2 distinct attempt details saved after B (not stuck at 1)', attemptsAfterB.length === 2, attemptsAfterB.map(a => a.attemptId));
  const bDetail = attemptsAfterB.find(a => a.attemptId !== attemptsAfterA[0].attemptId);
  record('S12: the 2nd attempt reflects exam B\'s own answers (5 answered), not exam A\'s', !!bDetail && (bDetail.correctCount + bDetail.wrongCount) === 5, bDetail);
}

// ===========================================================================
async function scenario13() {
  console.log('\n### Scenario 13a (發布前阻擋問題二): nav away mid-mock-exam then resume must restore exact state ###');
  await freshLoad();
  await startMockExam('medsurg');
  for (let i = 0; i < 10; i++) await answerQuestion(i, i % 4);
  await page.evaluate(() => { window.qIdx = 10; window.renderQ(); });
  await page.waitForTimeout(50);
  const before = await page.evaluate(() => ({
    qList: window.qList.map(q => q.n),
    answered: window.answered,
    qIdx: window.qIdx,
    session: JSON.parse(localStorage.getItem('rex_mock_session_v1') || 'null'),
  }));
  record('S13a: session exists with 10 answers before navigating away', !!before.session && Object.keys(before.session.answers).length === 10, before.session);

  await page.evaluate(() => window.goPage('home'));
  await page.waitForTimeout(80);
  const opBarHiddenAfterNav = await page.evaluate(() => {
    const bar = document.getElementById('mock-opbar');
    return !bar || bar.style.display === 'none';
  });
  record('S13a: operation bar hidden after navigating to home', opBarHiddenAfterNav);
  const sessionPreservedAfterHome = await page.evaluate(() => !!localStorage.getItem('rex_mock_session_v1'));
  record('S13a: unfinished session NOT deleted after navigating to home', sessionPreservedAfterHome);

  await page.evaluate(() => window.goPage('quiz'));
  await page.waitForTimeout(150);

  const resumeCardVisible = await page.evaluate(() => {
    const cs = document.getElementById('course-select');
    return cs.style.display !== 'none' && !!cs.querySelector('.mock-resume-card');
  });
  record('S13a: returning to quiz page shows course-select WITH a resume card', resumeCardVisible);

  await page.evaluate(() => {
    const btn = document.querySelector('#course-select .mock-resume-card .mock-resume-btn');
    if (btn) btn.click();
  });
  await page.waitForTimeout(100);
  const after = await page.evaluate(() => ({
    qList: window.qList ? window.qList.map(q => q.n) : null,
    answered: window.answered,
    qIdx: window.qIdx,
    deadline: (JSON.parse(localStorage.getItem('rex_mock_session_v1') || 'null') || {}).deadline,
  }));
  record('S13a: resumed session has identical question list/order', JSON.stringify(after.qList) === JSON.stringify(before.qList));
  record('S13a: resumed session has identical answers', JSON.stringify(after.answered) === JSON.stringify(before.answered));
  record('S13a: resumed session has identical current question index', after.qIdx === before.qIdx);
  record('S13a: resumed session has identical deadline (60 min not re-granted)', after.deadline === before.session.deadline, { after: after.deadline, before: before.session.deadline });
}

async function scenario14() {
  console.log('\n### Scenario 13b (發布前阻擋問題二): nav away then entering NORMAL exam must not apply mock styling and must preserve the mock session ###');
  await freshLoad();
  await startMockExam('medsurg');
  for (let i = 0; i < 6; i++) await answerQuestion(i, 0);
  await page.waitForTimeout(50);

  await page.evaluate(() => window.goPage('home'));
  await page.waitForTimeout(80);
  await page.evaluate(() => window.goPage('quiz'));
  await page.waitForTimeout(150);

  // 這次不點續作卡片，改成直接選科目、進入一般歷屆試題
  await page.evaluate(() => window.selectCourse('medsurg'));
  await page.waitForTimeout(100);
  await page.evaluate(() => window.startExam('115-1'));
  await page.waitForTimeout(150);

  const opBarVisibleInNormalExam = await page.evaluate(() => {
    const bar = document.getElementById('mock-opbar');
    return !!bar && bar.style.display !== 'none';
  });
  record('S13b: entering normal exam after nav-away does NOT show the mock operation bar', !opBarVisibleInNormalExam);

  await page.evaluate(() => { window.qIdx = 0; window.renderQ(); window.selectOpt(0); });
  await page.waitForTimeout(80);
  const feedbackVisible = await page.evaluate(() => {
    const fb = document.getElementById('q-feedback');
    return fb && fb.style.display !== 'none';
  });
  record('S13b: normal exam shows immediate per-question feedback (#q-feedback), not mock-exam hiding behavior', feedbackVisible);

  const sessionStillPreserved = await page.evaluate(() => {
    const raw = localStorage.getItem('rex_mock_session_v1');
    if (!raw) return null;
    const s = JSON.parse(raw);
    return Object.keys(s.answers || {}).length;
  });
  record('S13b: unfinished mock session (6 answers) still preserved untouched after entering normal exam instead', sessionStillPreserved === 6, sessionStillPreserved);
}

// ===========================================================================
async function scenario15() {
  console.log('\n### Scenario 15 (發布前阻擋問題三): starting a new exam must not silently overwrite an existing unfinished session ###');
  await freshLoad();
  await startMockExam('medsurg');
  for (let i = 0; i < 10; i++) await answerQuestion(i, 0);
  await page.waitForTimeout(50);
  const sessionA = await page.evaluate(() => JSON.parse(localStorage.getItem('rex_mock_session_v1')));
  record('S15: course A session saved with 10 answers before leaving', !!sessionA && Object.keys(sessionA.answers).length === 10);

  await page.evaluate(() => window.goPage('quiz'));
  await page.waitForTimeout(150);

  await page.evaluate(() => window.selectCourse('psych'));
  await page.waitForTimeout(100);
  await page.waitForSelector('#mock-exam-start-btn', { timeout: 10000 });
  await page.click('#mock-exam-start-btn');
  await page.waitForTimeout(100);

  const promptVisible = await page.evaluate(() => !!document.querySelector('.mock-confirm-overlay'));
  record('S15: detecting an existing unfinished session shows the 3-way choice prompt (not a silent overwrite)', promptVisible);
  // 比對「有意義」的欄位（attemptId／questionIds／answers／currentIndex／
  // deadline），不比對 updatedAt——中間經過 goPage('quiz') 時，因為使用者當下
  // 真的還在作答中（quiz-area 可見），會正常觸發一次
  // persistCurrentMockSession() 把 updatedAt 刷新成最新時間，這是預期行為、
  // 不是「session 被改變」，兩者不能混為一談，只看真正代表作答內容的欄位。
  function meaningfulSessionFields(s) {
    if (!s) return s;
    return { attemptId: s.attemptId, course: s.course, questionIds: s.questionIds, answers: s.answers, currentIndex: s.currentIndex, deadline: s.deadline };
  }
  const sessionUnchangedWhilePromptOpen = await page.evaluate(() => JSON.parse(localStorage.getItem('rex_mock_session_v1')));
  record('S15: A session\'s answer content completely unchanged while the prompt is still open', JSON.stringify(meaningfulSessionFields(sessionUnchangedWhilePromptOpen)) === JSON.stringify(meaningfulSessionFields(sessionA)));

  // 先測「取消」：A session 不變，也沒有進入 B 的作答畫面
  await page.locator('.mock-confirm-overlay button', { hasText: '取消' }).click();
  await page.waitForTimeout(80);
  const sessionAfterCancel = await page.evaluate(() => JSON.parse(localStorage.getItem('rex_mock_session_v1')));
  record('S15: choosing 取消 leaves A session\'s answer content untouched', JSON.stringify(meaningfulSessionFields(sessionAfterCancel)) === JSON.stringify(meaningfulSessionFields(sessionA)));
  const notInBExamAfterCancel = await page.evaluate(() => document.getElementById('quiz-area').style.display === 'none');
  record('S15: choosing 取消 does not start B\'s exam', notInBExamAfterCancel);

  // 再測「繼續」：應該精準還原 A（同一份 10 題已答、同一個科目），不是開了 B
  await page.click('#mock-exam-start-btn');
  await page.waitForTimeout(100);
  await page.locator('.mock-confirm-overlay button', { hasText: '繼續上次模擬考' }).click();
  await page.waitForTimeout(100);
  const afterContinue = await page.evaluate(() => ({
    answered: window.answered,
    qList: window.qList ? window.qList.map(q => q.n) : null,
  }));
  record('S15: choosing 繼續上次模擬考 restores exactly course A\'s answers/questions (not B)', JSON.stringify(afterContinue.answered) === JSON.stringify(sessionA.answers) && JSON.stringify(afterContinue.qList) === JSON.stringify(sessionA.questionIds));

  // 離開（不交卷），回到 B 科再次觸發，這次選「放棄」：A 被清掉，B 的新 attempt 才建立
  await page.evaluate(() => window.goPage('quiz'));
  await page.waitForTimeout(150);
  await page.evaluate(() => window.selectCourse('psych'));
  await page.waitForTimeout(100);
  await page.click('#mock-exam-start-btn');
  await page.waitForTimeout(100);
  await page.locator('.mock-confirm-overlay button', { hasText: '放棄上次進度並開始新考試' }).click();
  await page.waitForTimeout(80);
  // 放棄後緊接著會跳出原本「🎯 模擬國考模式...確定要開始嗎？」的原生 confirm()，
  // 測試用的 page.on('dialog', d => d.accept()) 會自動按下確定。
  await page.waitForFunction(() => window.qList && window.qList.length === 50, null, { timeout: 10000 });
  const sessionAfterDiscard = await page.evaluate(() => JSON.parse(localStorage.getItem('rex_mock_session_v1')));
  record('S15: after explicit 放棄, B\'s new session is created with a different attemptId than A', !!sessionAfterDiscard && sessionAfterDiscard.attemptId !== sessionA.attemptId, { a: sessionA.attemptId, b: sessionAfterDiscard && sessionAfterDiscard.attemptId });
  record('S15: after explicit 放棄, new session course is B (psych), fresh with 0 answers', sessionAfterDiscard && sessionAfterDiscard.course === 'psych' && Object.keys(sessionAfterDiscard.answers).length === 0, sessionAfterDiscard);
}

// ===========================================================================
async function scenario16() {
  console.log('\n### Scenario 16 (發布前阻擋問題五): 375px q-card 標題列不能擠壓題目文字（一般歷屆試題模式 + 桌面寬度不受影響） ###');
  await freshLoad();
  await page.setViewportSize({ width: 375, height: 812 });
  await goToQuizPage();
  await page.evaluate(() => { window.selectCourse('medsurg'); });
  await page.evaluate(() => { window.startExam('115-1'); });
  await page.waitForFunction(() => window.qList && window.qList.length > 0, null, { timeout: 10000 });
  await page.waitForTimeout(120);

  async function readQCardState() {
    return page.evaluate(() => {
      const header = document.getElementById('q-card').firstElementChild;
      const tagR = document.getElementById('q-tag').getBoundingClientRect();
      const textR = document.getElementById('q-text').getBoundingClientRect();
      const headerR = header.getBoundingClientRect();
      return {
        flexWrap: getComputedStyle(header).flexWrap,
        qTextWidth: textR.width,
        headerWidth: headerR.width,
        qTextOnOwnLine: textR.top > tagR.bottom - 1,
        hasHScroll: document.documentElement.scrollWidth > window.innerWidth + 1,
      };
    });
  }

  const mobile = await readQCardState();
  record('S16: normal practice q-card header wraps at 375px', mobile.flexWrap === 'wrap', mobile);
  record('S16: normal practice q-text gets nearly the full card width, not squeezed to a sliver', mobile.qTextWidth > mobile.headerWidth * 0.85, mobile);
  record('S16: normal practice q-text is on its own line below the tag row', mobile.qTextOnOwnLine, mobile);
  record('S16: no horizontal page scroll introduced by the wrap fix', !mobile.hasHScroll);
  await page.screenshot({ path: path.join(__dirname, 'screenshots', 'screenshot-375-qcard-normal.png') });

  // 桌面寬度不能受影響：換寬到 1280px，標題列應該維持原本不換行——
  // media query（max-width:480px）條件不成立時完全不套用新規則，實測跟
  // 修正前逐像素相同（見交付報告）。
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(80);
  const desktop = await readQCardState();
  record('S16: at 1280px desktop width, header row stays nowrap (fix does not affect desktop layout)', desktop.flexWrap === 'nowrap', desktop);
}

// ===========================================================================
async function scenario17() {
  console.log('\n### Scenario 17（複核後發現的問題）: quiz-sync.js module 慢載入時的競速——原始 selectCourse() 先跑完，module 晚初始化必須自動補救 ###');
  // 這個情境需要完全獨立的瀏覽器（不是共用 browser 底下再開一個 context）。
  // 實測發現：就算只是換一個全新的 context，quiz-mock-exam.js 這個檔案只要
  // 之前任何一個情境（S1-S16 全部都會呼叫 freshLoad()）已經在同一個瀏覽器
  // process 裡載入過一次，同 process 底下其他 context 的請求還是可能吃到
  // 某一層快取，導致 route() 刻意加的延遲形同虛設（曾經把延遲從 800ms 加到
  // 3000ms 還是立刻讀到「module 已經初始化完成」，可見不是時間不夠長，是
  // 延遲根本沒生效）。改成整個 chromium.launch() 開一個全新、完全獨立的
  // 瀏覽器，保證這是這個瀏覽器 process 有史以來第一次要求這個檔案，
  // 才能確定一定是真正的網路請求，延遲才會真的生效。
  const raceBrowser = await chromium.launch();
  try {
    const raceContext = await raceBrowser.newContext({ viewport: { width: 1280, height: 900 } });
    // 刻意把 quiz-sync.js import 的 quiz-mock-exam.js 延遲 3 秒才回應，
    // 穩定地製造出「module 還沒初始化完成」的空窗期，藉此可靠重現 Rex 在
    // Windows 上實測到的真實競速（S8／S1 隨機失敗），而不是碰運氣等自然
    // 發生的時序。註冊在 context 上（不是 page 上），確保在第一次導覽送出
    // 請求之前就已經生效。
    await raceContext.route('**/quiz-mock-exam.js', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      await route.continue();
    });
    const racePage = await raceContext.newPage();
    racePage.on('dialog', (d) => d.accept());

    // waitUntil 用 'commit'，不能用 'domcontentloaded'——實測證實
    // 'domcontentloaded' 本來就會等 quiz-sync.js 這個 module（含它 import 的
    // quiz-mock-exam.js）執行完成才觸發，就算用 route() 刻意延遲，也只會讓
    // page.goto() 等更久，永遠不會在「module 還沒完成」的狀態下把控制權交還
    // 回來，沒辦法用它來重現這裡要測的競速。'commit' 則是瀏覽器一開始收到
    // 回應、還沒開始跑任何 script 就會 resolve，之後才是重現空窗期的正確
    // 起點。
    //
    // 開頁網址「不」帶 "#quiz" hash，改用手動呼叫 window.goPage('quiz')
    // 進站、再主動清掉 hash。這裡是這次除錯過程中一個重要的教訓，記錄下來
    // 避免以後重踩：一開始試過直接用 "#quiz" hash 開頁，讓 index.html 自己
    // 的 initRouting() 在 DOMContentLoaded 當下處理路由，結果測試不穩定，
    // 用逐行 stack trace 追蹤後，意外挖到兩個各自獨立、真實存在的產品 bug
    // （不是測試寫法的問題）：
    //   (1) Chromium 在一般頁面載入時，DOMContentLoaded 前後會自動補發一次
    //       state 為 null 的原生虛發 popstate，quiz-sync.js 舊版的 popstate
    //       監聽器沒有分辨這跟使用者真的按上一頁的差別——已修好，見
    //       quiz-sync.js 的 quizHistoryPushed 檢查。
    //   (2) origGoPage()（index.html 內嵌、非包裝版本）本身在被呼叫時，會
    //       無條件排一個 10ms 後的畫面重置（回科目選擇、currentCourse 清
    //       空）。如果「使用者自己先手動呼叫過 goPage('quiz')」（例如在頁面
    //       還沒載入完成時就點了「刷題」導覽連結——這條連結的 onclick 就是
    //       直接呼叫 goPage("quiz")），這時 location.hash 會被設成
    //       "#quiz"；之後 module 終於載入完成、DOMContentLoaded 觸發，
    //       initRouting() 會在它自己的 bootstrap 檢查裡看到 hash 仍然是
    //       "quiz"，「又」呼叫一次 goPage("quiz")，等於同一次「進入考題頁」
    //       被重置了兩次——第二次的重置會發生在使用者已經選好科目之後，
    //       一樣會把選好的科目、剛自我修復好的畫面清空。這一個是額外發現、
    //       獨立於這個情境本來要測的 module 載入競速之外的第三個問題，
    //       目前「還沒」在產品端修正（origGoPage 在 index.html 裡，這個檔案
    //       由 Rex 另一個衛教工具定期整份重新產生、不宜改動；而在
    //       quiz-sync.js 這層攔截的做法，可能會影響「搜尋結果導回考題頁」
    //       這個既有功能的既定行為，需要更仔細評估才能安全動手，先如實回報
    //       給 Rex 讓他決定要不要、以及什麼時候處理）。這個情境的目的單純是
    //       重現、驗證 Rex 原始回報的「module 慢載入競速」，所以下面主動把
    //       hash 清空，避免跟上述第 (2) 個問題的重置時機混在一起、干擾這個
    //       情境本來要驗證的東西；第 (2) 個問題本身「沒有」自己的專屬回歸
    //       測試，因為還沒有修正可驗證。
    await racePage.goto(BASE + '/index.html', { waitUntil: 'commit' });
    await racePage.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
    await racePage.waitForFunction(() => typeof window.selectCourse === 'function', null, { timeout: 15000 });
    await racePage.evaluate(() => { window.goPage('quiz'); });
    await racePage.evaluate(() => { history.replaceState(null, '', location.pathname + location.search); });
    await racePage.waitForTimeout(100); // 讓 goPage() 內部自己的 10ms 重置先穩定下來

    // 故意不等模組真正就緒——這裡就是要重現「module 還沒準備好」的當下，
    // 直接呼叫這時候還是原始版本的 selectCourse()。
    await racePage.waitForFunction(() => {
      const cs = document.getElementById('course-select');
      return cs && cs.style.display === 'block' && window.currentCourse === null;
    }, null, { timeout: 5000 });

    const notReadyYet = await racePage.evaluate(() => !(window.quizSync && window.quizSync.isMockExamReady && window.quizSync.isMockExamReady()));
    record('S17: precondition — module hooks are genuinely NOT installed yet when raw selectCourse is about to be called (race window really open, not a strawman)', notReadyYet);

    await racePage.evaluate(() => { window.selectCourse('medsurg'); });
    await racePage.waitForTimeout(300);

    const raced = await racePage.evaluate(() => ({
      quizSelectVisible: document.getElementById('quiz-select').style.display !== 'none',
      hasBanner: !!document.getElementById('mock-exam-banner'),
      hasStartBtn: !!document.getElementById('mock-exam-start-btn'),
    }));
    record('S17: right after the raced raw selectCourse, quiz-select is showing but the mock-exam banner/start button are indeed missing', raced.quizSelectVisible && !raced.hasBanner && !raced.hasStartBtn, raced);

    // 不導覽、不重新選科目——只等 module 真正初始化完成，驗證產品程式本身
    // 會不會自動補救（不是靠測試巧合等到才過）。
    await racePage.waitForFunction(
      () => !!(window.quizSync && typeof window.quizSync.isMockExamReady === 'function' && window.quizSync.isMockExamReady()),
      null,
      { timeout: 15000 }
    );
    await racePage.waitForTimeout(80);

    const healed = await racePage.evaluate(() => ({
      hasBanner: !!document.getElementById('mock-exam-banner'),
      hasStartBtn: !!document.getElementById('mock-exam-start-btn'),
      hasTagBar: !!document.getElementById('tag-practice-bar'),
    }));
    record('S17: once module init finishes, the mock-exam banner self-heals without navigating away and back', healed.hasBanner, healed);
    record('S17: once module init finishes, the 開始模擬考 start button self-heals', healed.hasStartBtn, healed);
    record('S17: once module init finishes, the tag-practice bar also self-heals', healed.hasTagBar, healed);

    // ---------------------------------------------------------------------
    // 這次除錯過程中額外發現、且獨立於上面競速之外的第二個真實 bug：
    // module 終於載入完成、DOMContentLoaded 觸發前後，Chromium 會自動補發
    // 一次 state 為 null 的「原生虛發 popstate」事件（不是使用者按上一頁、
    // 也不是本頁自己 pushState 產生的，任一般網頁載入都可能出現）。
    // quiz-sync.js 舊版的 popstate 監聽器沒有檢查這是不是自己真的推過的
    // { __quizSub:true } 記錄，只要「目前在 quiz 分頁 && course-select 不是
    // 顯示中」就會呼叫 forceBackToCourseSelect()——在這個競速情境下條件
    // 剛好成立，會把使用者剛剛選好的科目、上面才自我修復好的畫面全部清空、
    // 強制退回科目選擇畫面，而使用者根本沒有按過任何鍵。已在 quiz-sync.js
    // 加上 quizHistoryPushed 檢查修好（見該檔案該事件監聽器上的中文註解）。
    // 這裡多等一段時間、跨過 DOMContentLoaded／popstate 通常發生的時間點，
    // 確認上面剛自我修復好的畫面沒有被這個原生虛發事件打掉。
    // ---------------------------------------------------------------------
    await racePage.waitForTimeout(800);
    const stillHealedAfterPopstateWindow = await racePage.evaluate(() => ({
      hasBanner: !!document.getElementById('mock-exam-banner'),
      hasStartBtn: !!document.getElementById('mock-exam-start-btn'),
      quizSelectVisible: document.getElementById('quiz-select').style.display !== 'none',
      courseSelectVisible: document.getElementById('course-select').style.display !== 'none',
      currentCourse: window.currentCourse,
    }));
    record(
      'S17: 800ms later (past when the browser\'s native null-state popstate typically fires), the self-healed banner/start-btn/course selection is still intact — not silently reset back to course-select',
      stillHealedAfterPopstateWindow.hasBanner &&
        stillHealedAfterPopstateWindow.hasStartBtn &&
        stillHealedAfterPopstateWindow.quizSelectVisible &&
        !stillHealedAfterPopstateWindow.courseSelectVisible &&
        stillHealedAfterPopstateWindow.currentCourse === 'medsurg',
      stillHealedAfterPopstateWindow
    );

    // 不只外觀補上——按鈕要真的能用。
    await racePage.click('#mock-exam-start-btn');
    await racePage.waitForFunction(() => window.qList && window.qList.length === 50, null, { timeout: 10000 });
    const examStarted = await racePage.evaluate(() => window.qList && window.qList.length === 50);
    record('S17: the self-healed start button actually works (a real 50-question mock exam starts)', examStarted);
  } finally {
    await raceBrowser.close();
  }
}

// ===========================================================================
async function scenario18() {
  console.log('\n### Scenario 18（S17 修正的迴歸保護）: 真正的瀏覽器上一頁，在正常（非競速）情況下仍然要能正確退回科目選擇畫面 ###');
  // S17 的產品修正是在 quiz-sync.js 的 popstate 監聽器加上 quizHistoryPushed
  // 檢查，只在「我們真的有補推過 { __quizSub:true } 記錄」時才處理
  // popstate。這個情境專門驗證這個修正沒有連帶關掉這支監聽器原本正常、
  // 正確的功能——使用者在選好科目、進入 quiz-select 畫面之後，真的按瀏覽器
  // 上一頁，仍然要能退回科目選擇，而不是直接離開整個刷題分頁或毫無反應。
  await freshLoad();
  await goToQuizPage();
  await page.evaluate(() => { window.selectCourse('medsurg'); }); // 走正常（已包裝）路徑，會呼叫 pushQuizSubStateIfNeeded()
  await page.waitForSelector('#mock-exam-start-btn', { timeout: 10000 });

  const beforeBack = await page.evaluate(() => ({
    quizSelectVisible: document.getElementById('quiz-select').style.display !== 'none',
    courseSelectVisible: document.getElementById('course-select').style.display !== 'none',
  }));
  record('S18: precondition — normal course selection shows quiz-select, hides course-select', beforeBack.quizSelectVisible && !beforeBack.courseSelectVisible, beforeBack);

  await page.evaluate(() => { history.back(); });
  await page.waitForFunction(() => {
    const cs = document.getElementById('course-select');
    return cs && cs.style.display !== 'none';
  }, null, { timeout: 5000 });

  const afterBack = await page.evaluate(() => ({
    quizSelectVisible: document.getElementById('quiz-select').style.display !== 'none',
    courseSelectVisible: document.getElementById('course-select').style.display !== 'none',
  }));
  record('S18: a real browser back-button press while on quiz-select still correctly returns to course-select (quizHistoryPushed fix did not break this)', !afterBack.quizSelectVisible && afterBack.courseSelectVisible, afterBack);
}

// ===========================================================================
// 2026-09 網站模擬考新版合併回主線（origin/main）前的額外驗證：以下 S19-S22
// 專門補驗「合併時被保留、理論上不受這次模擬考重寫影響」的 4 項線上既有
// 功能，確保逐函式合併過程沒有不小心弄壞它們——不能只驗證模擬考新版本身
// （S1-S18 涵蓋的範圍），這 4 項是合併對象（origin/main）在這次合併之前
// 就已經存在、且必須完整保留的功能：
//   S19 = 新 taxonomy 章節分類（mergeChapterTaxonomy）
//   S20 = 標籤練習複選章節＋自選題數（ensureTagPracticeBar／
//         openTagPracticeCountModal／getTagPracticeQuestions）
//   S21 = 離開分頁切到背景再切回時的倒數計時修正（visibilitychange）
//   S22 = 模擬考橫幅「怎麼用？」連結（mock-exam-guide.html）
// ===========================================================================

async function scenario19() {
  console.log('\n### Scenario 19（合併保留驗證一）: 新 taxonomy 章節分類仍正確套用到題庫（mergeChapterTaxonomy）###');
  await freshLoad();
  const result = await page.evaluate(() => {
    const tax = window.CHAPTER_TAXONOMY_BY_ID || {};
    const taxKeys = Object.keys(tax);
    const sample = (window.QS || []).filter((q) => tax[q.n]).slice(0, 300);
    const allMatch = sample.every((q) => {
      const entry = tax[q.n];
      return q.section === entry[0] && q.chapter === entry[1];
    });
    return {
      taxonomyLoaded: taxKeys.length > 0,
      sampleSize: sample.length,
      allMatch,
      exampleSection: sample[0] ? sample[0].section : null,
      exampleChapter: sample[0] ? sample[0].chapter : null,
    };
  });
  record('S19: CHAPTER_TAXONOMY_BY_ID 資料確實載入（非空）', result.taxonomyLoaded, result);
  record('S19: window.QS 題目的 section/chapter 確實依新 taxonomy 資料設定，抽樣核對全部一致', result.sampleSize > 0 && result.allMatch, result);

  // 分類資料不能只是「存在但沒被用到」——要確認它真的驅動了標籤練習可選的章節。
  await goToQuizPage();
  await page.evaluate(() => { window.selectCourse('medsurg'); });
  await page.waitForSelector('#tag-practice-bar', { timeout: 10000 });
  const tagsMatchTaxonomy = await page.evaluate(() => {
    const chipValues = Array.from(document.querySelectorAll('#tag-practice-bar [data-value]')).map((el) => el.dataset.value);
    const taxonomyChapters = new Set(Object.values(window.CHAPTER_TAXONOMY_BY_ID || {}).map((e) => e[1]));
    return {
      chipValues,
      allChipsAreRealTaxonomyChapters: chipValues.every((v) => taxonomyChapters.has(v)),
    };
  });
  record(
    'S19: 標籤練習顯示的章節標籤，確實都是新 taxonomy 裡真實存在的章節（分類資料有被實際使用，不是死資料）',
    tagsMatchTaxonomy.chipValues.length > 0 && tagsMatchTaxonomy.allChipsAreRealTaxonomyChapters,
    tagsMatchTaxonomy
  );
}

async function scenario20() {
  console.log('\n### Scenario 20（合併保留驗證二）: 標籤練習複選章節＋自選題數仍正常運作 ###');
  await freshLoad();
  await goToQuizPage();
  await page.evaluate(() => { window.selectCourse('medsurg'); });
  await page.waitForSelector('#tag-practice-bar', { timeout: 10000 });

  const chipCount = await page.evaluate(() => document.querySelectorAll('#tag-practice-bar [data-value]').length);
  record('S20: precondition — tag-practice-bar 至少提供 2 個章節標籤可選', chipCount >= 2, { chipCount });

  const selectedValues = await page.evaluate(() => {
    const chips = Array.from(document.querySelectorAll('#tag-practice-bar [data-value]')).slice(0, 2);
    chips.forEach((c) => c.click());
    return chips.map((c) => c.dataset.value);
  });

  const afterSelect = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('#tag-practice-bar button'));
    const startBtn = btns.find((b) => b.textContent.includes('開始練習'));
    return { disabled: startBtn ? startBtn.disabled : null, barText: document.getElementById('tag-practice-bar').textContent };
  });
  record('S20: 複選 2 個章節標籤後，開始練習按鈕變為可點擊（不再是 disabled）', afterSelect.disabled === false, afterSelect);
  record('S20: 複選 2 個章節後，畫面文字顯示「已選 2 個章節」', afterSelect.barText.includes('已選 2 個章節'), afterSelect);

  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('#tag-practice-bar button'));
    const startBtn = btns.find((b) => b.textContent.includes('開始練習'));
    startBtn.click();
  });
  await page.waitForSelector('#tag-practice-count-modal', { timeout: 5000 });
  const modalOptions = await page.evaluate(() => Array.from(document.querySelectorAll('#tag-practice-count-modal button')).map((b) => b.textContent));
  const hasOpt = (s) => modalOptions.some((t) => t.includes(s));
  record('S20: 點擊開始練習後彈出自選題數視窗，含 10/20/50/全部（不設上限）選項', hasOpt('10 題') && hasOpt('20 題') && hasOpt('50 題') && hasOpt('全部'), modalOptions);

  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('#tag-practice-count-modal button'));
    const btn = btns.find((b) => b.textContent.startsWith('20 題'));
    btn.click();
  });
  await page.waitForFunction(() => window.qList && window.qList.length > 0, null, { timeout: 10000 });

  const reviewInfo = await page.evaluate((selected) => ({
    qListLen: window.qList.length,
    onlyFromSelectedChapters: window.qList.every((q) => selected.indexOf(q.chapter) !== -1),
  }), selectedValues);
  record(
    'S20: 自選 20 題後，實際練習題數 > 0 且不超過 20（章節題庫可能不足 20 題，但不會超過、也不會是 0）',
    reviewInfo.qListLen > 0 && reviewInfo.qListLen <= 20,
    reviewInfo
  );
  record('S20: 練習題目全部來自剛才複選的 2 個章節，沒有混入其他未選章節', reviewInfo.onlyFromSelectedChapters, reviewInfo);
}

async function scenario21() {
  console.log('\n### Scenario 21（合併保留驗證三）: 分頁切到背景再切回時的倒數計時修正（visibilitychange）仍正常運作，不重複交卷 ###');
  await freshLoad();
  await startMockExam('medsurg');
  await answerQuestion(0, 0);

  // (a) 還沒過期時，切到背景再切回：只補刷新一次倒數顯示，不應該誤觸發交卷。
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(30);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(100);
  const notExpiredState = await page.evaluate(() => ({
    stillInQuizArea: document.getElementById('quiz-area').style.display !== 'none',
    attemptsCount: JSON.parse(localStorage.getItem('rex_mock_attempts_v1') || '[]').length,
  }));
  record(
    'S21: 未過期時切到背景再切回，不會誤觸發自動交卷（仍在作答畫面、沒有新增成績紀錄）',
    notExpiredState.stillInQuizArea && notExpiredState.attemptsCount === 0,
    notExpiredState
  );

  // (b) 切到背景「這段期間」剛好已經過期：切回可見的當下要補判斷、自動交卷剛好一次
  // （不是 0 次、也不是重複的 2 次）。用暫時覆寫 Date.now() 的方式在不用真的
  // 等 60 分鐘的情況下重現「背景時剛好到期」的情境，斷言做完立刻還原。
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(30);
  await page.evaluate(() => {
    const future = Date.now() + 61 * 60 * 1000;
    window.__origDateNowForTest = Date.now;
    Date.now = () => future;
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForFunction(() => document.getElementById('quiz-result').style.display !== 'none', null, { timeout: 5000 });
  await page.evaluate(() => { Date.now = window.__origDateNowForTest; });
  await page.waitForTimeout(150); // 確保沒有第二次遲來的重複交卷

  const expiredState = await page.evaluate(() => ({
    attempts: JSON.parse(localStorage.getItem('rex_mock_attempts_v1') || '[]'),
    sessionCleared: localStorage.getItem('rex_mock_session_v1') === null,
  }));
  record('S21: 背景期間到期、切回可見時自動交卷，剛好新增 1 筆成績紀錄（不是 0 筆也不是重複的 2 筆）', expiredState.attempts.length === 1, expiredState);
  record('S21: 該筆成績正確標記為 autoSubmitted=true', !!expiredState.attempts[0] && expiredState.attempts[0].autoSubmitted === true, expiredState.attempts[0]);
  record('S21: 交卷成功後，進行中的 session 已被清除（不會殘留一個「已經交過但還顯示續作卡片」的殭屍 session）', expiredState.sessionCleared, expiredState);
}

async function scenario22() {
  console.log('\n### Scenario 22（合併保留驗證四）: 模擬考橫幅「怎麼用？」連結仍存在且指向正確頁面 ###');
  await freshLoad();
  await goToQuizPage();
  await page.evaluate(() => { window.selectCourse('medsurg'); });
  await page.waitForSelector('#mock-exam-banner', { timeout: 10000 });

  const linkInfo = await page.evaluate(() => {
    const banner = document.getElementById('mock-exam-banner');
    const link = banner ? Array.from(banner.querySelectorAll('a')).find((a) => a.textContent.includes('怎麼用')) : null;
    return {
      exists: !!link,
      href: link ? link.getAttribute('href') : null,
      target: link ? link.getAttribute('target') : null,
    };
  });
  record('S22: 模擬考橫幅內有「怎麼用？」連結', linkInfo.exists, linkInfo);
  record('S22: 連結指向 mock-exam-guide.html', linkInfo.href === 'mock-exam-guide.html', linkInfo);
  record('S22: 連結在新分頁開啟（target=_blank），不會中斷正在進行的作答畫面', linkInfo.target === '_blank', linkInfo);

  const guideResp = await page.evaluate(async () => {
    try {
      const res = await fetch('mock-exam-guide.html', { method: 'GET' });
      return { ok: res.ok, status: res.status };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });
  record('S22: mock-exam-guide.html 實際存在、回應正常（不是死連結）', guideResp.ok, guideResp);
}

async function scenario23() {
  console.log('\n### Scenario 23: 錯題本依科目／章節與考試日期分類；導覽列維持站內作答頁 ###');
  await freshLoad();

  // 直接從正式題庫挑出跨科目、跨章節、跨考試梯次的題目，寫入真正的
  // rex_quiz_myprogress_v1；每題選一個不在正解裡的選項，確保都會進錯題本。
  const seed = await page.evaluate(() => {
    const picked = [];
    const candidates = window.QS.filter((q) => q.course && q.chapter && q.exam);
    const first = candidates[0];
    if (first) picked.push(first);
    const secondChapter = candidates.find((q) => q.course === first.course && q.chapter !== first.chapter);
    if (secondChapter) picked.push(secondChapter);
    const secondCourse = candidates.find((q) => q.course !== first.course);
    if (secondCourse) picked.push(secondCourse);
    const secondExam = candidates.find((q) => q.exam !== first.exam && !picked.some((p) => p.n === q.n));
    if (secondExam) picked.push(secondExam);

    const answers = {};
    picked.forEach((q) => {
      answers[q.n] = [0, 1, 2, 3].find((idx) => !q.ans.includes(idx));
    });
    localStorage.setItem('rex_quiz_myprogress_v1', JSON.stringify({ answers, flagged: {}, mockHistory: [] }));
    return {
      count: picked.length,
      courses: [...new Set(picked.map((q) => q.course))],
      chapters: [...new Set(picked.map((q) => q.chapter))],
      exams: [...new Set(picked.map((q) => {
        const m = /(\d+)-(\d+)$/.exec(q.exam || '');
        return m ? m[1] + '-' + m[2] : q.exam;
      }))],
    };
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForMockExamModuleReady();
  await goToQuizPage();
  await page.click('#review-wrong-btn');
  await page.waitForSelector('#wrong-book-panel', { timeout: 5000 });

  const initial = await page.evaluate(() => {
    const panel = document.getElementById('wrong-book-panel');
    return {
      count: document.getElementById('review-wrong-count').textContent,
      text: panel ? panel.innerText : '',
      buttons: panel ? Array.from(panel.querySelectorAll('button')).map((b) => b.innerText) : [],
    };
  });
  record('S23: 錯題本按鈕顯示的題數與實際種入的錯題數一致', Number(initial.count) === seed.count, { seed, initial });
  record('S23: 點錯題本先開啟分類面板，不再直接混成一份開始作答', initial.text.includes('錯題分類'), initial);
  record('S23: 分類面板同時提供「依科目／章節」與「依考試日期」兩種入口', initial.text.includes('依科目／章節') && initial.text.includes('依考試日期'), initial.text);
  const classificationCounts = await page.evaluate(() => ({
    courseButtons: document.querySelectorAll('#wrong-book-panel [data-wrong-course]').length,
    chapterButtons: document.querySelectorAll('#wrong-book-panel [data-wrong-chapter]').length,
  }));
  record('S23: 依科目／章節頁列出至少兩個實際有錯題的科目', seed.courses.length >= 2 && classificationCounts.courseButtons === seed.courses.length, { seed, classificationCounts });
  record('S23: 依科目／章節頁顯示選定科目的章節按鈕與題數', classificationCounts.chapterButtons >= 1 && seed.chapters.some((chapter) => initial.buttons.some((t) => t.includes(chapter) && /\d+\s*題/.test(t))), { seed, classificationCounts, buttons: initial.buttons });

  await page.setViewportSize({ width: 375, height: 812 });
  const mobileLayout = await page.evaluate(() => {
    const panel = document.getElementById('wrong-book-panel');
    const rect = panel.getBoundingClientRect();
    return { left: rect.left, right: rect.right, viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth };
  });
  record('S23: 375px 手機寬度下錯題分類面板完整落在畫面內，沒有水平捲動', mobileLayout.left >= 0 && mobileLayout.right <= mobileLayout.viewport && mobileLayout.scrollWidth <= mobileLayout.viewport, mobileLayout);

  await page.locator('#wrong-book-panel button', { hasText: '依考試日期' }).click();
  const examView = await page.evaluate(() => ({
    text: document.getElementById('wrong-book-panel').innerText,
    buttons: Array.from(document.querySelectorAll('#wrong-book-panel button')).map((b) => b.innerText),
  }));
  const examButtonCount = await page.evaluate(() => document.querySelectorAll('#wrong-book-panel [data-wrong-exam]').length);
  record('S23: 切到依考試日期後，列出的梯次數與錯題來源的不同考試梯次數一致', examButtonCount === seed.exams.length, { seed, examButtonCount, examView });

  // 真正點一個日期分類，確認進入後 qList 只含該梯次，而不只是畫面上有分類文字。
  const clickedExam = await page.evaluate(() => {
    const btn = document.querySelector('#wrong-book-panel [data-wrong-exam]');
    if (!btn) return null;
    const exam = btn.dataset.wrongExam;
    btn.click();
    return { text: btn.innerText, exam };
  });
  const filtered = await page.evaluate(() => ({
    exams: [...new Set(window.qList.map((q) => {
      const m = /(\d+)-(\d+)$/.exec(q.exam || '');
      return m ? m[1] + '-' + m[2] : q.exam;
    }))],
    len: window.qList.length,
  }));
  record('S23: 點選日期分類後真的只載入單一考試梯次的錯題', !!clickedExam && filtered.len > 0 && filtered.exams.length === 1 && filtered.exams[0] === clickedExam.exam, { clickedExam, filtered });

  // 重新載入後，以真實滑鼠點導覽列連結；若新版 window.goPage 包裝沒把
  // origGoPage() 的 false 傳回 inline onclick，這裡會直接導航到 /quiz.html。
  await freshLoad();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.click('[data-group="practice"] .nav-group-toggle');
  await page.click('#nav-quiz');
  await page.waitForTimeout(250);
  const route = await page.evaluate(() => ({ pathname: location.pathname, hash: location.hash, quizActive: document.getElementById('page-quiz').classList.contains('active') }));
  record('S23: 點「線上歷屆考題測驗」留在 index.html 的站內作答頁，不再跳到 quiz.html', /\/index\.html$/.test(route.pathname) && route.hash === '#quiz' && route.quizActive, route);
}

async function main() {
  server = await startServer(SITE_ROOT, PORT);
  browser = await chromium.launch();
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  page = await context.newPage();
  page.on('dialog', d => d.accept());
  page.on('pageerror', e => pageErrors.push(String(e)));
  fs.mkdirSync(path.join(__dirname, 'screenshots'), { recursive: true });
  page.on('console', msg => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (text.includes('Failed to load resource')) return;
    if (text.includes('bad HTTP response code (404)')) return;
    if (text.includes('Permissions policy violation')) return;
    pageErrors.push('console.error: ' + text);
  });

  try {
    if (process.env.REX_TEST_SCENARIO === '23') {
      try { await scenario23(); } catch (e) { record('S23: threw an unexpected exception', false, e.stack || String(e)); }
      record('No uncaught page errors or console.error across the targeted run', pageErrors.length === 0, pageErrors.join(' | '));
    } else {
    try { await scenario1(); } catch (e) { record('S1: threw an unexpected exception', false, e.stack || String(e)); }
    try { await scenario2(); } catch (e) { record('S2: threw an unexpected exception', false, e.stack || String(e)); }
    try { await scenario3(); } catch (e) { record('S3: threw an unexpected exception', false, e.stack || String(e)); }
    try { await scenario4(); } catch (e) { record('S4: threw an unexpected exception', false, e.stack || String(e)); }
    try { await scenario5(); } catch (e) { record('S5: threw an unexpected exception', false, e.stack || String(e)); }
    try { await scenario7(); } catch (e) { record('S7: threw an unexpected exception', false, e.stack || String(e)); }
    try { await scenario8(); } catch (e) { record('S8: threw an unexpected exception', false, e.stack || String(e)); }
    try { await scenario9(); } catch (e) { record('S9: threw an unexpected exception', false, e.stack || String(e)); }
    try { await scenario10(); } catch (e) { record('S10: threw an unexpected exception', false, e.stack || String(e)); }
    try { await scenario11(); } catch (e) { record('S11: threw an unexpected exception', false, e.stack || String(e)); }
    try { await scenarioBanner(); } catch (e) { record('SBanner: threw an unexpected exception', false, e.stack || String(e)); }
    try { await scenario12(); } catch (e) { record('S12: threw an unexpected exception', false, e.stack || String(e)); }
    try { await scenario13(); } catch (e) { record('S13a: threw an unexpected exception', false, e.stack || String(e)); }
    try { await scenario14(); } catch (e) { record('S13b: threw an unexpected exception', false, e.stack || String(e)); }
    try { await scenario15(); } catch (e) { record('S15: threw an unexpected exception', false, e.stack || String(e)); }
    try { await scenario16(); } catch (e) { record('S16: threw an unexpected exception', false, e.stack || String(e)); }
    try { await scenario17(); } catch (e) { record('S17: threw an unexpected exception', false, e.stack || String(e)); }
    try { await scenario18(); } catch (e) { record('S18: threw an unexpected exception', false, e.stack || String(e)); }
    try { await scenario19(); } catch (e) { record('S19: threw an unexpected exception', false, e.stack || String(e)); }
    try { await scenario20(); } catch (e) { record('S20: threw an unexpected exception', false, e.stack || String(e)); }
    try { await scenario21(); } catch (e) { record('S21: threw an unexpected exception', false, e.stack || String(e)); }
    try { await scenario22(); } catch (e) { record('S22: threw an unexpected exception', false, e.stack || String(e)); }
    try { await scenario23(); } catch (e) { record('S23: threw an unexpected exception', false, e.stack || String(e)); }

      record('No uncaught page errors or console.error across the entire run', pageErrors.length === 0, pageErrors.join(' | '));
    }
  } finally {
    if (browser) await browser.close();
    if (server) server.close();
  }
  console.log('\n=====================================');
  console.log('TOTAL=' + total + ' PASSED=' + passed + ' FAILED=' + (total - passed));
  const expectedTotal = process.env.REX_TEST_SCENARIO === '23' ? 10 : EXPECTED_TOTAL;
  if (total !== expectedTotal) {
    console.log(
      '⚠️  本次執行的斷言總數（' + total + '）跟完整跑完應有的數量（EXPECTED_TOTAL=' + EXPECTED_TOTAL + '）不一樣——' +
      '代表有情境中途拋出例外、後面的斷言根本沒有執行到，不是「這次剛好比較少」。' +
      '請往上找 "threw an unexpected exception" 那一行，那就是提前中斷的情境。'
    );
  }
  fs.writeFileSync(path.join(__dirname, 'acceptance-result.json'), JSON.stringify({ total, passed, expectedTotal, results }, null, 2));
  process.exit(total === passed && total === expectedTotal ? 0 : 1);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
