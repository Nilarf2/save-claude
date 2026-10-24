#!/usr/bin/env node
// Controlled local vendor sync. Update the independent engine, then sync here;
// engine/ is a managed snapshot, not a second engine development checkout.
import { readFile, writeFile, mkdir, copyFile, mkdtemp, rename, rm, readdir, lstat, chmod, access } from 'node:fs/promises';
import { resolve, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const destination=resolve(root,'engine');
const packages=['module-api','content','save','core','web-adapter'];
const files=[
 'LICENSE',
 ...packages.flatMap(name=>[`packages/${name}/package.json`,`packages/${name}/dist/index.js`,`packages/${name}/dist/index.d.ts`]),
 'tools/authoring/compile-markdown.mjs','tools/authoring/build-story-map.mjs','tools/authoring/check-route.mjs',
 'tools/authoring/build-portrait-review.py','tools/authoring/README.md',
 'tools/authoring/story-map/index.html','tools/authoring/story-map/map.js','tools/authoring/story-map/map.css','tools/authoring/story-map/review-data.js',
 'tools/image/generate-image.py','tools/image/prepare-sprite.py','tools/image/requirements.txt','tools/image/README.md',
 'templates/prompts/background.md','templates/prompts/portrait.md','templates/prompts/story-review.md','templates/剧情填写模板.md',
 'docs/AI_AGENT_GUIDE.md','docs/ARCHITECTURE.md','docs/WORKFLOW.zh-CN.md',
];
const optionalFiles=['docs/REFERENCES.zh-CN.md'];
const exists=async path=>{try{await access(path);return true;}catch{return false;}};
const git=(cwd,args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
function publicRepository(remote){
 const ssh=/^git@([^:]+):(.+)$/.exec(remote);
 const url=new URL(ssh?`https://${ssh[1]}/${ssh[2]}`:remote);
 if(!['https:','http:'].includes(url.protocol))throw Error('Source origin must identify an HTTP(S) repository');
 url.username='';url.password='';url.search='';url.hash='';return url.href;
}
async function pathsUnder(dir,prefix=''){
 const result=[];
 for(const item of await readdir(dir,{withFileTypes:true})){
  const path=prefix?`${prefix}/${item.name}`:item.name;
  if(item.isSymbolicLink())throw Error('Snapshot contains an unexpected symlink: '+path);
  if(item.isDirectory())result.push(...await pathsUnder(resolve(dir,item.name),path));else result.push(path);
 }
 return result;
}
async function modeTree(dir,writable){
 // Git does not preserve read-only modes; metadata marks the snapshot on checkout.
 await chmod(dir,0o755);
 for(const item of await readdir(dir,{withFileTypes:true})){
  const path=resolve(dir,item.name);
  if(item.isDirectory())await modeTree(path,writable);else await chmod(path,writable?0o644:0o444);
 }
 await chmod(dir,writable?0o755:0o555);
}
async function removeTree(path){if(await exists(path)){await modeTree(path,true);await rm(path,{recursive:true,force:true});}}
async function checkSnapshot(){
 const meta=JSON.parse(await readFile(resolve(destination,'UPSTREAM.json'),'utf8'));
 if(meta.schemaVersion!==1||!meta.managedSnapshot||!/^https?:\/\//.test(meta.repository)||!/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(meta.commit)||typeof meta.dirty!=='boolean')throw Error('Invalid engine/UPSTREAM.json provenance');
 const actual=(await pathsUnder(destination)).sort();
 const selected=meta.files;
 if(!Array.isArray(selected)||new Set(selected).size!==selected.length||files.some(file=>!selected.includes(file))||selected.some(file=>![...files,...optionalFiles].includes(file)))throw Error('Invalid controlled engine file selection');
 const expected=[...selected,'UPSTREAM.json'].sort();
 if(JSON.stringify(actual)!==JSON.stringify(expected))throw Error('Engine snapshot differs from the controlled file list; resync it');
 for(const name of packages){
  const manifest=JSON.parse(await readFile(resolve(destination,`packages/${name}/package.json`),'utf8'));
  if(manifest.name!==`@text-adventure/${name}`)throw Error('Unexpected upstream package name: '+name);
  await import(manifest.name); // Verify bare package resolution from the game root.
 }
 console.log(JSON.stringify({engine:meta.repository,commit:meta.commit,version:meta.version,dirty:meta.dirty,files:selected.length,packageResolution:'passed'}));
}
async function sync(options){
 if(!options.source)throw Error('Pass an explicit --source local engine checkout');
 const source=resolve(options.source);
 if(source===destination||source.startsWith(destination+sep)||destination.startsWith(source+sep))throw Error('Source and snapshot must be independent directories');
 const commit=git(source,['rev-parse','HEAD']);
 const status=git(source,['status','--porcelain','--untracked-files=normal']);
 if(status&&!options['allow-dirty'])throw Error('Source checkout has uncommitted changes; commit first, or explicitly use --allow-dirty for a development snapshot');
 const repository=publicRepository(git(source,['remote','get-url','origin']));
 const upstream=JSON.parse(await readFile(resolve(source,'package.json'),'utf8'));
 const selected=[...files];
 for(const file of optionalFiles)if(await exists(resolve(source,file)))selected.push(file);
 const staged=await mkdtemp(resolve(root,'.engine-sync-'));
 let previous=null,archived=false;
 try{
  for(const file of selected){
   const from=resolve(source,file),to=resolve(staged,file);
   if(!(await lstat(from)).isFile())throw Error('Expected an upstream regular file: '+file);
   await mkdir(dirname(to),{recursive:true});await copyFile(from,to);
  }
  if(git(source,['rev-parse','HEAD'])!==commit||git(source,['status','--porcelain','--untracked-files=normal'])!==status)throw Error('Source changed during sync; retry after edits finish');
  const meta={schemaVersion:1,repository,commit,version:upstream.version,dirty:!!status,managedSnapshot:true,distribution:'Prebuilt JavaScript and explicitly selected reusable authoring files',files:selected};
  await writeFile(resolve(staged,'UPSTREAM.json'),JSON.stringify(meta,null,2)+'\n');
  if(await exists(destination)){
   const managed=await exists(resolve(destination,'UPSTREAM.json'));
   if(!managed){
    if(!options.archive)throw Error('Legacy engine must be archived first: pass --archive an external archive directory');
    const archive=resolve(options.archive);
    if(archive===root||archive.startsWith(root+sep))throw Error('Legacy archive must be outside the game workspace');
    await mkdir(archive,{recursive:true});previous=resolve(archive,'engine-before-vendor');
    if(await exists(previous))throw Error('Legacy archive already exists; choose a new --archive directory');
    await rename(destination,previous);archived=true;
   }else{previous=resolve(root,`.engine-previous-${process.pid}`);if(await exists(previous))throw Error('A previous sync is still present');await rename(destination,previous);}
  }
  try{await rename(staged,destination);}catch(error){if(previous)await rename(previous,destination);throw error;}
  if(previous&&!archived)await removeTree(previous);
  await modeTree(destination,false);
  console.log(JSON.stringify({repository,commit,version:meta.version,dirty:meta.dirty,files:selected.length,legacyArchived:archived}));
 }finally{await removeTree(staged);}
}
const {values}=parseArgs({options:{source:{type:'string'},archive:{type:'string'},'allow-dirty':{type:'boolean'},check:{type:'boolean'},help:{type:'boolean'}}});
try{
 if(values.help)console.log('node tools/sync-engine.mjs --source /path/to/local/engine [--allow-dirty] [--archive /path/to/external/archive]\nnode tools/sync-engine.mjs --check\nBuild the source checkout first. No network access, dependency trees or credentials are copied.');
 else if(values.check)await checkSnapshot();else await sync(values);
}catch(error){console.error(error.message);process.exitCode=1;}
