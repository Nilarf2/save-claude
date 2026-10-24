import { readFile } from 'node:fs/promises';
const story = JSON.parse(await readFile('web/story.json', 'utf8'));
const bgs = new Set(), bgms = new Set(), sprites = new Set();
for (const n of story.nodes) {
  if (n.background) bgs.add(n.background);
  if (n.music) bgms.add(n.music);
  if (n.ambience) bgms.add(n.ambience);
}
for (const n of story.nodes) {
  for (const l of n.lines || []) if (l.speaker) sprites.add(l.speaker);
}
console.log('=== 场景 (' + bgs.size + ') ===');
console.log([...bgs].sort().join('\n'));
console.log('\n=== 音乐 (' + bgms.size + ') ===');
console.log([...bgms].sort().join('\n'));
console.log('\n=== 说话角色 (' + sprites.size + ') ===');
console.log([...sprites].sort().join('\n'));
console.log('\n=== 表情 ===');
const ex = new Set();
for (const n of story.nodes) for (const l of n.lines || []) if (l.expression) ex.add(l.speaker + ':' + l.expression);
console.log([...ex].sort().join('\n'));
