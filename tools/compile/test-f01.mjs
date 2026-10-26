import { readFile } from 'node:fs/promises';
import { compileStory, createSession } from '@general-engine/engine/narrative';

const story = JSON.parse(await readFile('web/story.json', 'utf8'));
const compiled = compileStory(story);
const requiredTags = ['key_godfather', 'key_station', 'key_father', 'ate_rice', 'promise'];
const hasPrerequisites = tags => requiredTags.every(tag => tags.includes(tag));
let foundF01 = false;
let seedFound;

for (let seed = 0; seed < 10000 && !foundF01; seed++) {
  let randomState = seed + 13;
  const random = () => {
    randomState = (randomState * 1103515245 + 12345) & 0x7fffffff;
    return randomState / 0x80000000;
  };

  const session = createSession(compiled, { seed: 42 });
  let result = session.start();
  let steps = 0;

  while (steps++ < 4000) {
    const view = result.view;
    const state = session.snapshot().state;

    if (view.awaiting === 'ended') {
      if (state.visits['F01:scene']) {
        if (!hasPrerequisites(state.tags)) {
          throw new Error(`F01 ended without required tags (seed ${seed})`);
        }
        foundF01 = true;
        seedFound = seed;
      }
      break;
    }

    if (view.awaiting === 'choice') {
      const eligible = hasPrerequisites(state.tags);
      if (view.nodeId === 'HUB:s1:c') {
        const shortcut = view.choices.some(choice => choice.text.startsWith('三枚书签'));
        if (shortcut !== eligible) throw new Error(`HUB F01 gate mismatch (seed ${seed})`);
      }
      if (view.nodeId === 'B10:s1:c') {
        const shortcut = view.choices.some(choice => choice.text.startsWith('摸了摸饭盆底'));
        if (shortcut !== eligible) throw new Error(`B10 F01 gate mismatch (seed ${seed})`);
      }

      const choices = view.choices.filter(choice => !choice.disabled);
      if (!choices.length) throw new Error(`No enabled choices at ${view.nodeId}`);
      result = session.dispatch({
        type: 'choose',
        optionId: choices[Math.floor(random() * choices.length)].id,
      });
      continue;
    }

    if (view.awaiting === 'continue') {
      result = session.dispatch({ type: 'continue' });
      continue;
    }

    throw new Error(`Unexpected state ${view.awaiting} at ${view.nodeId}`);
  }
}

if (!foundF01) throw new Error('F01 was not reached in 10000 seeded playthroughs');
console.log(`F01 reached at seed ${seedFound}; all five prerequisites were present.`);
