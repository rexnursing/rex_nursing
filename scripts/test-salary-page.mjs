import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../salary.html', import.meta.url), 'utf8');
const matches = [...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)];
assert.ok(matches.length, '找不到 salary.html 的 module script');

let source = matches.at(-1)[1]
  .replace(/^import .*;$/mg, '')
  .replace(/\npopulateFormRegionSelect\(\);\nsetupSubmitForm\(\);\ninit\(\);\s*$/, '');

const context = vm.createContext({
  console,
  initializeApp: () => ({}),
  getFirestore: () => ({}),
  getAuth: () => ({}),
  window: { SalaryVerify: {} },
  document: {},
  location: { search: '', pathname: '/salary.html', hash: '' },
  history: { replaceState() {} },
  URLSearchParams,
  Map,
  Set,
  Date,
});
vm.runInContext(source, context, { filename: 'salary.html#module' });

const reports = [
  { __id: 'old', hospitalName: '臺大醫院', region: '台北市', baseSalary: 40000, createdAt: { seconds: 100 } },
  { __id: 'new', hospitalName: '台大醫院', region: '台北市', baseSalary: 50000, createdAt: { seconds: 200 } },
  { __id: 'other', hospitalName: '成大醫院', region: '台南市', baseSalary: 45000, source: 'dcard_seed' },
];

const grouped = context.groupReportsByHospital(reports);
assert.equal(grouped.length, 2, '台／臺同院資料應合併，同時保留其他醫院');
const ntu = grouped.find(x => x.region === '台北市');
assert.equal(ntu.__reportCount, 2, '同院應顯示兩筆回報');
assert.equal(ntu.__reports[0].__id, 'new', '主列表應採最新一筆回報');
assert.equal(context.reportDateLabel(ntu.__reports[0]), '1970年1月回報');
assert.equal(context.reportDateLabel(grouped.find(x => x.region === '台南市')), '2026年8月整理');

console.log('salary grouping/date tests OK');
