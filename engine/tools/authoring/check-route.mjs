#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { compileStory } from '../../packages/content/dist/index.js';
import { createSession } from '../../packages/core/dist/index.js';

const { values } = parseArgs({ options: { story: { type: 'string' }, route: { type: 'string' }, out: { type: 'string' }, modules: { type: 'string' }, help: { type: 'boolean' } } });
if (values.help) { console.log('node tools/authoring/check-route.mjs --story story.json --route route.json --out build/route.json [--modules ./game-modules.mjs]'); process.exit(0); }
try {
  if (!values.story || !values.route || !values.out) throw Error('必须指定 --story、--route 和 --out');
  if ([values.story, values.route, values.modules].filter(Boolean).some(file => resolve(file) === resolve(values.out))) throw Error('输出不得覆盖输入');
  const story = JSON.parse(await readFile(values.story, 'utf8')), route = JSON.parse(await readFile(values.route, 'utf8'));
  const modules = values.modules ? (await import(pathToFileURL(resolve(values.modules)).href)).default : [];
  const session = createSession(compileStory(story, modules), { seed: route.seed ?? 1 });
  const trace = [session.start().view];
  for (const [index, step] of route.steps.entries()) {
    const view = session.getView();
    assert.equal(view.nodeId, step.node, `第 ${index+1} 步节点不符`);
    if (step.command.type === 'choose') assert.ok(view.choices.some(c => c.id === step.command.optionId && !c.disabled), `第 ${index+1} 步选项不可选`);
    trace.push(session.dispatch(step.command).view);
  }
  const snapshot = session.snapshot();
  assert.equal(session.getView().awaiting, 'ended', '路线必须到达实际结局');
  assert.equal(snapshot.state.ending, route.ending, '结局不符');
  for (const [name, expected] of Object.entries(route.variables ?? {})) assert.equal(snapshot.state.variables[name], expected, `变量 ${name} 不符`);
  for (const tag of route.tags ?? []) assert.ok(snapshot.state.tags.includes(tag), `缺少标签 ${tag}`);
  await mkdir(dirname(resolve(values.out)), { recursive: true });
  await writeFile(values.out, JSON.stringify({ storyId: story.id, contentVersion: story.version, seed: route.seed ?? 1, ending: snapshot.state.ending, trace, snapshot }, null, 2)+'\n');
  console.log(`路线通过：${route.ending} (${trace.length} 个玩家停顿状态)`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
