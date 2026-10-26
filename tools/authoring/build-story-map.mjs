#!/usr/bin/env node
// Keep source locations and default output here; the static map is a game tool.
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
if(process.argv.length>3)throw Error('Usage: node tools/authoring/build-story-map.mjs [output-directory]');
const out=resolve(process.argv[2]||resolve(root,'../save-claude-story-map'));
const source=(await readFile(resolve(root,'story/03-story.md'),'utf8')).split('\n');
const chapterLines={};
source.forEach((line,index)=>{const match=/^## ([A-Za-z][\w-]*) /.exec(line);if(match)chapterLines[match[1]]=index+1;});
let revision='working-copy';
try{revision=execFileSync('git',['rev-parse','--short','HEAD'],{cwd:root,encoding:'utf8'}).trim();}catch{}
const temp=await mkdtemp(resolve(tmpdir(),'save-claude-story-map-'));
try{
 const meta=resolve(temp,'source-map.json');
 await writeFile(meta,JSON.stringify({sourceDocument:'story/03-story.md',chapterLines,revision}));
 execFileSync(process.execPath,[resolve(root,'tools/authoring/story-map/generate.mjs'),'--story',resolve(root,'web/story.json'),'--out',out,'--meta',meta,'--revision',revision],{stdio:'inherit'});
}finally{await rm(temp,{recursive:true,force:true});}
