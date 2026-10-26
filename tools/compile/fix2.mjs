import { readFile } from 'node:fs/promises';
import { compileStory, createSession } from '@general-engine/engine/narrative';

const story = JSON.parse(await readFile('web/story.json', 'utf8'));
const compiled = compileStory(story);

// 走 A 线，每次选让 contamination 最大的选项
function play(pickFn, label) {
  const s = createSession(compiled, { seed: 42 });
  let r = s.start();
  const trace = [];
  for (let i = 0; i < 3000; i++) {
    const v = s.getView();
    if (v.awaiting === 'ended') {
      const st = s.snapshot().state;
      return { label, ending: v.ending?.id, vars: st.variables, tags: st.tags, trace };
    }
    if (v.awaiting === 'choice') {
      const opts = v.choices.filter(c => !c.disabled);
      const idx = pickFn(opts, trace);
      trace.push(opts[idx].text.slice(0, 22));
      r = s.dispatch({ type: 'choose', optionId: opts[idx].id });
      continue;
    }
    if (v.awaiting === 'continue') { r = s.dispatch({ type: 'continue' }); continue; }
    break;
  }
  return { label, error: 'stuck' };
}

// 在 HUB 选 A（进入圣女线），其他都选第一个
function aLine(opts) {
  const hub = opts.find(o => o.text.includes('翻开正典'));
  if (hub) return opts.indexOf(hub);
  return 0;
}
// A 线里专门挑污染高的
function maxContam(opts, trace) {
  const hub = opts.find(o => o.text.includes('翻开正典'));
  if (hub) return opts.indexOf(hub);
  // 关键字：问卡尺误差 / 再看白鸽 / 吃下去 / 大声说梦话
  const keys = ['卡尺的测量误差', '白鸽飞向', '吃下去', '十句更离谱'];
  for (const k of keys) {
    const i = opts.findIndex(o => o.text.includes(k));
    if (i >= 0) return i;
  }
  return opts.length - 1;
}

const res1 = play(aLine, 'A线-全第一个');
console.log(JSON.stringify({ ...res1, trace: res1.trace.slice(0,8) }));
const res2 = play(maxContam, 'A线-最大污染');
console.log(JSON.stringify({ ...res2, trace: res2.trace.slice(0,8) }));
