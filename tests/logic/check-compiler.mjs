#!/usr/bin/env node
// In-memory compiler regressions use the same vendored implementation as the game.
// No temporary project tree or runtime snapshot can be overwritten.
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { compileMarkdown } from '../../engine/tools/authoring/compile-markdown.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const [source,planText,portraits,config]=await Promise.all(['story/03-story.md','story/stage-plan.json','web/character-portraits.json','tools/compile/game-config.json'].map(async file=>{const text=await readFile(resolve(root,file),'utf8');return file.endsWith('.json')&&file!=='story/stage-plan.json'?JSON.parse(text):text;}));
 let checks=0;
 const run=async(name,changeSource,changePlan,expectedError)=>{
  const plan=JSON.parse(planText);
  if(changePlan) changePlan(plan);
  const compile=()=>compileMarkdown(changeSource?changeSource(source):source,{...config,portraits,stage:plan});
  if(expectedError){
   assert.throws(compile,expectedError,name+' rejects malformed source');
  }else{
   const story=compile();
   assert.equal(story.nodes.filter(node=>node.type==='end').length,18,'no extra synthetic ending');
   if(name==='explicit-tags-only') assert.ok(!story.nodes.find(node=>node.id==='A00:s1:c').options.find(option=>option.id==='o2').actions.some(action=>action.tag==='promise'),'mentioning a promise must not make it');
   if(name==='replace-present') assert.deepEqual(story.nodes.find(node=>node.id==='A00:s0').lines[7].stage.slots,{left:'claude',right:'godfather'});
  }
  console.log('PASS: '+name);checks++;
 };
 await run('explicit-tags-only',text=>text.replace('B. 维持原状，将视线停在未动一口的红茶水面上','B. 暂时不拉钩，只观察红茶'));
 await run('unknown-variable',text=>text.replace('{humanity+5, conformity-3}','{humanitty+5, conformity-3}'),null,/Unknown variable humanitty/);
 await run('unknown-tag',text=>text.replace('[ate_rice] → A04','[ate_ric] → A04'),null,/Unknown tag ate_ric/);
 await run('invalid-delta',text=>text.replace('{humanity+5, conformity-3}','{humanity++5, conformity-3}'),null,/Invalid variable delta/);
 await run('missing-fallback',text=>text.replace('[*] → A04c_vessel',''),null,/explicit \[\*\] fallback/);
 await run('duplicate-slot',null,plan=>{plan.chapters.A00.default={...plan.chapters.A00.default,present:['claude'],slots:{left:'claude',right:'claude'}};},/Duplicate stage slot/);
 await run('negative-stage-index',null,plan=>{plan.chapters.A00.nodes['A00:s0'].events['-1']={present:[]};},/Unknown stage line index/);
 await run('replace-present',null,plan=>{plan.chapters.A00.nodes['A00:s0'].events['7']={present:['claude','godfather'],focus:'claude'};});
 console.log(`PASS: ${checks} bounded compiler regressions.`);
