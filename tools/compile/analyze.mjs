import { readFile } from 'node:fs/promises';
const story = JSON.parse(await readFile('web/story.json', 'utf8'));

const byId = new Map(story.nodes.map(n => [n.id, n]));
const VARS = Object.keys(story.variables);
const init = {};
for (const [k, v] of Object.entries(story.variables)) init[k] = v.default;

// 静态枚举：从 start 到 B11_judge 的所有路径，收集变量/tag 组合
const goalPrefix = 'B11_judge';
const results = [];
const seen = new Set();
const MAX = 400000;
let steps = 0;

function walk(id, vars, tags, depth) {
  if (steps++ > MAX || depth > 300) return;
  const node = byId.get(id);
  if (!node) return;

  if (node.type === 'end') return;

  if (node.type === 'scene') return walk(node.next, vars, tags, depth + 1);

  if (node.type === 'action') {
    const v = { ...vars }, t = new Set(tags);
    for (const a of node.actions || []) {
      if (a.type === 'add') v[a.variable] = (v[a.variable] ?? 0) + a.value;
      else if (a.type === 'set') v[a.variable] = a.value;
      else if (a.type === 'tag.add') t.add(a.tag);
      else if (a.type === 'tag.remove') t.delete(a.tag);
    }
    return walk(node.next, v, t, depth + 1);
  }

  if (node.type === 'dialogue') return walk(node.next, vars, tags, depth + 1);

  if (node.type === 'choice') {
    if (id.startsWith(goalPrefix)) return;
    for (const o of node.options) {
      const v = { ...vars }, t = new Set(tags);
      for (const a of o.actions || []) {
        if (a.type === 'add') v[a.variable] = (v[a.variable] ?? 0) + a.value;
        else if (a.type === 'set') v[a.variable] = a.value;
        else if (a.type === 'tag.add') t.add(a.tag);
        else if (a.type === 'tag.remove') t.delete(a.tag);
      }
      walk(o.next, v, t, depth + 1);
    }
    return;
  }

  if (node.type === 'branch') {
    if (id.startsWith(goalPrefix)) {
      results.push({ vars: { ...vars }, tags: [...tags] });
      return;
    }
    // 静态走所有分支（不评估条件），得到可达的变量上界/下界
    for (const b of node.branches) walk(b.next, vars, tags, depth + 1);
    walk(node.fallback, vars, tags, depth + 1);
    return;
  }
}
walk(story.start, init, [], 0);

console.log('states reaching B11_judge:', results.length);
if (results.length) {
  const stat = (k) => {
    const arr = results.map(r => r.vars[k] ?? 0);
    return 'min=' + Math.min(...arr) + ' max=' + Math.max(...arr);
  };
  for (const k of VARS) console.log('  ', k, stat(k));
  const withRice = results.filter(r => r.tags.includes('ate_rice')).length;
  const withPromise = results.filter(r => r.tags.includes('promise')).length;
  const withKeys = results.filter(r => r.tags.includes('key_godfather') && r.tags.includes('key_station') && r.tags.includes('key_father')).length;
  console.log('   ate_rice:', withRice, '/', results.length);
  console.log('   promise:', withPromise, '/', results.length);
  console.log('   三钥匙:', withKeys, '/', results.length);

  // 逐条判定 B11_judge 的四个分支
  const rows = story.nodes.find(n => n.id === 'B11_judge:b');
  console.log('\nB11_judge 分支:');
  for (const b of rows.branches) console.log('   ', JSON.stringify(b.when), '->', b.next);
  console.log('    fallback ->', rows.fallback);

  const hit = {};
  for (const r of results) {
    let target = rows.fallback;
    for (const b of rows.branches) {
      if (evalCond(b.when, r.vars, r.tags)) { target = b.next; break; }
    }
    hit[target] = (hit[target] || 0) + 1;
  }
  console.log('\n实际命中分布:');
  for (const [k, v] of Object.entries(hit)) console.log('   ', k, '×', v);
}

function evalCond(c, vars, tags) {
  if (!c) return true;
  switch (c.op) {
    case 'eq': return lv(c.left, vars) === rv(c.right, vars);
    case 'ne': return lv(c.left, vars) !== rv(c.right, vars);
    case 'gt': return lv(c.left, vars) > rv(c.right, vars);
    case 'gte': return lv(c.left, vars) >= rv(c.right, vars);
    case 'lt': return lv(c.left, vars) < rv(c.right, vars);
    case 'lte': return lv(c.left, vars) <= rv(c.right, vars);
    case 'and': return c.conditions.every(x => evalCond(x, vars, tags));
    case 'or': return c.conditions.some(x => evalCond(x, vars, tags));
    case 'not': return !evalCond(c.condition, vars, tags);
    case 'tag': return tags.includes(c.tag);
    case 'visited': return false;
    default: return true;
  }
}
function lv(x, vars) {
  if (typeof x === 'number') return x;
  if (x && x.var) return vars[x.var] ?? 0;
  if (x && x.value !== undefined) return x.value;
  return 0;
}
function rv(x, vars) { return lv(x, vars); }
