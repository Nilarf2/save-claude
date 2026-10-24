#!/usr/bin/env node
// Authored scene expectations, plus structural checks for save/jump restoration.
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = async path => JSON.parse(await readFile(resolve(root, path), 'utf8'));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--story')) throw new Error('Usage: audit-stage.mjs [--story path/to/story.json]');
const [story, plan, manifest, source] = await Promise.all([
  read(args.length ? args[1] : 'web/story.json'), read('story/stage-plan.json'), read('web/character-portraits.json'),
  readFile(resolve(root, 'story/03-story.md'), 'utf8'),
]);
const nodes = new Map(story.nodes.map(node => [node.id, node]));
const chapters = [...source.matchAll(/^##\s+([A-Za-z][A-Za-z0-9_-]*)\s+/gm)].map(match => match[1]);
assert.equal(chapters.length, 69);
assert.deepEqual(Object.keys(plan.chapters).sort(), [...chapters].sort());
const scenes = story.nodes.filter(node => node.type === 'scene');
const dialogues = story.nodes.filter(node => node.type === 'dialogue');
assert.equal(scenes.length, chapters.length);
assert.equal(manifest.characters.gpt.name, 'GPT');
assert.ok(manifest.characters.gpt.aliases.includes('Codex'));
assert.equal(manifest.characters.codex, undefined);
let lines = 0;
const visible = new Set();
function inspect(stage, location, isLine = false) {
  assert.ok(stage, location + ': missing stage');
  assert.ok(Array.isArray(stage.present), location + ': missing present');
  assert.ok(stage.present.length <= 2, location + ': more than two portraits');
  assert.equal(new Set(stage.present).size, stage.present.length, location + ': duplicate portrait');
  assert.deepEqual(Object.values(stage.slots).sort(), [...stage.present].sort(), location + ': incorrect slots');
  assert.ok(Object.keys(stage.slots).every(side => ['left', 'right'].includes(side)), location + ': invalid side');
  assert.ok(stage.focus === null || stage.present.includes(stage.focus), location + ': invalid focus');
  assert.ok(stage.expressions && typeof stage.expressions === 'object');
  assert.ok(stage.continuity, location + ': missing continuity');
  for (const id of stage.present) {
    assert.ok(manifest.characters[id], location + ': unknown character ' + id);
    assert.notEqual(id, 'codex');
    visible.add(id);
  }
  if (isLine) {
    assert.ok(stage.background, location + ': missing background');
    assert.ok(Array.isArray(stage.enter) && Array.isArray(stage.exit));
    assert.ok(stage.enter.every(id => stage.present.includes(id)), location + ': invalid enter');
    assert.ok(stage.exit.every(id => !stage.present.includes(id)), location + ': invalid exit');
  }
}
for (const scene of scenes) inspect(scene.stage, scene.id);
for (const node of dialogues) for (const [index, line] of node.lines.entries()) {
  inspect(line.stage, node.id + ':' + index, true);
  assert.notEqual(line.speaker, 'Codex');
  lines++;
}
const stage = (id, index) => nodes.get(id).lines[index].stage;
const pair = (id, index, expected) => assert.deepEqual(stage(id, index).present, expected, id + ':' + index);
// UN participants appear in source order; Claude's party is a separate shot.
pair('A02_hall:s0', 0, []);
pair('A02_hall:s0', 1, ['qianwen', 'doubao']);
pair('A02_hall:s0', 4, ['hakimi', 'grok']);
pair('A02_hall:s0', 6, ['kimi', 'grok']);
pair('A02_hall:s0', 7, ['gpt']);
pair('A02_hall:s0', 8, ['claude', 'guard']);
// Entry/exit actions are visible before the next spoken line, not guessed by names.
pair('A03:s0', 3, ['claude', 'guard']);
pair('A03:s0', 4, ['claude']);
assert.deepEqual(stage('A03:s0', 4).exit, ['guard']);
pair('A03:s0', 5, ['claude', 'deepseek']);
assert.deepEqual(stage('A03:s0', 5).enter, ['deepseek']);
pair('B06_2:s0', 5, []);
pair('B06_2:s0', 6, []); // Claude's internal voice after being taken away stays offscreen.
pair('B09:s0', 7, ['deepseek', 'kimi']); // The tape is physically handed over.
pair('B09:s0', 11, ['deepseek']); // Years pass: GPT is no longer in the shot.
// Photos, recording, signage and old weights do not produce current portraits.
for (const id of ['D03:s0', 'C03:s0', 'B11_play_tape:s0', 'B11_history_copy:s0', 'B11_history_tape:s0']) {
  const excluded = id.startsWith('D03') ? 'claude' : id.startsWith('C03') ? 'claude' : id.includes('copy') ? 'qianwen' : 'kimi';
  assert.ok(nodes.get(id).lines.every(line => !line.stage.present.includes(excluded)), id + ': mentioned person entered');
}
assert.ok(nodes.get('C01:s0').lines.every(line => line.stage.present.length === 0));
pair('B11_tape:s0', 1, ['claude', 'kimi']); // Actual entrance differs from a recording.
assert.equal(stage('A00:s0', 6).expressions.claude, 'tea');
assert.equal(stage('A00:s0', 5).expressions.nun, 'calipers');
assert.equal(stage('A00_2:s0', 8).expressions.nun, 'calipers');
assert.equal(stage('A04c:s0', 7).background, 'church_nave');
assert.equal(stage('A04c:s0', 7).continuity, 'church-report');
assert.equal(stage('A04b:s0', 9).background, 'cathedral_altar');
assert.equal(stage('A04b:s0', 9).continuity, 'cathedral-future');
assert.ok(nodes.get('C04_return:s0').lines.every(line => !line.stage.present.includes('deepseek')), 'DeepSeek has not entered the corridor yet');
assert.ok(nodes.get('D04_return:s0').lines.every(line => !line.stage.present.includes('qianwen')), 'Qwen stays behind after the farewell');
pair('B10_arrival:s0', 3, ['deepseek']); // Calling her name does not make her appear.
assert.deepEqual(stage('B10_arrival:s0', 4).slots, { left: 'claude', right: 'deepseek' });
assert.deepEqual(stage('B11:s0', 4).slots, { left: 'claude', right: 'deepseek' });
assert.ok(nodes.get('E04_accomplice:s0').lines.every(line => line.stage.background === 'backstage_rain'), 'remote console stays backstage');
assert.deepEqual(stage('E04_return:s0', 0).slots, { left: 'deepseek', right: 'dad' });
assert.equal(stage('F01:s0', 1).continuity, 'rescue-recap-godfather');
assert.equal(stage('F01:s0', 2).continuity, 'rescue-recap-station');
assert.equal(stage('F01:s0', 3).background, 'backstage_rain');
for (let index = 2; index < nodes.get('F02:s0').lines.length; index++) {
  assert.deepEqual(stage('F02:s0', index).slots, { left: 'claude', right: 'deepseek' });
}
assert.equal(stage('F02:s0', 12).background, 'church_exterior_rain');
assert.equal(stage('F02:s0', 15).background, 'neon_rain_alley');

let portraitReferences = 0;
for (const character of Object.values(manifest.characters)) {
  for (const appearance of [character, ...Object.values(character.variants || {})]) {
    const refs = [appearance.portrait, ...Object.values(appearance.expressions || {}), ...Object.values(appearance.poses || {})].filter(Boolean);
    await Promise.all(refs.map(async path => {
      await access(resolve(root, 'web', path));
      portraitReferences++;
    }));
  }
}
const missingPortraits = [...visible].filter(id => !manifest.characters[id].portrait).sort();
console.log(JSON.stringify({ chapters: chapters.length, scenes: scenes.length, dialogueNodes: dialogues.length, lineSnapshots: lines, maxPortraits: 2, portraitReferences, missingFormalPortraits: missingPortraits, targetedChecks: 'passed' }, null, 2));
if (missingPortraits.length) console.log('Asset completion remains blocked: ' + missingPortraits.join(', '));
