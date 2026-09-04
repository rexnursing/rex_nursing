// quiz-mock-exam.test.mjs
// 直接 import 真正上線用的 quiz-mock-exam.js 純函式（不是另外重寫一份
// 邏輯相同的模擬版），跟 mobile app scripts/tests/ 底下的測試是同一種
// 「測真正的程式碼」原則。只測不需要 document/window 的部分：
//   - 純函式（不碰任何全域狀態）
//   - localStorage 存取函式（用下面這個最小 in-memory shim 提供 localStorage）
// 需要 document/window 的 UI 組件（操作列／續作卡片／確認彈窗／歷史彈窗）
// 不在這個檔案的範圍內，那些由 Playwright 瀏覽器測試（另一支腳本）驗證。
//
// 執行方式：node tests/quiz-mock-exam.test.mjs

class MemoryStorage {
  constructor() {
    this._data = new Map();
  }
  getItem(key) {
    return this._data.has(key) ? this._data.get(key) : null;
  }
  setItem(key, value) {
    this._data.set(key, String(value));
  }
  removeItem(key) {
    this._data.delete(key);
  }
  clear() {
    this._data.clear();
  }
}

globalThis.localStorage = new MemoryStorage();

const mockExam = await import('../quiz-mock-exam.js');

let total = 0;
let passed = 0;
const failures = [];

function check(name, condition, detail) {
  total++;
  if (condition) {
    passed++;
  } else {
    failures.push({ name, detail });
    console.log('  ✗ FAIL:', name, detail !== undefined ? JSON.stringify(detail) : '');
  }
}

function section(name, fn) {
  console.log('\n== ' + name + ' ==');
  fn();
}

// ---------------------------------------------------------------------------
section('computeRemainingMs / isExpired / formatCountdown', () => {
  const now = 1_000_000;
  check('remaining ms before deadline', mockExam.computeRemainingMs(now + 5000, now) === 5000);
  check('remaining ms clamps to 0 past deadline', mockExam.computeRemainingMs(now - 5000, now) === 0);
  check('remaining ms exactly at deadline is 0', mockExam.computeRemainingMs(now, now) === 0);
  check('remaining ms with invalid deadline is 0', mockExam.computeRemainingMs(undefined, now) === 0);

  check('isExpired false before deadline', mockExam.isExpired(now + 1, now) === false);
  check('isExpired true exactly at deadline (>=)', mockExam.isExpired(now, now) === true);
  check('isExpired true after deadline', mockExam.isExpired(now - 1, now) === true);
  check('isExpired false with invalid deadline', mockExam.isExpired(undefined, now) === false);

  check('formatCountdown 0ms -> 00:00', mockExam.formatCountdown(0) === '00:00');
  check('formatCountdown 59500ms rounds to 01:00', mockExam.formatCountdown(59500) === '01:00');
  check('formatCountdown 3600000ms -> 60:00', mockExam.formatCountdown(60 * 60 * 1000) === '60:00');
  check('formatCountdown negative clamps to 00:00', mockExam.formatCountdown(-500) === '00:00');
  check('formatCountdown 125000ms -> 02:05', mockExam.formatCountdown(125000) === '02:05');
});

// ---------------------------------------------------------------------------
section('isValidSessionShape', () => {
  const validBase = {
    version: mockExam.SESSION_VERSION,
    attemptId: 'matt_abc',
    course: 'medsurg',
    questionIds: [1, 2, 3],
    answers: { 0: 1 },
    currentIndex: 0,
    deadline: Date.now() + 1000,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  check('a fully-shaped session is valid', mockExam.isValidSessionShape(validBase) === true);
  check('null is invalid', mockExam.isValidSessionShape(null) === false);
  check('a plain string is invalid', mockExam.isValidSessionShape('nope') === false);
  check('wrong version is invalid (future schema change safety)', mockExam.isValidSessionShape({ ...validBase, version: 999 }) === false);
  check('missing attemptId is invalid', mockExam.isValidSessionShape({ ...validBase, attemptId: undefined }) === false);
  check('empty attemptId is invalid', mockExam.isValidSessionShape({ ...validBase, attemptId: '' }) === false);
  check('missing course is invalid', mockExam.isValidSessionShape({ ...validBase, course: undefined }) === false);
  check('empty questionIds array is invalid', mockExam.isValidSessionShape({ ...validBase, questionIds: [] }) === false);
  check('questionIds not an array is invalid', mockExam.isValidSessionShape({ ...validBase, questionIds: 'x' }) === false);
  check('answers not an object is invalid', mockExam.isValidSessionShape({ ...validBase, answers: null }) === false);
  check('currentIndex not a number is invalid', mockExam.isValidSessionShape({ ...validBase, currentIndex: '0' }) === false);
  check('non-finite deadline is invalid', mockExam.isValidSessionShape({ ...validBase, deadline: Infinity }) === false);
  check('missing startedAt is invalid', mockExam.isValidSessionShape({ ...validBase, startedAt: undefined }) === false);
});

// ---------------------------------------------------------------------------
section('decideSubmit — 交卷防重複／防過期回呼（跟 mobile app 的 decideFinishSection 同一個道理）', () => {
  const allow = mockExam.decideSubmit({ boundAttemptId: 'a1', currentAttemptId: 'a1', isSubmitting: false });
  check('matching attemptId, not submitting -> allow', allow.allow === true, allow);

  const staleAttempt = mockExam.decideSubmit({ boundAttemptId: 'old-attempt', currentAttemptId: 'new-attempt', isSubmitting: false });
  check('bound to an old/different attemptId -> rejected as stale-attempt', staleAttempt.allow === false && staleAttempt.reason === 'stale-attempt', staleAttempt);

  const alreadySubmitting = mockExam.decideSubmit({ boundAttemptId: 'a1', currentAttemptId: 'a1', isSubmitting: true });
  check('a second call while already submitting -> rejected (double-tap guard)', alreadySubmitting.allow === false && alreadySubmitting.reason === 'already-submitting', alreadySubmitting);

  const noCurrentAttempt = mockExam.decideSubmit({ boundAttemptId: 'a1', currentAttemptId: null, isSubmitting: false });
  check('no current attempt at all -> rejected as stale-attempt', noCurrentAttempt.allow === false && noCurrentAttempt.reason === 'stale-attempt', noCurrentAttempt);

  const missingContext = mockExam.decideSubmit(null);
  check('missing context entirely does not throw, rejected', missingContext.allow === false, missingContext);
});

// ---------------------------------------------------------------------------
section('scoreAttempt', () => {
  const bank = {
    101: { n: 101, ans: [0] },
    102: { n: 102, ans: [1, 2] }, // 多選其一即算對
    103: { n: 103, ans: [3] },
  };
  const lookup = (n) => bank[n];

  const r1 = mockExam.scoreAttempt([101, 102, 103], { 0: 0, 1: 2 }, lookup);
  // idx0(101): picked 0, ans[0] includes 0 -> correct
  // idx1(102): picked 2, ans includes 2 -> correct
  // idx2(103): 未作答 -> unanswered
  check('correct count', r1.correct === 2, r1);
  check('wrong count', r1.wrong === 0, r1);
  check('unanswered count', r1.unanswered === 1, r1);
  check('score = correct/total*100 rounded', r1.score === Math.round((2 / 3) * 100), r1);
  check('correctness map only has answered indices', Object.keys(r1.correctness).length === 2, r1.correctness);
  check('correctness[0] true, correctness[1] true', r1.correctness[0] === true && r1.correctness[1] === true, r1.correctness);

  const r2 = mockExam.scoreAttempt([101, 102, 103], { 0: 1, 1: 0, 2: 3 }, lookup);
  // idx0(101): picked 1, ans=[0] -> wrong; idx1(102): picked 0, ans=[1,2] -> wrong; idx2(103): picked 3, ans=[3] -> correct
  check('all-answered mixed result: correct', r2.correct === 1, r2);
  check('all-answered mixed result: wrong', r2.wrong === 2, r2);
  check('all-answered mixed result: unanswered', r2.unanswered === 0, r2);

  const r3 = mockExam.scoreAttempt([999], { 0: 0 }, () => undefined);
  check('lookupQuestion returning undefined is treated as wrong, not a crash', r3.wrong === 1 && r3.correct === 0, r3);

  const r4 = mockExam.scoreAttempt([], {}, lookup);
  check('empty question list scores 0 without dividing by zero', r4.score === 0 && r4.total === 0, r4);

  const r5 = mockExam.scoreAttempt([101], { 0: null }, lookup);
  check('answers[idx] === null counts as unanswered (not "picked option null")', r5.unanswered === 1 && r5.correct === 0 && r5.wrong === 0, r5);
});

// ---------------------------------------------------------------------------
section('isLegacyHistoryEntry', () => {
  check('entry without attemptId is legacy', mockExam.isLegacyHistoryEntry({ course: 'x', score: 80 }) === true);
  check('entry with attemptId is not legacy', mockExam.isLegacyHistoryEntry({ course: 'x', score: 80, attemptId: 'matt_1' }) === false);
  check('null entry is legacy (defensive)', mockExam.isLegacyHistoryEntry(null) === true);
  check('undefined entry is legacy (defensive)', mockExam.isLegacyHistoryEntry(undefined) === true);
  check('entry with empty-string attemptId is legacy', mockExam.isLegacyHistoryEntry({ attemptId: '' }) === true);
});

// ---------------------------------------------------------------------------
section('escapeHtml — 歷史明細彈窗直接把題目內容塞進 innerHTML 前的跳脫', () => {
  check('escapes all 5 special chars', mockExam.escapeHtml(`<script>&"'</script>`) === '&lt;script&gt;&amp;&quot;&#39;&lt;/script&gt;');
  check('null becomes empty string', mockExam.escapeHtml(null) === '');
  check('undefined becomes empty string', mockExam.escapeHtml(undefined) === '');
  check('plain text passes through unchanged', mockExam.escapeHtml('陳先生T3～T5脊髓損傷') === '陳先生T3～T5脊髓損傷');
  check('numbers get stringified', mockExam.escapeHtml(42) === '42');
});

// ---------------------------------------------------------------------------
section('generateAttemptId', () => {
  const ids = new Set();
  for (let i = 0; i < 500; i++) ids.add(mockExam.generateAttemptId());
  check('500 generated ids are all unique', ids.size === 500);
  check('id is a non-empty string with the matt_ prefix', /^matt_/.test(mockExam.generateAttemptId()));
});

// ---------------------------------------------------------------------------
section('saveSession / loadSession / clearSession (localStorage round-trip)', () => {
  localStorage.clear();
  check('loadSession with nothing saved returns null', mockExam.loadSession() === null);

  const session = {
    version: mockExam.SESSION_VERSION,
    attemptId: 'matt_x1',
    course: 'medsurg',
    questionIds: [1, 2, 3, 4, 5],
    answers: { 0: 1, 2: 3 },
    currentIndex: 2,
    startedAt: new Date().toISOString(),
    deadline: Date.now() + 60 * 60 * 1000,
    updatedAt: new Date().toISOString(),
  };
  const saveOk = mockExam.saveSession(session);
  check('saveSession returns true on success', saveOk === true);

  const loaded = mockExam.loadSession();
  check('loadSession round-trips attemptId', loaded && loaded.attemptId === 'matt_x1', loaded);
  check('loadSession round-trips questionIds (same order)', loaded && JSON.stringify(loaded.questionIds) === JSON.stringify([1, 2, 3, 4, 5]), loaded);
  check('loadSession round-trips answers', loaded && loaded.answers['0'] === 1 && loaded.answers['2'] === 3, loaded);
  check('loadSession round-trips currentIndex', loaded && loaded.currentIndex === 2, loaded);

  mockExam.clearSession();
  check('loadSession after clearSession returns null', mockExam.loadSession() === null);

  localStorage.setItem(mockExam.SESSION_KEY, '{not valid json');
  check('loadSession on corrupted JSON returns null instead of throwing', mockExam.loadSession() === null);

  localStorage.setItem(mockExam.SESSION_KEY, JSON.stringify({ ...session, version: 999 }));
  check('loadSession on a future/mismatched version returns null (safe upgrade path)', mockExam.loadSession() === null);

  localStorage.clear();
});

// ---------------------------------------------------------------------------
section('saveAttemptDetail / loadAttemptDetail (完整明細本機保存)', () => {
  localStorage.clear();
  const makeDetail = (id, overrides) => ({
    version: mockExam.ATTEMPT_VERSION,
    attemptId: id,
    course: 'medsurg',
    questionIds: [1, 2, 3],
    answers: { 0: 0, 1: 1, 2: 2 },
    correctness: { 0: true, 1: false, 2: true },
    correctCount: 2,
    wrongCount: 1,
    unansweredCount: 0,
    score: 67,
    startedAt: new Date().toISOString(),
    submittedAt: new Date().toISOString(),
    autoSubmitted: false,
    ...overrides,
  });

  check('loadAttemptDetail for unknown id returns null', mockExam.loadAttemptDetail('nope') === null);

  const ok1 = mockExam.saveAttemptDetail(makeDetail('matt_1'));
  check('saveAttemptDetail returns true', ok1 === true);
  const found1 = mockExam.loadAttemptDetail('matt_1');
  check('loadAttemptDetail finds the saved attempt', found1 && found1.score === 67, found1);

  // 同一個 attemptId 重複保存（例如保存後使用者手動重試）：不能留下兩筆。
  mockExam.saveAttemptDetail(makeDetail('matt_1', { score: 90 }));
  const afterResave = mockExam.loadAttemptDetail('matt_1');
  check('re-saving the same attemptId updates in place, not duplicates', afterResave && afterResave.score === 90, afterResave);

  const rawList = JSON.parse(localStorage.getItem(mockExam.ATTEMPTS_KEY));
  check('attempts list has exactly 1 entry for matt_1 (no duplicate)', rawList.filter((a) => a.attemptId === 'matt_1').length === 1, rawList.length);

  // MAX_STORED_ATTEMPTS 上限：存超過上限，只保留最新的那些。
  localStorage.clear();
  for (let i = 0; i < mockExam.MAX_STORED_ATTEMPTS + 5; i++) {
    mockExam.saveAttemptDetail(makeDetail('matt_seq_' + i));
  }
  const capped = JSON.parse(localStorage.getItem(mockExam.ATTEMPTS_KEY));
  check('attempts list is capped at MAX_STORED_ATTEMPTS', capped.length === mockExam.MAX_STORED_ATTEMPTS, capped.length);
  check('the most recently saved attempt is kept (newest-first)', capped[0].attemptId === 'matt_seq_' + (mockExam.MAX_STORED_ATTEMPTS + 4), capped[0].attemptId);
  check('an early attempt beyond the cap was evicted', mockExam.loadAttemptDetail('matt_seq_0') === null);

  localStorage.clear();
});

// ---------------------------------------------------------------------------
console.log('\n[quiz-mock-exam] TOTAL=' + total + ' PASSED=' + passed + ' FAILED=' + (total - passed));
if (failures.length) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log(' -', f.name, f.detail !== undefined ? JSON.stringify(f.detail) : ''));
}
process.exit(total === passed ? 0 : 1);
