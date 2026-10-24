import { readFile } from 'node:fs/promises';
import { compileStory } from './engine/packages/content/dist/index.js';
import { createSession } from './engine/packages/core/dist/index.js';

const story = JSON.parse(await readFile('web/story.json', 'utf8'));
const compiled = compileStory(story);

function runPath(choiceIndexFn, label, maxSteps = 600) {
  const session = createSession(compiled, { seed: 42 });
  let r = session.start();
  let steps = 0;
  const chosen = [];
  while (steps++ < maxSteps) {
    if (r.view.awaiting === 'ended') {
      return { label, ok: true, ending: r.view.ending, steps, vars: session.snapshot().state.variables, tags: session.snapshot().state.tags, chosen };
    }
    if (r.view.awaiting === 'choice') {
      const opts = r.view.choices;
      const idx = choiceIndexFn(opts.length, chosen.length);
      const c = opts[idx];
      chosen.push(c.id + ':' + c.text.slice(0, 12));
      r = session.dispatch({ type: 'choose', optionId: c.id });
      continue;
    }
    if (r.view.awaiting === 'continue') { r = session.dispatch({ type: 'continue' }); continue; }
    return { label, ok: false, reason: 'stuck awaiting=' + r.view.awaiting, steps };
  }
  return { label, ok: false, reason: 'overflow', steps };
}

const paths = [
  ['全选A', () => 0],
  ['全选B', (n) => Math.min(1, n - 1)],
  ['全选C', (n) => Math.min(2, n - 1)],
  ['全选最后一项', (n) => n - 1],
  ['交替', (n, i) => i % n],
];
for (const [label, fn] of paths) {
  const res = runPath(fn, label);
  console.log(JSON.stringify(res, null, 0));
}
