#!/usr/bin/env node
// Refresh the checked-in, Narrative-only package from an explicit clean source
// checkout. No absolute source path is written into the game repository.
import { createHash } from 'node:crypto';
import { cp, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tarballPath = resolve(root, 'vendor/general-engine-narrative.tgz');
const packagePath = resolve(root, 'vendor/general-engine/package.json');
const provenancePath = resolve(root, 'vendor/general-engine/PROVENANCE.json');
const lockPath = resolve(root, 'package-lock.json');
const { values } = parseArgs({ options: { source: { type: 'string' }, help: { type: 'boolean' } } });
if (values.help) {
  console.log('node tools/sync-general-engine.mjs --source /absolute/path/to/general-engine');
} else {
  if (!values.source || !isAbsolute(values.source)) throw new Error('Pass an explicit absolute --source checkout path');
  const source = resolve(values.source);
  const git = args => execFileSync('git', args, { cwd: source, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const commit = git(['rev-parse', 'HEAD']);
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('General Engine source must be a committed Git checkout');
  if (git(['status', '--porcelain', '--untracked-files=normal'])) throw new Error('General Engine checkout must be clean before syncing');
  const remote = git(['remote', 'get-url', 'origin']);
  const repository = remote.replace(/^git@github\.com:/, 'https://github.com/').replace(/\.git$/, '');
  if (repository !== 'https://github.com/Nilarf2/general-engine') throw new Error('Unexpected General Engine origin');

  const upstream = JSON.parse(await readFile(resolve(source, 'package.json'), 'utf8'));
  const packageRoot = await mkdtemp(resolve(tmpdir(), 'general-engine-narrative-'));
  const packed = resolve(packageRoot, 'packed');
  const stage = resolve(packageRoot, 'package');
  try {
    const cleanSource = resolve(packageRoot, 'source');
    await mkdir(cleanSource, { recursive: true });
    const archive = execFileSync('git', ['archive', '--format=tar', 'HEAD', 'src/narrative'], { cwd: source, maxBuffer: 16 * 1024 * 1024 });
    execFileSync('tar', ['-x', '-C', cleanSource], { input: archive, stdio: ['pipe', 'ignore', 'inherit'] });
    const input = resolve(cleanSource, 'src/narrative');
    const output = resolve(stage, 'lib');
    execFileSync(process.execPath, [
      resolve(source, 'node_modules/typescript/bin/tsc'), '--ignoreConfig', '--target', 'ES2022', '--module', 'ESNext',
      '--moduleResolution', 'Bundler', '--strict', '--skipLibCheck', '--declaration', '--sourceMap', 'false',
      '--outDir', output, '--rootDir', resolve(cleanSource, 'src'), resolve(input, 'index.ts'),
    ], { cwd: source, stdio: 'inherit' });
    await cp(resolve(source, 'LICENSE'), resolve(stage, 'LICENSE'));
    await cp(resolve(source, 'NOTICE.md'), resolve(stage, 'NOTICE.md'));
    await mkdir(packed, { recursive: true });
    const manifest = {
      name: '@general-engine/engine', version: upstream.version, private: true, type: 'module', license: 'MIT',
      exports: { './narrative': { types: './lib/narrative/index.d.ts', import: './lib/narrative/index.js' } },
      files: ['lib/narrative', 'LICENSE', 'NOTICE.md'],
    };
    await writeFile(resolve(stage, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
    const entries = JSON.parse(execFileSync('npm', ['pack', stage, '--ignore-scripts', '--json', '--pack-destination', packed], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }));
    if (entries.length !== 1 || !entries[0].filename) throw new Error('npm pack did not produce one General Engine package');
    const builtTarball = resolve(packed, entries[0].filename);
    const bytes = await readFile(builtTarball);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
    const nextTarball = resolve(packageRoot, 'general-engine-narrative.tgz');
    await writeFile(nextTarball, bytes);

    if (git(['rev-parse', 'HEAD']) !== commit || git(['status', '--porcelain', '--untracked-files=normal'])) throw new Error('General Engine source changed during sync');

    const meta = {
      schemaVersion: 1,
      repository: `${repository}.git`,
      commit,
      version: upstream.version,
      package: '@general-engine/engine',
      entry: './narrative',
      distribution: 'Controlled local tarball containing the built Narrative public entry',
      sha256,
    };
    const lock = JSON.parse(await readFile(lockPath, 'utf8'));
    const locked = lock.packages['node_modules/@general-engine/engine'];
    if (!locked) throw new Error('General Engine package entry is missing from package-lock.json');
    locked.version = upstream.version;
    locked.resolved = 'file:vendor/general-engine-narrative.tgz';
    locked.integrity = integrity;
    locked.license = 'MIT';

    await copyFile(nextTarball, tarballPath);
    await writeFile(packagePath, JSON.stringify(manifest, null, 2) + '\n');
    await writeFile(provenancePath, JSON.stringify(meta, null, 2) + '\n');
    await writeFile(lockPath, JSON.stringify(lock, null, 2) + '\n');
    console.log(JSON.stringify({ repository: meta.repository, commit, version: upstream.version, sha256 }));
  } finally {
    await rm(packageRoot, { recursive: true, force: true });
  }
}
