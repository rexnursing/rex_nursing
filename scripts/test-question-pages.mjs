import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = process.argv[2] ? path.resolve(process.argv[2]) : fs.mkdtempSync(path.join(os.tmpdir(), 'rex-question-test-'));
execFileSync(process.execPath, [path.join(root, 'scripts/generate-question-pages.mjs'), `--src=${root}`, `--out=${out}`], { stdio: 'inherit' });

const data = { window: null };
data.window = data;
vm.runInNewContext(fs.readFileSync(path.join(root, 'exam-data.js'), 'utf8'), data);
const groups = new Map();
for (const q of data.QS) {
  const key = `${q.course}|${q.exam}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(q);
}
let checked = 0;
for (const [key, questions] of groups) {
  const [course, exam] = key.split('|');
  const label = exam.replace(new RegExp(`^${course}-`), '');
  const folder = path.join(out, 'questions', label);
  const html = fs.readFileSync(path.join(folder, course, 'index.html'), 'utf8');
  assert.ok(!html.includes('undefined'), key);
  const links = [...html.matchAll(/<li><a href="([^"]+)">第(\d+)題/g)];
  assert.equal(links.length, questions.length, `${key}: every question must have a link`);
  const expected = questions.map((q, i) => q.no ?? i + 1).sort((a, b) => a - b);
  assert.deepEqual(links.map(m => Number(m[2])), expected);
  for (const [, href, no] of links) {
    const page = fs.readFileSync(path.resolve(folder, course, href), 'utf8');
    assert.ok(page.includes(`<h1>第${no}題`), href);
    assert.ok(page.includes('<a href="./index.html">回本次考卷題目列表</a>'), href);
    assert.ok(!page.includes('undefined'), href);
    checked++;
  }
}

// Exercise the actual link injector with nested start buttons, repeated renders,
// static medsurg cards and dynamically rendered course cards.
const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const block = index.split('<!-- questions-quiz-links:start')[1].split('<!-- questions-quiz-links:end')[0];
const source = block.match(/<script>([\s\S]*?)<\/script>/)[1];
function card(code) {
  const wrappers = [];
  const button = { getAttribute: () => `startExam("${code}")`, appendChild() { assert.fail('link inserted into practice button'); } };
  const info = { appendChild: node => wrappers.push(node) };
  return {
    wrappers, button,
    getAttribute: () => `startExam("${code}")`,
    querySelector: selector => selector === '.qp-inline-link' ? wrappers[0] : info,
  };
}
const medsurg = card('115-1');
const obpeds = card('obpeds-114-3');
const grids = { 'examgrid-medsurg': { children: [medsurg] }, 'examgrid-obpeds': { children: [obpeds] } };
let ready;
const context = {
  window: { renderCourseGrid() {} },
  document: {
    getElementById: id => grids[id],
    createElement: () => ({}),
    addEventListener: (_, fn) => { ready = fn; },
  },
};
vm.runInNewContext(source, context);
ready(); ready();
context.window.renderCourseGrid('obpeds');
context.window.renderCourseGrid('obpeds');
for (const entry of [medsurg, obpeds]) assert.equal(entry.wrappers.length, 1);
assert.ok(obpeds.wrappers[0].innerHTML.includes('questions/114-3/obpeds/index.html'));
console.log(`PASS: ${checked} question links across ${groups.size} exams; one list link per card.`);
