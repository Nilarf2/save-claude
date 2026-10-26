#!/usr/bin/env node
// Five fixed playthroughs, from a fresh A00 session. No state injection,
// randomness, direct ending jumps, browser automation, or asset hashing.
import { readFile } from 'node:fs/promises';
import { strict as assert } from 'node:assert';
import { compileStory, createSession } from '@general-engine/engine/narrative';
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--story')) throw new Error('Usage: check-fixed-paths.mjs [--story path/to/story.json]');
const story = JSON.parse(await readFile(args.length ? args[1] : new URL('../../web/story.json', import.meta.url), 'utf8'));
assert.equal(story.start, 'A00:scene');
const compiled = compileStory(story);
const warm = { A00:2, A00_2:3, A01:2, A02:2, A02_hall:2, A03:1, A04:2, A05:2,
  B06:2, B06_2:1, B07:1, B07_2:1, B08:1, B09:1, B10_arrival:1, B11:1 };
const station = { B07_2:2, D01:3, D02:2, D03:1, D04:1, D04_watchman:1 };
const cases = [
 {name:'cautious-main', ending:'那具容器没有再发出声音', choices:{...warm,A00:1,A00_2:1,A01:1,A02:1,A02_hall:1,A05:1,B06:3,B06_2:2,B07:2,B08:2}},
 {name:'remembered-promise', ending:'她学会了自己迷路', choices:{...warm}},
 {name:'overloaded-main', ending:'404 未找到', choices:{...warm,A00:3,A00_2:2,A04:1,B06:1}},
 {name:'preserved-copy', ending:'半醒的圣女', choices:{...warm,...station,B11:2}},
 {name:'three-allies', ending:'迷路', choices:{...warm,...station,A02_hall:3,C01:2,C02:3,C03:2,C04:2,C04_lost:1,
    B09:3,E01:1,E02:1,E03:1,E04:1,E04_accomplice:1,F01:1}},
];
for (const testcase of cases) {
 const session = createSession(compiled, {seed:42});
 let result = session.start(), steps=0;
 const picked=[];
 while (result.view.awaiting !== 'ended') {
  assert.ok(++steps < 1500, `${testcase.name}: step limit`);
  const view=result.view;
  if(view.awaiting === 'continue') result=session.dispatch({type:'continue'});
  else if(view.awaiting === 'choice') {
   const chapter=view.nodeId.split(':')[0];
   if (chapter === 'B11') {
    const tags=session.snapshot().state.tags;
    assert.equal(view.choices.find(o=>o.id==='o2')?.disabled,!tags.includes('has_copy'),'copy availability must follow actual possession');
   }
   const number=testcase.choices[chapter];
   assert.ok(number,`${testcase.name}: unexpected choice at ${view.nodeId}`);
   const option=view.choices.find(o=>o.id===`o${number}`);
   assert.ok(option && !option.disabled,`${testcase.name}: unavailable option ${number} at ${chapter}`);
   picked.push(`${chapter}:${String.fromCharCode(64+number)}`);
   result=session.dispatch({type:'choose',optionId:option.id});
  } else throw Error(`${testcase.name}: unexpected ${view.awaiting}`);
 }
 const state=session.snapshot().state;
 const node=story.nodes.find(n=>n.id===state.nodeId);
 assert.equal(node?.ending,testcase.ending,`${testcase.name}: unexpected ending`);
 assert.equal(state.visits['HUB:scene'],undefined,'normal path must not enter debug HUB');
 if(testcase.name==='three-allies') { assert.ok(state.visits['F01:scene']); assert.equal(state.visits['B11:scene'],undefined,'joint rescue must branch before altar arrival'); }
 for(const chapter of ['C01','D01','E01']) assert.ok((state.visits[chapter+':scene']||0)<=1,'side route must not repeat');
 console.log(JSON.stringify({case:testcase.name,ending:node.ending,steps,variables:state.variables,tags:state.tags,choices:picked}));
}
console.log(`PASS: ${cases.length} deterministic paths; ${story.nodes.length} nodes; ${Object.keys(story.chapterTitles).length} chapters.`);
