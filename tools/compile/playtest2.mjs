import { readFile } from 'node:fs/promises';
import { compileStory, createSession } from '@general-engine/engine/narrative';

const story = JSON.parse(await readFile('web/story.json', 'utf8'));
const compiled = compileStory(story);

function runPath(choiceIndexFn, label, maxSteps = 800) {
  const session = createSession(compiled, { seed: 42 });
  let r = session.start();
  let steps = 0;
  const chosen = [];
  while (steps++ < maxSteps) {
    if (r.view.awaiting === 'ended') {
      const st = session.snapshot().state;
      return { label, ok: true, ending: r.view.ending && r.view.ending.id, steps, vars: st.variables, tags: st.tags, choices: chosen.length };
    }
    if (r.view.awaiting === 'choice') {
      const opts = r.view.choices;
      const idx = Math.max(0, Math.min(opts.length - 1, choiceIndexFn(opts.length, chosen.length)));
      const c = opts[idx];
      chosen.push(c.id);
      r = session.dispatch({ type: 'choose', optionId: c.id });
      continue;
    }
    if (r.view.awaiting === 'continue') { r = session.dispatch({ type: 'continue' }); continue; }
    return { label, ok: false, reason: 'stuck awaiting=' + r.view.awaiting, steps, nodeId: r.view.nodeId };
  }
  return { label, ok: false, reason: 'overflow', steps };
}

const paths = [
  ['全选 A', () => 0],
  ['全选 B', (n) => Math.min(1, n - 1)],
  ['全选 C', (n) => Math.min(2, n - 1)],
  ['全选最后一项', (n) => n - 1],
  ['交替 A/C', (n, i) => (i % 2 === 0 ? 0 : n - 1)],
];
let allOk = true;
for (const [label, fn] of paths) {
  const res = runPath(fn, label);
  if (!res.ok) allOk = false;
  console.log(JSON.stringify(res));
}
console.log(allOk ? 'ALL PATHS OK' : 'SOME PATHS FAILED');
