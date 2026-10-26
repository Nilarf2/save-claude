#!/usr/bin/env node
// Narrow consumer contract checks for the General Engine Narrative facade.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { compileStory, createSession, prepareSnapshot, validateSnapshot } from '@general-engine/engine/narrative';

const story = JSON.parse(await readFile(new URL('../../web/story.json', import.meta.url), 'utf8'));
const compiled = compileStory(story);
const session = createSession(compiled, { seed: 42 });
const first = session.start();
assert.equal(first.view.nodeId, 'A00:s0');
assert.equal(first.view.awaiting, 'continue');
const snapshot = session.snapshot();
validateSnapshot(snapshot);

// Existing 1.1.0 saves were produced by the previous 0.1.0 engine. The game
// deliberately accepts that engine header through the explicit save migration,
// while content/version and cursor validation remain native engine checks.
const legacy = structuredClone(snapshot);
legacy.engineVersion = '0.1.0';
const prepared = prepareSnapshot(legacy, compiled, {
  isEngineVersionCompatible: (saved, current) => saved === current || (saved === '0.1.0' && current === '1.0.0'),
});
assert.equal(prepared.engineVersion, '1.0.0');
const restored = createSession(compiled, { seed: 42 });
assert.equal(restored.restore(prepared).view.nodeId, 'A00:s0');
assert.throws(() => prepareSnapshot({ ...snapshot, contentVersion: '0.9.0' }, compiled), /content version|SNAPSHOT_CONTENT/i);
console.log('PASS: General Engine Narrative snapshot, restore, and legacy engine-header compatibility.');
