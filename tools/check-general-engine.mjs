#!/usr/bin/env node
// Verify the checked-in General Engine Narrative package before game tests.
// The tarball is a built consumer artifact; source checkouts are never read.
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import {
  compileStory,
  createSession,
  validateSnapshot,
  NARRATIVE_ENGINE_VERSION,
} from '@general-engine/engine/narrative';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const provenance = JSON.parse(await readFile(resolve(root, 'vendor/general-engine/PROVENANCE.json'), 'utf8'));
const tarball = await readFile(resolve(root, 'vendor/general-engine-narrative.tgz'));
assert.equal(createHash('sha256').update(tarball).digest('hex'), provenance.sha256, 'General Engine tarball hash differs from provenance');
assert.equal(provenance.repository, 'https://github.com/Nilarf2/general-engine.git');
assert.match(provenance.commit, /^[0-9a-f]{40}$/);
assert.equal(provenance.package, '@general-engine/engine');
assert.equal(provenance.entry, './narrative');
assert.equal(NARRATIVE_ENGINE_VERSION, '1.0.0');
const manifest = JSON.parse(await readFile(resolve(root, 'node_modules/@general-engine/engine/package.json'), 'utf8'));
assert.equal(manifest.name, provenance.package);
assert.equal(manifest.version, provenance.version);
assert.ok(manifest.exports['./narrative']);
const lock = JSON.parse(await readFile(resolve(root, 'package-lock.json'), 'utf8'));
const locked = lock.packages['node_modules/@general-engine/engine'];
assert.equal(locked.resolved, 'file:vendor/general-engine-narrative.tgz');
assert.equal(locked.integrity, `sha512-${createHash('sha512').update(tarball).digest('base64')}`);

const story = JSON.parse(await readFile(resolve(root, 'web/story.json'), 'utf8'));
const compiled = compileStory(story);
assert.equal(compiled.story.id, story.id);
const session = createSession(compiled, { seed: 42 });
const result = session.start();
const snapshot = session.snapshot();
validateSnapshot(snapshot);
assert.equal(result.view.nodeId, 'A00:s0');
assert.equal(snapshot.gameId, 'save-claude');
const resolved = await import.meta.resolve('@general-engine/engine/narrative');
const packageRoot = await realpath(resolve(root, 'node_modules/@general-engine/engine'));
const resolvedPath = fileURLToPath(resolved);
assert.ok(resolvedPath.startsWith(packageRoot + sep), 'Consumer resolved outside the locked package');
console.log(`PASS: General Engine Narrative ${provenance.commit.slice(0, 12)}; ${story.nodes.length} nodes; tarball hash verified.`);
