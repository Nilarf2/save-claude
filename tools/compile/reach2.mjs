import { readFile } from 'node:fs/promises';
import { compileStory } from '../../engine/packages/content/dist/index.js';
import { createSession } from '../../engine/packages/core/dist/index.js';

const story = JSON.parse(await readFile('web/story.json', 'utf8'));
const compiled = compileStory(story);

const declared = [...new Set(story.nodes.filter(n => n.type === 'end').map(n => n.ending))];
console.log('declared endings:', declared.length);
console.log(declared.map(e => '  - ' + e).join('\n'));

const found = new Map();
function run(seed) {
  let s = seed | 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const session = createSession(compiled, { seed: 42 });
  let r = session.start();
  for (let i = 0; i < 4000; i++) {
    const v = r.view ?? session.getView();
    if (v.awaiting === 'ended') {
      const id = v.ending && v.ending.id;
      found.set(id, (found.get(id) || 0) + 1);
      return true;
    }
    if (v.awaiting === 'choice') {
      const opts = v.choices.filter(c => !c.disabled);
      if (!opts.length) return false;
      const pick = opts[Math.floor(rnd() * opts.length)];
      r = session.dispatch({ type: 'choose', optionId: pick.id });
      continue;
    }
    if (v.awaiting === 'continue') { r = session.dispatch({ type: 'continue' }); continue; }
    return false;
  }
  return false;
}

const N = 4000;
let ok = 0;
for (let i = 0; i < N; i++) if (run(i * 2654435761 + 7)) ok++;

console.log('\nruns:', N, 'completed:', ok);
console.log('found endings:', found.size);
for (const [id, n] of [...found.entries()].sort((a, b) => b[1] - a[1])) console.log('  ', id, '×', n);
const missing = declared.filter(e => !found.has(e));
console.log('\nNOT FOUND:', missing.length ? missing : 'none');
