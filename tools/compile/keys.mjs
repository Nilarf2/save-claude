import { readFile } from 'node:fs/promises';
import { compileStory } from '../../engine/packages/content/dist/index.js';
import { createSession } from '../../engine/packages/core/dist/index.js';

const story = JSON.parse(await readFile('web/story.json', 'utf8'));
const compiled = compileStory(story);

// 故意收集三把钥匙：C线->回HUB->D线->回HUB->E线->回HUB->A线
const plan = ['卷宗C', '返回命途回廊', '卷宗D', '返回命途回廊', '卷宗E', '返回命途回廊', '翻开正典'];
let pi = 0;
const s = createSession(compiled, { seed: 42 });
let r = s.start();
const trace = [];
for (let i = 0; i < 5000; i++) {
  const v = s.getView();
  if (v.awaiting === 'ended') {
    const st = s.snapshot().state;
    console.log('结局:', v.ending?.id);
    console.log('变量:', JSON.stringify(st.variables));
    console.log('标签:', st.tags.join(','));
    console.log('选择轨迹:', trace.join(' → '));
    process.exit(0);
  }
  if (v.awaiting === 'choice') {
    const opts = v.choices.filter(c => !c.disabled);
    let idx = 0;
    if (pi < plan.length) {
      const want = plan[pi];
      const found = opts.findIndex(o => o.text.includes(want));
      if (found >= 0) { idx = found; pi++; }
      else idx = 0;  // 没匹配到就选第一个
    }
    trace.push(opts[idx].text.slice(0, 16));
    r = s.dispatch({ type: 'choose', optionId: opts[idx].id });
    continue;
  }
  if (v.awaiting === 'continue') { r = s.dispatch({ type: 'continue' }); continue; }
  break;
}
console.log('未结束，卡在:', s.getView().nodeId);
