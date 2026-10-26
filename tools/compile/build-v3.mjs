#!/usr/bin/env node
// Game configuration only; Markdown parsing and compilation live upstream.
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileMarkdownFile } from './compile-markdown.mjs';

const args=process.argv.slice(2);
if(args.length&&(args.length!==2||args[0]!=='--out'))throw Error('Usage: node tools/compile/build-v3.mjs [--out path/to/story.json]');
const configPath=fileURLToPath(new URL('./game-config.json',import.meta.url));
const config=JSON.parse(await readFile(configPath,'utf8'));
for(const key of ['source','portraits','stage','out','assetsRoot'])if(config[key])config[key]=resolve(dirname(configPath),config[key]);
if(args.length)config.out=resolve(process.cwd(),args[1]);
const story=await compileMarkdownFile(config);
console.log(`Compiled ${story.id}: ${Object.keys(story.chapterTitles).length} chapters, ${story.nodes.length} nodes, ${story.nodes.filter(node=>node.type==='end').length} endings.`);
