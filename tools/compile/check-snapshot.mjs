#!/usr/bin/env node
// Verify that the committed runtime story matches the current game sources.
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { compileMarkdown } from './compile-markdown.mjs';
import { compileStory } from '@general-engine/engine/narrative';
const configPath=fileURLToPath(new URL('./game-config.json',import.meta.url));
const config=JSON.parse(await readFile(configPath,'utf8'));
const read=async key=>readFile(resolve(dirname(configPath),config[key]),'utf8');
const [source,portraits,stage,snapshot]=await Promise.all([read('source'),read('portraits'),read('stage'),read('out')]);
const expected=compileMarkdown(source,{...config,portraits:JSON.parse(portraits),stage:JSON.parse(stage)});
const actual=JSON.parse(snapshot);
assert.deepEqual(actual,expected,'web/story.json is stale; run npm run build');
compileStory(actual);
console.log(`PASS: source and runtime snapshot agree (${actual.nodes.length} nodes, ${actual.nodes.filter(node=>node.type==='end').length} endings).`);
