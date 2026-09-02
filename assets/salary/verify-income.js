// assets/salary/verify-income.js
// 護理師薪資頁「回報全年總收入」驗算引擎。
//
// 背景（2026-09 新增）：薪資頁原本直接把訪客/社群回報的「年薪」數字當成
// 完整、已核實的年收入顯示。這支程式改為先「驗算」再顯示：只有在必要欄位
// 齊全、且逐項加總後的金額跟回報數字相符（或誤差在容許範圍內）時，才視為
// 已驗證；欄位不齊全時一律標示「尚未驗算」，但仍然顯示原始回報數字本身
// （因為「無法驗算」不等於「已證明是錯的」——這是 Rex 對原始四狀態規格的
// 明確修正，2026-09-02 對話中確認）；只有在欄位齊全、且計算結果明確兜不
// 起來時，才視為 invalid 並隱藏數字。
//
// 驗算公式（Rex 指定，逐字保留）：
//   全年總收入 ＝ 月薪固定收入 × 實際計薪月數
//              ＋ 小夜津貼 × 全年小夜班數
//              ＋ 大夜津貼 × 全年大夜班數
//              ＋ 年終獎金（換算後）
//              ＋ 其他可以確認的固定獎金
//
// 「月薪固定收入」對應既有欄位 baseSalary（底薪）；表單/資料庫不另外新增
// 一個意義重複的欄位。
//
// 四種狀態（用英文 key 存資料/邏輯，中文只用於顯示）：
//   verified     驗算正確：必要欄位齊全，逐項加總後與回報數字相符（誤差視為0）。
//   approximate  約略相符：必要欄位齊全，誤差 ≤5% 或 ≤NT$20,000。
//   unverifiable 尚未驗算：缺少必要欄位（計薪月數／全年小夜班數／全年大夜班數／
//                年終獎金換算基準之一或多項缺漏），無法判斷對錯——*不*隱藏數字。
//   invalid      驗算不符：必要欄位齊全，但計算結果誤差超出容許範圍——*才*隱藏
//                原始回報數字，改顯示「資料驗算不符，暫不顯示」。
//
// 沒有回報「回報全年總收入」數字本身的紀錄，根本不進入這支驗算流程，
// 顯示邏輯另外處理成「未提供」（跟驗算狀態是兩件事，不要混為一談）。
//
// 這支檔案沒有任何外部依賴、不碰 DOM、不連 Firestore，方便：
// (a) salary.html 用 <script src> 直接載入，在畫面上即時分類每一筆資料；
// (b) Node.js 的報告產生腳本 require() 這支檔案，對「同一份」拉下來的
//     正式資料跑「同一套」規則，確保報告內容與頁面顯示邏輯永遠一致，
//     不會有兩邊各自維護一份規則、結果兜不起來的風險。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SalaryVerify = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function toNum(v) {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  // 年終獎金換算：只接受「乾淨」、無歧義的兩種格式；其餘一律視為無法換算，
  // 絕不用猜的（例如「2.5個月(端午/中秋各0.5+年終1.5)」「底薪1.5個月+績效」
  // 這種混雜文字，就算看起來像是有月數，也因為摻雜了不確定的績效等其他
  // 變動項目、或計算基準不只一種，不視為「無歧義」，一律歸為換算失敗）。
  const MONTHS_RE = /^(?:約|最高)?\s*(\d+(?:\.\d+)?)\s*個?月(?:底薪|全薪)?$/;
  const CASH_WAN_RE = /^約?\s*(\d+(?:\.\d+)?)\s*萬元?$/;
  const CASH_YUAN_RE = /^約?\s*(\d+(?:\.\d+)?)\s*元$/;

  function resolveYearEndBonus(rawText, base) {
    const t = String(rawText || '').trim();
    if (!t) return { ok: false, reason: 'empty', detail: '年終獎金欄位空白（無法判斷是「真的沒有」還是「沒填」）' };
    let m = MONTHS_RE.exec(t);
    if (m) {
      if (base === null) return { ok: false, reason: 'months-no-base', detail: `年終獎金為「${t}」（月數制），但底薪缺漏，無法換算金額` };
      return { ok: true, value: base * Number(m[1]), basis: `${m[1]}個月 × 底薪` };
    }
    m = CASH_WAN_RE.exec(t);
    if (m) return { ok: true, value: Number(m[1]) * 10000, basis: `現金金額（萬元）` };
    m = CASH_YUAN_RE.exec(t);
    if (m) return { ok: true, value: Number(m[1]), basis: `現金金額（元）` };
    return { ok: false, reason: 'ambiguous', detail: `年終獎金文字「${t}」格式不明確（例如混合月數與績效、或多個條件並列），無法確定唯一換算基準` };
  }

  const TOLERANCE_ABS = 20000; // NT$20,000
  const TOLERANCE_PCT = 0.05;  // 5%

  // 對單一筆資料 r 執行驗算，回傳分類結果。
  // r 的欄位沿用 salary.html 既有命名：baseSalary, eveningDiff, nightDiff,
  // yearEndBonus, estimatedAnnualSalary；加上 2026-09 新增欄位：
  // paidMonths, annualEveningShiftCount, annualNightShiftCount,
  // otherFixedAnnualBonus。
  function classify(r) {
    const reportedAnnual = toNum(r.estimatedAnnualSalary);
    if (reportedAnnual === null) {
      // 根本沒有回報「回報全年總收入」數字，不算「無法驗算」，是另一種
      // 「未提供」情境，交給畫面顯示邏輯處理，不進入四狀態分類。
      return { state: 'no_annual_reported', reportedAnnual: null };
    }

    const base = toNum(r.baseSalary);
    const paidMonths = toNum(r.paidMonths);
    const eveCount = toNum(r.annualEveningShiftCount);
    const nightCount = toNum(r.annualNightShiftCount);
    const eveDiff = toNum(r.eveningDiff);
    const nightDiff = toNum(r.nightDiff);
    const otherBonus = toNum(r.otherFixedAnnualBonus);

    const missing = [];
    if (base === null) missing.push('底薪（月薪固定收入）');
    if (paidMonths === null) missing.push('實際計薪月數');
    if (eveCount === null) missing.push('全年小夜班數');
    if (nightCount === null) missing.push('全年大夜班數');
    if (eveCount !== null && eveCount > 0 && eveDiff === null) missing.push('小夜津貼（單班金額）');
    if (nightCount !== null && nightCount > 0 && nightDiff === null) missing.push('大夜津貼（單班金額）');

    const bonus = resolveYearEndBonus(r.yearEndBonus, base);
    if (!bonus.ok) missing.push(`年終獎金換算基準（${bonus.detail}）`);

    if (missing.length > 0) {
      return {
        state: 'unverifiable',
        reportedAnnual,
        missingFields: missing,
        note: '既有資料缺少驗算欄位，不代表數字錯誤，僅代表目前無法逐項驗算。',
      };
    }

    const calculated =
      base * paidMonths +
      (eveDiff || 0) * eveCount +
      (nightDiff || 0) * nightCount +
      bonus.value +
      (otherBonus || 0);

    const diff = Math.abs(calculated - reportedAnnual);
    const pct = reportedAnnual !== 0 ? diff / Math.abs(reportedAnnual) : (diff === 0 ? 0 : Infinity);

    if (diff < 1) {
      return { state: 'verified', reportedAnnual, calculated, diff, pct, bonusBasis: bonus.basis };
    }
    if (diff <= TOLERANCE_ABS || pct <= TOLERANCE_PCT) {
      return { state: 'approximate', reportedAnnual, calculated, diff, pct, bonusBasis: bonus.basis };
    }
    return { state: 'invalid', reportedAnnual, calculated, diff, pct, bonusBasis: bonus.basis };
  }

  // 補充檢查（不屬於四狀態分類本身，是額外、獨立、不需要任何缺漏欄位就能
  // 成立的「數學上不可能」檢查）：回報全年總收入 < 一個月的底薪，等於在說
  // 「整年賺的比一個月底薪還少」，這在邏輯上不可能成立（除非底薪或年收入
  // 兩者之一本身就是筆誤）。只在 base、reportedAnnual 都有值時才檢查。
  function findMathematicallyImpossible(r) {
    const base = toNum(r.baseSalary);
    const reportedAnnual = toNum(r.estimatedAnnualSalary);
    if (base === null || reportedAnnual === null) return null;
    if (reportedAnnual < base) {
      return `回報全年總收入（NT$${reportedAnnual.toLocaleString('en-US')}）小於單月底薪（NT$${base.toLocaleString('en-US')}），數學上不可能成立，建議人工復核（可能是底薪或年收入其中一項筆誤）`;
    }
    return null;
  }

  // 底薪年額（僅供參考用的輔助資訊，不是「全年總收入」，也不進入四狀態
  // 分類）：只有在有 baseSalary、但完全沒有 estimatedAnnualSalary 可驗算時，
  // 才會用在畫面上當作補充參考數字，且必須明確標示「底薪年額」字樣，
  // 不可稱為「全年總收入」或任何暗示已含所有加給獎金的字眼。
  function baseAnnualizedReference(r) {
    const base = toNum(r.baseSalary);
    if (base === null) return null;
    const months = toNum(r.paidMonths);
    const m = months !== null ? months : 12;
    return { value: base * m, monthsUsed: m, isAssumedTwelve: months === null };
  }

  return {
    toNum,
    resolveYearEndBonus,
    classify,
    findMathematicallyImpossible,
    baseAnnualizedReference,
    TOLERANCE_ABS,
    TOLERANCE_PCT,
  };
});
