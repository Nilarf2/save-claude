import { readFile } from 'node:fs/promises';
import { compileStory, createSession } from '@general-engine/engine/narrative';

const story = JSON.parse(await readFile('web/story.json', 'utf8'));
const compiled = compileStory(story);

const endings = new Map();   // endingId -> {count, sample}
const visitedStates = new Set();
let expanded = 0;
const MAX_EXPAND = 200000;

function key(snapshot) {
  const st = snapshot.state;
  return [st.nodeId, st.lineIndex, st.awaiting,
          Object.entries(st.variables).sort().map(([k,v])=>k+'='+v).join(','),
          st.tags.slice().sort().join(','), st.scene && st.scene.scene].join('|');
}

// BFS over (deterministic) states: 用一个 session 快照做分支
const queue = [];
{
  const s = createSession(compiled, { seed: 42 });
  s.start();
  // 推进到第一个交互点
  let r = { view: s.getView() };
  for (let i = 0; i < 5000; i++) {
    const v = s.getView();
    if (v.awaiting === 'continue') { s.dispatch({ type: 'continue' }); continue; }
    break;
  }
  queue.push(s.snapshot());
}

while (queue.length && expanded < MAX_EXPAND) {
  const snap = queue.shift();
  const k0 = key(snap);
  if (visitedStates.has(k0)) continue;
  visitedStates.add(k0);
  expanded++;

  const s = createSession(compiled, { seed: 42 });
  s.restore(snap);
  // 推进到下一个交互点或结局
  let guard = 0;
  while (guard++ < 5000) {
    const v = s.getView();
    if (v.awaiting === 'continue') { s.dispatch({ type: 'continue' }); continue; }
    if (v.awaiting === 'ended') {
      const eid = v.ending && v.ending.id;
      if (!endings.has(eid)) endings.set(eid, { count: 0, sample: snap.state.nodeId });
      endings.get(eid).count++;
      break;
    }
    if (v.awaiting === 'choice') {
      const opts = v.choices.filter(c => !c.disabled);
      for (const o of opts) {
        const s2 = createSession(compiled, { seed: 42 });
        s2.restore(snapshotOf(s));
        s2.dispatch({ type: 'choose', optionId: o.id });
        queue.push(s2.snapshot());
      }
      break;
    }
    break;
  }
}

function snapshotOf(session) { return session.snapshot(); }

console.log('expanded states:', expanded, 'queue left:', queue.length);
console.log('reachable endings:', endings.size);
for (const [id, v] of [...endings.entries()].sort((a,b)=>b[1].count-a[1].count)) {
  console.log('  ', id, '×', v.count);
}

// 统计剧情里声明的所有结局
const declared = story.nodes.filter(n => n.type === 'end').map(n => n.ending);
const uniqDeclared = [...new Set(declared)];
console.log('\ndeclared endings:', uniqDeclared.length);
const missing = uniqDeclared.filter(e => !endings.has(e));
console.log('UNREACHABLE:', missing.length ? missing : 'none');
