#!/usr/bin/env node
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { basename, resolve, join, isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import './review-data.js';
export const { analyzeGraph, validateEvidence } = globalThis.StoryMapReview;

/** This review tool accepts engine JSON and game extensions; it never executes modules. */
export function buildMap(story, meta = {}) {
  if (meta.sourceDocument !== undefined && (typeof meta.sourceDocument !== 'string' || isAbsolute(meta.sourceDocument) || /^[A-Za-z]:|^\\/.test(meta.sourceDocument) || meta.sourceDocument.split(/[\\/]/).includes('..'))) throw Error('源文档标签必须是项目相对路径');
  if (Object.values(meta.chapterLines ?? {}).some(line => !Number.isSafeInteger(line) || line < 1)) throw Error('章节源行号必须是正整数');
  if (!Array.isArray(story.nodes) || !story.nodes.length || typeof story.start !== 'string') throw Error('需要 nodes 数组和 start');
  if (typeof story.id !== 'string' || !story.id || typeof story.version !== 'string' || !story.version) throw Error('需要明确的故事 id 和 version');
  const ids = new Set();
  for (const node of story.nodes) {
    if (typeof node.id !== 'string' || typeof node.type !== 'string' || ids.has(node.id)) throw Error('节点 id/type 缺失或 id 重复');
    ids.add(node.id);
  }
  if (!ids.has(story.start)) throw Error('起点节点不存在');
  const edges = [];
  const add = (node, target, detail = {}) => {
    if (target === undefined) return;
    if (typeof target !== 'string' || !ids.has(target)) throw Error(`节点 ${node.id} 的目标不存在`);
    edges.push({ id: `edge-${edges.length}`, from: node.id, to: target, ...detail });
  };
  for (const node of story.nodes) {
    if (node.type === 'choice') {
      for (const option of node.options ?? []) add(node, option.next, { kind: 'choice', label: option.text, optionId: option.id, when: option.when, disabledWhen: option.disabledWhen, disabledReason: option.disabledReason, actions: option.actions ?? [] });
      add(node, node.fallback, { kind: 'fallback', label: '没有可选项' });
    } else if (node.type === 'branch') {
      for (const branch of node.branches ?? []) add(node, branch.next, { kind: 'branch', when: branch.when, label: '条件满足' });
      add(node, node.fallback, { kind: 'fallback', label: '其余情况' });
    } else if (node.type === 'module') {
      for (const [result, target] of Object.entries(node.outcomes ?? {})) add(node, target, { kind: 'module', label: result });
    } else if (node.type !== 'end') add(node, node.next, { kind: 'next', label: '继续' });
  }
  const data = { storyId: story.id, contentVersion: story.version, title: story.title, start: story.start, revision: meta.revision ?? '未指定', generatedAt: new Date().toISOString(), source: meta.source ?? 'story.json', sourceDocument: meta.sourceDocument ?? '', variables: story.variables ?? {}, chapterTitles: meta.chapterTitles ?? story.chapterTitles ?? {}, chapterLines: meta.chapterLines ?? {}, nodes: story.nodes, edges };
  data.analysis = analyzeGraph(data);
  return data;
}

async function main() {
  const { values } = parseArgs({ options: { story: { type: 'string' }, out: { type: 'string' }, meta: { type: 'string' }, revision: { type: 'string' }, trace: { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) { console.log('node tools/authoring/build-story-map.mjs --story story.json --out build/map [--meta source-map.json] [--revision version] [--trace check-route-output.json]'); return; }
  if (!values.story || !values.out) throw Error('必须明确指定 --story 和 --out');
  const input = resolve(values.story), out = resolve(values.out);
  const meta = values.meta ? JSON.parse(await readFile(resolve(values.meta), 'utf8')) : {};
  const data = buildMap(JSON.parse(await readFile(input, 'utf8')), { ...meta, source: basename(input), ...(values.revision ? { revision: values.revision } : {}) });
  if (values.trace) {
    const raw = await readFile(resolve(values.trace));
    if (raw.byteLength > 10 * 1024 * 1024) throw Error('路线文件超过 10 MiB');
    data.evidence = validateEvidence(JSON.parse(raw.toString('utf8')), data);
  }
  const pageFiles = ['index.html', 'map.css', 'map.js', 'review-data.js'];
  const files = [...pageFiles, 'story-map.json', 'story-map-data.js'];
  if (files.some(name => [input, ...(values.meta ? [resolve(values.meta)] : []), ...(values.trace ? [resolve(values.trace)] : [])].includes(join(out, name)))) throw Error('输出会覆盖输入剧情');
  await mkdir(out, { recursive: true });
  const json = JSON.stringify(data).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  await writeFile(join(out, 'story-map.json'), json + '\n');
  await writeFile(join(out, 'story-map-data.js'), 'globalThis.STORY_MAP = JSON.parse(' + JSON.stringify(json) + ');\n');
  for (const name of pageFiles) await copyFile(new URL(name, import.meta.url), join(out, name));
  console.log(`只读剧情地图：${out}/index.html (${data.nodes.length} 节点，${data.edges.length} 连线)`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
