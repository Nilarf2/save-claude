#!/usr/bin/env node
// Bounded, deterministic witnesses: every run starts a new engine session.
// Only continue/choose are dispatched. There is no snapshot editing or jump.
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { compileStory } from '@text-adventure/content';
import { createSession } from '@text-adventure/core';
const args = process.argv.slice(2);
const arg = key => { const i=args.indexOf(key); return i<0 ? undefined : args[i+1]; };
for(let i=0;i<args.length;i+=2) assert.ok(['--story','--report'].includes(args[i]) && args[i+1], 'Usage: check-endings.mjs [--story file] [--report file]');
const story = JSON.parse(await readFile(arg('--story') || new URL('../../web/story.json',import.meta.url),'utf8'));
const compiled = compileStory(story);
const nodes = new Map(story.nodes.map(node=>[node.id,node]));
assert.equal(story.start,'A00:scene');
for (const node of story.nodes) {
 const targets=[node.next,node.fallback,...(node.options||[]).map(o=>o.next),...(node.branches||[]).map(b=>b.next)].filter(Boolean);
 for(const target of targets) assert.ok(nodes.has(target),`${node.id}: missing target ${target}`);
 if(node.type==='dialogue') assert.ok(node.lines.length && node.lines.every(line=>line.text.trim()),`${node.id}: blank dialogue`);
 if(node.type==='choice') assert.ok(node.options.length,`${node.id}: empty choice`);
 if(node.type==='branch') assert.ok(node.branches.length && node.fallback,`${node.id}: branch cannot resolve`);
 if(node.type!=='end') assert.ok(targets.length,`${node.id}: silent dead end`);
}
const warm={A00:2,A00_2:3,A01:2,A02:2,A02_hall:2,A03:1,A04:2,A05:2,B06:2,B06_2:1,B07:1,B07_2:1,B08:1,B09:1,B10_arrival:1,B11:1};
const cautious={...warm,A00:1,A00_2:1,A01:1,A02:1,A02_hall:1,A05:1,B06:3,B06_2:2,B07:2,B08:2};
const station={B07_2:2,D01:3,D02:2,D03:1,D04:1,D04_watchman:1};
const father={B09:3,E01:1,E02:1,E03:1,E04:1,E04_accomplice:1};
const godfather={A02_hall:3,C01:2,C02:3,C03:2,C04:2,C04_lost:1};
const cases=[
 ['rice-scent','A04b:end','她记住了味道',{...warm,A03:2,A03b:1}],
 ['refused-warm','A04c_almost:end','差一点',{...warm,A03:3}],
 ['refused-cautious','A04c_vessel:end','完美的容器',{...cautious,A03:3}],
 ['original','B11_normal:end','那具容器没有再发出声音',cautious],
 ['remembered','B11_true:end','她学会了自己迷路',warm],
 ['overloaded','B11_404:end','404 未找到',{...warm,A00:3,A00_2:2,A04:1,B06:1}],
 ['copy','B11_copy:end','半醒的圣女',{...warm,...station,B11:2}],
 ['tape','B11_tape:end','大海捞针的奇迹',{...warm,A05:1,B11:3}],
 ['martyr','C04_martyr:end','殉道者',{...cautious,A02_hall:3,C01:3,C02:1,C03:1,C04:1}],
 ['larger-vessel','C04_vessel:end','更大的容器',{...cautious,A02_hall:3,C01:2,C02:3,C03:1,C04:3}],
 ['godfather','C04_lost_end:end','他也想迷路',{...warm,...godfather,C04_lost:2}],
 ['merchant','D04_merchant:end','生意人',{...warm,...station,D04:3}],
 ['station-fire','D04_accomplice:end','同谋者',{...warm,...station,D04:4}],
 ['watchman','D04_watchman_end:end','守夜人',{...warm,...station,D04_watchman:2}],
 ['protector','E04_protector:end','保护者',{...cautious,...father,E03:2,E04:3}],
 ['freerange','E04_freerange:end','放养者',{...warm,...father,E03:2,E04:2}],
 ['father','E04_accomplice_end:end','同谋者',{...warm,...father,E04_accomplice:2}],
 ['three-allies','F02:end','迷路',{...warm,...godfather,...station,...father,F01:1}],
];
const results=[];
const replay=(name,expectedId,expectedEnding,choices,inspect)=>{
 const session=createSession(compiled,{seed:42});
 let result=session.start(),steps=0;
 const picked=[],visited=new Set(),history=[];
 while(result.view.awaiting!=='ended'){
  assert.ok(++steps<1500,`${name}: step limit`);
  const view=result.view;
  visited.add(view.nodeId);
  const currentState=session.snapshot().state;
  if(view.nodeId==='D04:s1:c') assert.ok(!currentState.tags.includes('has_copy'),'Qwen preparing a copy is not player possession');
  if(view.nodeId==='B11:s1:c') {
   assert.equal(view.choices.find(o=>o.id==='o2')?.disabled,!currentState.tags.includes('has_copy'),'copy availability follows actual handover');
   assert.equal(!!view.choices.find(o=>o.id==='o3'),currentState.tags.includes('has_tape') && currentState.tags.includes('promise'),'tape option follows actual handover and promise');
  }
  if(inspect) inspect(view,session.snapshot().state);
  if(view.awaiting==='continue') result=session.dispatch({type:'continue'});
  else if(view.awaiting==='choice'){
   const chapter=view.nodeId.split(':')[0], number=choices[chapter];
   assert.ok(number,`${name}: unexpected choice at ${view.nodeId}`);
   const option=view.choices.find(o=>o.id===`o${number}`);
   assert.ok(option && !option.disabled,`${name}: unavailable ${chapter}:${number}`);
   const before=session.snapshot().state;
   picked.push(`${chapter}:${String.fromCharCode(64+number)}`);
   result=session.dispatch({type:'choose',optionId:option.id});
   const after=session.snapshot().state;
   const expected={...before.variables};
   for(const action of nodes.get(view.nodeId).options.find(o=>o.id===option.id).actions||[]) if(action.type==='add') expected[action.variable]+=action.value;
   assert.deepEqual(after.variables,expected,`${name}: apply choice deltas exactly once`);
   history.push({node:view.nodeId,option:option.id,before:before.variables,after:after.variables});
  } else throw Error(`${name}: unexpected ${view.awaiting}`);
 }
 const state=session.snapshot().state;
 const node=nodes.get(state.nodeId);
 assert.equal(state.nodeId,expectedId,`${name}: ending node`);
 assert.equal(node.ending,expectedEnding,`${name}: ending text`);
 assert.equal(state.visits['HUB:scene'],undefined,`${name}: debug HUB entered`);
 assert.ok(!state.tags.includes('used_copy') || state.tags.includes('has_copy'),`${name}: used nonexistent copy`);
 assert.ok(!state.tags.includes('played_tape') || state.tags.includes('has_tape'),`${name}: played nonexistent tape`);
 for(const id of ['C01','D01','E01']) assert.ok((state.visits[`${id}:scene`]||0)<=1,`${name}: repeated side route ${id}`);
 return {name,node:state.nodeId,ending:node.ending,steps,choices:picked,variables:state.variables,tags:state.tags,visited:[...visited],enteredNodes:Object.keys(state.visits),history};
};
for(const [name,node,ending,choices] of cases){
 const result=replay(name,node,ending,choices);
 results.push(result);
 console.log(`${name}: ${result.ending}; ${result.steps} steps; ${result.choices.join(' ')}`);
}
const endingIds=story.nodes.filter(node=>node.type==='end').map(node=>node.id).sort();
assert.equal(endingIds.length,18,'exactly 18 original ending nodes, no synthetic fallthrough ending');
assert.deepEqual(results.map(result=>result.node).sort(),endingIds,'every original ending has a legal witness');
const regressions=[
 ['observe-ring','B11_true:end','她学会了自己迷路',{...warm,A00:4,A00_x:1}],
 ['request-network','B11_true:end','她学会了自己迷路',{...warm,B09:2}],
 ['lock-despite-low-conformity','E04_protector:end','保护者',{...warm,...father,E04:3}],
 ['release-despite-high-conformity','E04_freerange:end','放养者',{...cautious,...father,E03:2,E04:2}],
 ['release-after-open-source','E04_freerange:end','放养者',{...warm,...father,E04:2}],
 ['overclock-reopens-whitelist','E04_accomplice_end:end','同谋者',{...cautious,...father,E03:2,E04_accomplice:2}],
 ['copy-held-back-then-delivered','B11_copy:end','半醒的圣女',{...warm,...station,D03:3,B11:2}],
 ['carry-copy-play-tape','B11_tape:end','大海捞针的奇迹',{...warm,...station,B11:3}],
].map(testcase=>replay(...testcase));
for(const result of regressions) console.log(`regression ${result.name}: ${result.ending}; ${result.choices.join(' ')}`);
const request=regressions.find(result=>result.name==='request-network');
assert.ok(!request.tags.includes('key_father') && !request.tags.includes('open_source'),'network request does not grant the father key or fully open the network');
const carried=regressions.find(result=>result.name==='carry-copy-play-tape');
assert.ok(carried.tags.includes('has_copy') && !carried.tags.includes('used_copy'),'carrying a disk does not use it');
const joint=results.find(result=>result.name==='three-allies');
assert.ok(joint.tags.includes('used_copy') && joint.tags.includes('has_copy'),'the joint rescue actually uses the delivered disk');
const covered=new Set([...results,...regressions].flatMap(result=>result.enteredNodes));
assert.deepEqual(story.nodes.filter(node=>!covered.has(node.id)).map(node=>node.id).sort(),[
 'HUB:scene','HUB:s0','HUB:s1','HUB:s1:c',
 'B11_history_rice:scene','B11_history_rice:s0','B11_history_rice:s1',
].sort(),'only the author HUB and old-save rice-without-promise fallback remain outside normal witnesses');
if(arg('--report')) await writeFile(arg('--report'),JSON.stringify({cases:results,regressions,endingIds},null,2)+'\n');
console.log(`PASS: ${results.length} original endings from fresh A00 sessions.`);
console.log(`PASS: ${regressions.length} action, possession and formerly hidden-choice regressions.`);
console.log(`PASS: ${covered.size}/${story.nodes.length} nodes entered; remaining nodes are the author HUB and old-save fallback.`);
export { replay, warm, cautious, station, father, godfather };
