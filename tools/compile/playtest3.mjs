import { readFile } from 'node:fs/promises';
import { compileStory } from '../../engine/packages/content/dist/index.js';
import { createSession } from '../../engine/packages/core/dist/index.js';

const story = JSON.parse(await readFile('web/story.json', 'utf8'));
const compiled = compileStory(story);

function runPath(choose, label, maxSteps = 3000) {
  const session = createSession(compiled, { seed: 42 });
  let r = session.start();
  let steps = 0, picks = 0;
  const seen = [];
  while (steps++ < maxSteps) {
    if (r.view.awaiting === 'ended') {
      const st = session.snapshot().state;
      return { label, ok: true, ending: r.view.ending && r.view.ending.id, steps, picks,
               vars: st.variables, tags: st.tags, path: seen.join('>') };
    }
    if (r.view.awaiting === 'choice') {
      const opts = r.view.choices.filter(c => !c.disabled);
      if (!opts.length) return { label, ok: false, reason: 'no enabled choice', steps, nodeId: r.view.nodeId };
      const pick = opts[Math.min(opts.length - 1, choose(opts.length, picks))];
      seen.push(pick.id);
      picks++;
      r = session.dispatch({ type: 'choose', optionId: pick.id });
      continue;
    }
    if (r.view.awaiting === 'continue') { r = session.dispatch({ type: 'continue' }); continue; }
    return { label, ok: false, reason: 'stuck ' + r.view.awaiting, steps, nodeId: r.view.nodeId };
  }
  return { label, ok: false, reason: 'overflow', steps };
}

const cases = [
  ['全A', () => 0],
  ['全B', (n) => Math.min(1, n - 1)],
  ['全C', (n) => Math.min(2, n - 1)],
  ['全D(最后)', (n) => n - 1],
];
let bad = 0;
for (const [label, fn] of cases) {
  const res = runPath(fn, label);
  if (!res.ok) bad++;
  console.log(JSON.stringify({ ...res, path: undefined }));
}
// 随机 60 次
let endCount = {};
let fails = 0;
for (let s = 0; s < 60; s++) {
  let seed = s * 7919 + 13;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const res = runPath((n) => Math.floor(rnd() * n), 'rand' + s);
  if (!res.ok) { fails++; console.log('FAIL', JSON.stringify(res)); }
  else endCount[res.ending] = (endCount[res.ending] || 0) + 1;
}
console.log('\n--- 60 random runs, fails=' + fails);
console.log('endings:', JSON.stringify(endCount, null, 0));
console.log(bad === 0 && fails === 0 ? 'ALL OK' : 'PROBLEMS');
