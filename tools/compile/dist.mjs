import { readFile } from 'node:fs/promises';
import { compileStory } from '../../engine/packages/content/dist/index.js';
import { createSession } from '../../engine/packages/core/dist/index.js';

const story = JSON.parse(await readFile('web/story.json', 'utf8'));
const compiled = compileStory(story);

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

const seen = new Map();
let hubRuns = 0;

function play(seed) {
  const rnd = rng(seed);
  const s = createSession(compiled, { seed: 42 });
  let r = s.start();
  let hubVisits = 0;
  for (let i = 0; i < 4000; i++) {
    const v = s.getView();
    if (v.awaiting === 'ended') {
      const st = s.snapshot().state;
      return { ending: v.ending?.id, vars: st.variables, tags: st.tags, hubVisits };
    }
    if (v.awaiting === 'choice') {
      const opts = v.choices.filter(c => !c.disabled);
      if (!opts.length) return { error: 'noopt' };
      if (v.nodeId === 'HUB:s1:c') hubVisits++;
      const pick = opts[Math.floor(rnd() * opts.length)];
      r = s.dispatch({ type: 'choose', optionId: pick.id });
      continue;
    }
    if (v.awaiting === 'continue') {
      // 记录到达 B11_judge 的状态
      if (v.nodeId && v.nodeId.startsWith('B11_judge')) {
        const st = s.snapshot().state;
        const k = JSON.stringify([st.variables.humanity, st.variables.contamination,
          st.tags.includes('key_godfather'), st.tags.includes('key_station'), st.tags.includes('key_father')]);
        seen.set(k, (seen.get(k) || 0) + 1);
      }
      r = s.dispatch({ type: 'continue' });
      continue;
    }
    break;
  }
  return { error: 'stuck' };
}

const endings = {};
for (let i = 0; i < 3000; i++) {
  const res = play(i * 2654435761 + 11);
  const k = res.ending || res.error;
  endings[k] = (endings[k] || 0) + 1;
}
console.log('3000 次随机游玩，结局分布：');
for (const [k, v] of Object.entries(endings).sort((a,b)=>b[1]-a[1])) {
  console.log('   ' + k.padEnd(24), v, '(' + (v/30).toFixed(1) + '%)');
}
console.log('\n到达 B11_judge 的不同状态数:', seen.size);
const rows = [...seen.entries()].map(([k,v]) => ({ ...JSON.parse(k), n: v }));
rows.sort((a,b) => a[0] - b[0]);
console.log('humanity  contam  keys  次数');
for (const r of rows.slice(0, 40)) console.log('  ' + String(r[0]).padStart(4) + '    ' + String(r[1]).padStart(4) + '   ' + (r[2]+r[3]+r[4]) + '   ' + r.n);
