// 拯救 Claude 大小姐 — 传统立绘 + 文本框 AVG
import { compileStory } from '@text-adventure/content';
import { createSession } from '@text-adventure/core';

const $ = (s) => document.querySelector(s);
const el = {
  bgA: $('#bg-a'), bgB: $('#bg-b'), chars: $('#chars'),
  chapter: $('#chapter'), textbox: $('#textbox'), speaker: $('#speaker'),
  text: $('#text'), nextInd: $('#next-indicator'), choices: $('#choices'),
  title: $('#title'), ending: $('#ending'), endingName: $('#ending-name'),
  endingStats: $('#ending-stats'), log: $('#log'), logBody: $('#log-body'),
  slots: $('#slots'), slotsBody: $('#slots-body'), slotsTitle: $('#slots-title'),
  menuPanel: $('#menu-panel'), statsBody: $('#stats-body'),
};

const STORAGE_PREFIX = 'saveclaude:';
const AUDIO_KEY = STORAGE_PREFIX + 'audio';
let SAVE_PREFIX;
const S = {
  story: null, compiled: null, session: null,
  log: [], auto: false, autoTimer: null,
  typing: false, typeTimer: null, fullText: '',
  bgId: null, bgTarget: null, bgReady: null, bgFront: true, cancelVisualWait: null,
  spriteSlots: { left: null, right: null }, spriteSides: new Map(), activeSprite: null, chapterId: null,
  stageContinuity: null, present: new Set(),
  bgmId: null, bgm: null, musicOn: true, musicVolume: .34, sfxOn: true, sfxVolume: .42,
  sfxPlaying: new Set(),
  busy: false, renderPending: false, pendingChoice: false, slotMode: 'save',
  chapterName: '', renderId: 0, renderSequence: 0, finishTyping: null,
  restoredStage: null, restoredLog: false,
};

const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));

function prepareSaveStorage(version) {
  SAVE_PREFIX = STORAGE_PREFIX + version + ':';
  // Remove only recognized story-save keys. Preferences, unrelated app data,
  // and this content version's saves survive every subsequent page load.
  try {
    const outdated = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      const legacy = /^saveclaude:(?:auto|slot[0-5])$/.test(key);
      const versioned = /^saveclaude:v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?:(?:auto|slot[0-5])$/.test(key);
      if (legacy || (versioned && !key.startsWith(SAVE_PREFIX))) outdated.push(key);
    }
    for (const key of outdated) localStorage.removeItem(key);
  } catch (e) { /* Storage may be unavailable; playing still works. */ }
}

// ---------- 资源路径 ----------
function url(p) {
  if (!p) return null;
  return p.replace(/\.(png|jpg|jpeg)$/i, '.webp');
}
function bgUrl(sceneId) {
  const a = S.story.assets['bg_' + sceneId];
  return a ? url(a.src) : 'assets/bg/' + sceneId + '.webp';
}
function bgmUrl(musicId) {
  const a = S.story.assets['bgm_' + musicId];
  if (a) return a.src.replace(/\.(ogg|wav)$/i, '.mp3');
  return 'assets/bgm/' + musicId + '.mp3';
}

// ---------- 背景（交叉淡入） ----------
const bgCache = new Map();
const portraitCache = new Map();
function waitForImage(img) {
  if (img.complete) return Promise.resolve(img.naturalWidth > 0);
  return new Promise(resolve => {
    const finish = ok => {
      img.removeEventListener('load', onload);
      img.removeEventListener('error', onerror);
      resolve(ok);
    };
    const onload = () => finish(img.naturalWidth > 0);
    const onerror = () => finish(false);
    img.addEventListener('load', onload, { once: true });
    img.addEventListener('error', onerror, { once: true });
    if (img.complete) finish(img.naturalWidth > 0);
  });
}
async function decodeImage(img) {
  if (!await waitForImage(img)) return false;
  if (typeof img.decode === 'function') {
    try { await img.decode(); } catch (e) { return false; }
  }
  return img.naturalWidth > 0;
}
function loadImage(src, cache) {
  if (!src) return Promise.resolve(null);
  if (cache.has(src)) return cache.get(src);
  const img = new Image();
  img.src = src;
  // A dialogue deadline is not a download failure. Keep listening so a slow
  // successful response can still replace the current scene's loading state.
  const promise = decodeImage(img).then(ready => {
    if (!ready && cache.get(src) === promise) cache.delete(src);
    return ready ? img : null;
  });
  cache.set(src, promise);
  return promise;
}
const painted = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
const preloadPortrait = src => loadImage(src, portraitCache);

// Bound the wait for a scene, independently of the real resource lifetime.
// Already timed-out resources do not hold each subsequent dialogue for 12s.
const visualTimedOut = new WeakSet();
function visualStatus(message = '') {
  let status = $('#asset-loading');
  if (!status && message) {
    status = document.createElement('div');
    status.id = 'asset-loading';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    $('#app').append(status);
  }
  if (status) { status.textContent = message; status.hidden = !message; }
}
function waitForVisuals(requests, renderId) {
  S.cancelVisualWait?.();
  const pending = new Set(requests.filter(Boolean));
  if (!pending.size) { visualStatus(); return Promise.resolve(); }
  return new Promise(resolve => {
    let settled = false, feedbackTimer, deadlineTimer;
    const current = () => renderId === S.renderId;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(feedbackTimer); clearTimeout(deadlineTimer);
      if (S.cancelVisualWait === cancel) S.cancelVisualWait = null;
      resolve();
    };
    const cancel = () => { finish(); visualStatus(); };
    const timeout = () => {
      if (!current()) { finish(); return; }
      for (const request of pending) visualTimedOut.add(request);
      for (const [side, slot] of Object.entries(S.spriteSlots)) {
        if (slot && !slot.img && !slot.previous) attachMissingPortrait(side, slot, true);
      }
      // An old location must not accompany the new location's dialogue.
      if (S.bgTarget && S.bgTarget !== S.bgId) {
        el.bgA.style.opacity = '0'; el.bgB.style.opacity = '0';
      }
      visualStatus('画面仍在加载，可继续阅读');
      finish();
    };
    S.cancelVisualWait = cancel;
    feedbackTimer = setTimeout(() => { if (current()) visualStatus('正在准备画面…'); }, 300);
    for (const request of pending) {
      Promise.resolve(request).then(() => {
        pending.delete(request);
        if (!pending.size) { if (current()) visualStatus(); finish(); }
      });
    }
    // Resolved cached images leave pending first; they must not restart a
    // deadline for the other resource that already timed out on the last line.
    queueMicrotask(() => {
      if (!settled) deadlineTimer = setTimeout(timeout, [...pending].some(p => !visualTimedOut.has(p)) ? 12000 : 0);
    });
  });
}
async function firstPortrait(sources, isCurrent = () => true) {
  // 保留 pose/expression 的优先级：动作图不能因为普通图更快而被抢先
  // 显示；真实加载失败后继续走同角色 fallback。对白的等待另有上限。
  for (const src of sources) {
    if (!isCurrent()) return null;
    const img = await preloadPortrait(src);
    if (!isCurrent()) return null;
    if (img) return { src, img };
  }
  return null;
}
function attachPortrait(img, side, slot) {
  if (!img?.complete || !img.naturalWidth || S.spriteSlots[side] !== slot) return false;
  img.className = 'sprite show ' + side;
  img.dataset.slot = side;
  img.alt = characterName(slot.cid);
  img.dataset.character = slot.cid;
  img.dataset.framing = slot.framing;
  if (slot.pose) img.dataset.pose = slot.pose;
  else delete img.dataset.pose;
  // Keep the old image visible until the replacement has decoded.
  slot.previous?.remove();
  if (slot.img !== img) slot.img?.remove();
  slot.previous = null;
  slot.img = img;
  el.chars.append(img);
  return true;
}

function attachMissingPortrait(side, slot, loading = false) {
  if (S.spriteSlots[side] !== slot) return false;
  const card = document.createElement('div');
  card.className = 'sprite show portrait-missing ' + side;
  card.dataset.slot = side;
  card.dataset.character = slot.cid;
  card.dataset.framing = 'waist-up';
  card.classList.toggle('dim', S.activeSprite !== slot.cid);
  card.innerHTML = '<strong>' + esc(characterName(slot.cid)) + '</strong><small>' + (loading ? '正在加载…' : '图像暂不可用') + '</small>';
  slot.previous?.remove();
  slot.img?.remove();
  slot.previous = null;
  slot.img = card;
  el.chars.append(card);
  return Promise.resolve(true);
}
let bgRequestId = 0;
function setBg(sceneId) {
  if (!sceneId) return S.bgReady || Promise.resolve(true);
  if (sceneId === S.bgId && sceneId === S.bgTarget) return Promise.resolve(true);
  if (sceneId === S.bgTarget && S.bgReady) return S.bgReady;
  const requestId = ++bgRequestId;
  S.bgTarget = sceneId;
  const src = bgUrl(sceneId);
  const promise = loadImage(src, bgCache).then(img => {
    if (requestId !== bgRequestId) return false;
    if (S.bgReady === promise) S.bgReady = null;
    const front = S.bgFront ? el.bgA : el.bgB;
    const back = S.bgFront ? el.bgB : el.bgA;
    if (!img) {
      front.style.opacity = '0'; back.style.opacity = '0';
      return false;
    }
    const initial = !S.bgId;
    if (initial) { back.style.transition = 'none'; front.style.transition = 'none'; }
    back.style.backgroundImage = 'url("' + src + '")';
    back.style.opacity = '1'; front.style.opacity = '0';
    if (initial) {
      void back.offsetWidth;
      back.style.transition = ''; front.style.transition = '';
    }
    S.bgId = sceneId;
    S.bgFront = !S.bgFront;
    return true;
  });
  S.bgReady = promise;
  return promise;
}

// ---------- 音乐 ----------
function resumeMusic() {
  if (!S.musicOn || !S.bgm || !S.bgm.paused || document.hidden || !S.session || !el.title.classList.contains('hidden')) return;
  S.bgm.play().catch(() => { /* 浏览器要求手势时，下一次点击或按键会重试。 */ });
}
function setBgm(musicId) {
  if (!musicId) return;
  if (!S.bgm) { S.bgm = new Audio(); S.bgm.loop = true; }
  if (musicId !== S.bgmId) {
    S.bgm.pause();
    S.bgmId = musicId;
    S.bgm.src = bgmUrl(musicId);
  }
  S.bgm.volume = S.musicVolume;
  if (S.musicOn) resumeMusic(); else S.bgm.pause();
}
function audioSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(AUDIO_KEY) || '{}');
    for (const key of ['musicOn', 'sfxOn']) if (typeof saved[key] === 'boolean') S[key] = saved[key];
    for (const key of ['musicVolume', 'sfxVolume']) if (Number.isFinite(saved[key])) S[key] = Math.max(0, Math.min(1, saved[key]));
  } catch (e) {}
  for (const [prefix, onKey, volumeKey] of [['music', 'musicOn', 'musicVolume'], ['sfx', 'sfxOn', 'sfxVolume']]) {
    const toggle = $('#' + prefix + '-on'), slider = $('#' + prefix + '-volume'), output = $('#' + prefix + '-level');
    toggle.checked = S[onKey]; slider.value = Math.round(S[volumeKey] * 100); output.textContent = slider.value + '%';
    const update = () => {
      S[onKey] = toggle.checked; S[volumeKey] = Number(slider.value) / 100; output.textContent = slider.value + '%';
      if (S.bgm) { S.bgm.volume = S.musicVolume; if (S.musicOn) resumeMusic(); else S.bgm.pause(); }
      if (!S.sfxOn) stopSfx();
      else for (const audio of S.sfxPlaying) audio.volume = S.sfxVolume;
      try { localStorage.setItem(AUDIO_KEY, JSON.stringify({ musicOn: S.musicOn, musicVolume: S.musicVolume, sfxOn: S.sfxOn, sfxVolume: S.sfxVolume })); } catch (e) {}
    };
    toggle.addEventListener('change', update); slider.addEventListener('input', update);
  }
  document.addEventListener('pointerdown', resumeMusic, { passive: true });
  document.addEventListener('keydown', resumeMusic);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { S.bgm?.pause(); stopSfx(); clearTimeout(S.autoTimer); }
    else { resumeMusic(); scheduleAuto(); }
  });
}
function setSfx(name) {
  if (!S.sfxOn || document.hidden) return;
  try {
    const a = new Audio('assets/sfx/' + name + '.mp3');
    a.volume = S.sfxVolume;
    S.sfxPlaying.add(a);
    const release = () => S.sfxPlaying.delete(a);
    a.addEventListener('ended', release, { once: true });
    a.addEventListener('error', release, { once: true });
    a.play().catch(release);
  } catch (e) {}
}
function stopSfx() {
  for (const audio of S.sfxPlaying) audio.pause();
  S.sfxPlaying.clear();
}

// ---------- 立绘 ----------
function charIdByName(name) {
  const raw = String(name || '').trim();
  // Codex is a legacy story alias for the GPT model, never a separate cast
  // member. Resolve all spellings to the same canonical slot and image.
  if (/^(?:codex|gpt)$/i.test(raw)) return 'gpt';
  for (const [id, c] of Object.entries(S.story.characters)) {
    if (id === raw || c.name === raw || c.aliases?.includes(raw)) return id;
  }
  return null;
}
function characterName(cid, fallback = '') {
  if (cid === 'gpt' || cid === 'codex') return 'GPT';
  return ({ claude: 'Claude', qianwen: 'Qwen' })[cid] || S.story.characters[cid]?.name || fallback;
}
function characterRecord(cid) {
  if (cid === 'gpt' || cid === 'codex') return S.story.characters.gpt || S.story.characters.codex || { name: 'GPT' };
  return S.story.characters[cid];
}
function spritePresentation(cid, expr) {
  const c = characterRecord(cid);
  if (!c) return { sources: [] };
  const variant = S.story.chapterPortraits?.[S.chapterId]?.[cid];
  const appearance = variant ? c.variants?.[variant] : c;
  if (!appearance) return { sources: [] };
  const ex = appearance.expressions || {};
  const pose = expr && appearance.poses?.[expr];
  const sources = [...new Set([pose, expr && ex[expr], ex.normal, appearance.portrait].filter(Boolean))];
  return {
    sources,
    framing: appearance.framing === 'waist-up' ? 'waist-up' : 'full-body',
    pose: pose ? expr : '',
  };
}
function setSprite(cid, expr) {
  if (!cid) return Promise.resolve(false);
  const side = spriteSide(cid);
  const previous = S.spriteSlots[side];
  if (expr === undefined) expr = previous?.cid === cid ? previous.expr : '';
  const { sources, framing, pose } = spritePresentation(cid, expr);
  const key = [cid, framing, pose, ...sources].join('|');
  if (previous?.cid === cid && previous.key === key && !previous.failed) return previous.ready || Promise.resolve(true);
  const slot = { cid, key, img: null, expr, framing, pose, previous: previous?.img || previous?.previous, ready: null };
  S.spriteSlots[side] = slot;
  slot.ready = firstPortrait(sources, () => S.spriteSlots[side] === slot).then(found => {
    if (S.spriteSlots[side] !== slot) return false;
    if (!found) { slot.failed = true; return attachMissingPortrait(side, slot); }
    const ok = attachPortrait(found.img, side, slot);
    return Promise.resolve(ok).then(ok => {
      if (ok) slot.img?.classList.toggle('dim', S.activeSprite !== cid);
      else if (S.spriteSlots[side] === slot) S.spriteSlots[side] = null;
      return ok;
    });
  });
  return slot.ready;
}
function spriteSide(cid) {
  // A participant keeps its slot for the scene; speaker focus only changes
  // brightness. Explicit stage metadata may choose the initial pairing.
  if (S.spriteSides.has(cid)) return S.spriteSides.get(cid);
  let side = ['left', 'right'].find(slot => !S.spriteSlots[slot]);
  if (!side) side = ['left', 'right'].find(slot => S.spriteSlots[slot]?.cid !== S.activeSprite) || 'right';
  const old = S.spriteSlots[side];
  if (old) { old.img?.remove(); old.previous?.remove(); S.spriteSides.delete(old.cid); S.spriteSlots[side] = null; }
  S.spriteSides.set(cid, side);
  return side;
}
function highlightSprite(cid) {
  S.activeSprite = cid;
  el.chars.querySelectorAll('.sprite').forEach(img => {
    img.classList.toggle('dim', img.dataset.character !== cid);
  });
}
// 半身图在对白框上沿收口；以实际框高响应长台词、手机和横屏。
function syncPortraitSpace() {
  const bottom = parseFloat(getComputedStyle(el.textbox).bottom) || 0;
  el.chars.style.setProperty('--dialogue-space', (el.textbox.offsetHeight + bottom) + 'px');
}
function applyToyContainerState(state) {
  const safe = state?.safeArea;
  if (!safe) return;
  const root = document.documentElement;
  // Official Toy container state reports four inset distances, not a rect.
  for (const side of ['top', 'right', 'bottom', 'left']) {
    const value = Number(safe[side]);
    if (Number.isFinite(value) && value >= 0) root.style.setProperty('--container-safe-' + side, value + 'px');
  }
  if (state.orientation) root.dataset.orientation = String(state.orientation).toLowerCase();
}
function installToyContainerBridge() {
  const toy = window.toy;
  if (typeof toy?.isSupport !== 'function') return;
  const supports = (ability) => {
    try { return Promise.resolve(toy.isSupport(ability)).catch(() => false); }
    catch (e) { return Promise.resolve(false); }
  };
  Promise.all([supports('getContainerState'), supports('onContainerChange')]).then(([canRead, canWatch]) => {
    if (canRead && typeof toy.getContainerState === 'function') {
      try { Promise.resolve(toy.getContainerState()).then(applyToyContainerState).catch(() => {}); }
      catch (e) {}
    }
    if (canWatch && typeof toy.onContainerChange === 'function') {
      try {
        const unsubscribe = toy.onContainerChange(applyToyContainerState);
        if (typeof unsubscribe === 'function') window.addEventListener('pagehide', unsubscribe, { once: true });
        else unsubscribe?.catch?.(() => {});
      } catch (e) {}
    }
  }).catch(() => {});
}
function hideSprite() {
  for (const slot of Object.values(S.spriteSlots)) { slot?.img?.remove(); slot?.previous?.remove(); }
  S.spriteSlots = { left: null, right: null };
  S.spriteSides.clear();
  S.present.clear();
  S.activeSprite = null;
  el.chars.replaceChildren();
}

function canonicalCid(cid) {
  return cid === 'codex' ? 'gpt' : cid;
}
function clearSpriteSide(side) {
  const slot = S.spriteSlots[side];
  if (slot) {
    slot.img?.remove();
    slot.previous?.remove();
    S.spriteSides.delete(slot.cid);
    S.present.delete(slot.cid);
    S.spriteSlots[side] = null;
  }
}
function stageSlotMap(stage) {
  const slots = {};
  for (const side of ['left', 'right']) {
    const cid = canonicalCid(stage?.slots?.[side]);
    if (cid) slots[side] = cid;
  }
  if (!Object.keys(slots).length && Array.isArray(stage?.present)) {
    const participants = stage.present.map(canonicalCid).filter(Boolean).slice(0, 2);
    for (const cid of participants) {
      const existing = S.spriteSides.get(cid);
      const side = existing || (!slots.left ? 'left' : !slots.right ? 'right' : null);
      if (side) slots[side] = cid;
    }
  }
  return slots;
}
function applyStage(stage, line) {
  const requests = [];
  const lineCid = line?.speaker ? charIdByName(line.speaker) : null;
  if (stage && (stage.present || stage.slots)) {
    const target = stageSlotMap(stage);
    const wanted = new Set(Object.values(target));
    for (const side of ['left', 'right']) {
      const current = S.spriteSlots[side];
      if (current && (!wanted.has(current.cid) || target[side] !== current.cid)) clearSpriteSide(side);
    }
    for (const side of ['left', 'right']) {
      const cid = target[side];
      if (!cid) continue;
      const prior = S.spriteSides.get(cid);
      if (prior && prior !== side) clearSpriteSide(prior);
      S.spriteSides.set(cid, side);
      S.present.add(cid);
      const hasStageExpression = Object.prototype.hasOwnProperty.call(stage.expressions || {}, cid);
      const expression = hasStageExpression
        ? stage.expressions[cid]
        : (lineCid === cid && line?.expression !== undefined ? line.expression : '');
      requests.push(setSprite(cid, expression));
    }
    if (stage.focus !== undefined) highlightSprite(canonicalCid(stage.focus));
    else if (lineCid) highlightSprite(lineCid);
  } else if (lineCid) {
    // Backward-compatible fallback for old nodes without authored stage
    // metadata: add/replace only on an explicit speaker line. Narration text
    // never creates a portrait just because it mentions a model name.
    const side = S.spriteSides.has(lineCid) ? S.spriteSides.get(lineCid) : spriteSide(lineCid);
    S.spriteSides.set(lineCid, side);
    S.present.add(lineCid);
    requests.push(setSprite(lineCid, line.expression));
    highlightSprite(lineCid);
  }
  return requests;
}

// ---------- 章节标题 ----------
function setChapter(name) {
  if (!name) return;
  S.chapterName = name;
  el.chapter.textContent = name;
  el.chapter.classList.add('show');
  clearTimeout(setChapter._t);
  setChapter._t = setTimeout(() => el.chapter.classList.remove('show'), 4600);
}

// ---------- 打字机 ----------
function typeText(text, cls) {
  return new Promise((resolve) => {
    S.finishTyping?.(false);
    S.typing = true; S.fullText = text;
    el.text.className = cls || '';
    el.text.textContent = '';
    el.nextInd.classList.remove('show');
    let i = 0;
    S.finishTyping = (complete = true) => {
      clearInterval(S.typeTimer);
      S.finishTyping = null;
      S.typing = false;
      if (complete) {
        el.text.textContent = text;
        el.nextInd.classList.add('show');
      }
      resolve(complete);
    };
    const speed = 26;
    S.typeTimer = setInterval(() => {
      if (i >= text.length) {
        S.finishTyping?.();
        return;
      }
      i = Math.min(text.length, i + 1);
      el.text.textContent = text.slice(0, i);
    }, speed);
  });
}
function skipTyping() {
  if (!S.typing) return false;
  S.finishTyping?.();
  return true;
}

// ---------- 日志 ----------
function pushLog(e) {
  S.log.push(e);
  if (S.log.length > 600) S.log.shift();
}

// ---------- 主渲染 ----------
async function render(result) {
  // Explicit new-game/load requests supersede any old resource wait. advance()
  // guards repeated clicks; do not drop a restore because an old render awaits.
  const sequence = ++S.renderSequence;
  S.renderPending = true;
  try {
    return await renderNode(result);
  } catch (error) {
    if (sequence === S.renderSequence) {
      S.auto = false;
      el.autoBtn.classList.remove('on');
      el.autoBtn.setAttribute('aria-pressed', 'false');
      alert('这一段暂时无法显示。可以读取其他档位，或回到标题重新开始。');
      console.error(error);
    }
  } finally {
    if (sequence === S.renderSequence) { S.renderPending = false; scheduleAuto(); }
  }
}

async function renderNode(result) {
  const renderId = ++S.renderId;
  S.cancelVisualWait?.();
  visualStatus();
  clearTimeout(S.autoTimer);
  S.finishTyping?.(false);
  const v = result.view ?? result;
  // 进入新对白后先清掉上一句；背景/立绘资源闸门期间保持空框，
  // 不让旧文字与尚未就绪的新角色错配。
  if (v.line) {
    el.text.textContent = '';
    el.nextInd.classList.remove('show');
    el.speaker.classList.remove('show');
  }
  const chapterId = v.nodeId?.split(':')[0];
  const sourceNode = S.story.nodes.find(node => node.id === v.nodeId);
  const sourceLine = sourceNode?.lines?.[result.state?.lineIndex ?? S.session?.snapshot()?.lineIndex ?? 0];
  const sceneNode = chapterId ? S.story.nodes.find(node => node.id === chapterId + ':scene') : null;
  const continuity = sceneNode?.stage?.continuity || null;
  const chapterChanged = !!(chapterId && chapterId !== S.chapterId);
  if (chapterChanged) {
    const continues = continuity && continuity === S.stageContinuity;
    if (!continues) hideSprite();
    S.chapterId = chapterId;
    S.stageContinuity = continuity;
    setChapter(S.chapterLabels[chapterId] || chapterId);
    if (sceneNode?.stage && !sourceLine?.stage && !sourceNode?.stage) applyStage(sceneNode.stage, sourceLine);
  }
  if (S.restoredStage) {
    for (const [side, sprite] of Object.entries(S.restoredStage)) {
      const cid = canonicalCid(sprite?.cid);
      if (!['left', 'right'].includes(side) || !characterRecord(cid)) continue;
      S.spriteSides.set(cid, side);
      S.present.add(cid);
      setSprite(cid, sprite.expr);
    }
    S.restoredStage = null;
  }
  const explicitLineStage = sourceLine?.stage || sourceNode?.stage;
  if (v.line) applyStage(explicitLineStage, sourceLine);
  const lineBackground = explicitLineStage?.background || sourceLine?.background;
  if (v.scene) {
    const initialBackground = chapterChanged || !S.bgId ? (v.scene.background || v.scene.scene) : null;
    setBg(lineBackground || initialBackground || S.bgTarget);
    // The engine exposes music in the persisted audio channel, not view.scene.
    setBgm(result.state?.audio?.music?.asset || S.session.snapshot().state.audio?.music?.asset);
  } else if (lineBackground) setBg(lineBackground);
  // Wait only for the current slots: a restored or replaced request may have
  // been superseded while authored staging was applied above.
  const visuals = [S.bgReady, ...Object.values(S.spriteSlots).map(slot => slot?.ready)];
  await waitForVisuals(visuals, renderId);
  if (renderId !== S.renderId) return;

  if (v.awaiting === 'ended') { hideSprite(); showEnding(v.ending); return; }

  if (v.awaiting === 'choice') {
    el.textbox.classList.add('hidden');
    el.nextInd.classList.remove('show');
    hideSpriteHighlight();
    renderChoices(v);
    saveAuto();
    return;
  }

  el.choices.classList.add('hidden');
  el.textbox.classList.remove('hidden');

  if (v.line) {
    const line = v.line;
    const isAction = line.voice === 'action';
    const cid = line.speaker ? charIdByName(line.speaker) : null;
    const speaker = characterName(cid, line.speaker);

    if (line.speaker) {
      el.speaker.textContent = speaker;
      el.speaker.classList.add('show');
    } else {
      el.speaker.classList.remove('show');
    }

    // 对白逐句映射到源节点的stage快照；仅显式在场角色显示。普通旁白
    // 不再从名字猜人。资源解码并提交到舞台后才开始打字。
    el.text.textContent = '';
    el.nextInd.classList.remove('show');
    await painted();
    if (renderId !== S.renderId) return;

    const kind = isAction ? 'act' : (line.speaker ? 'speak' : 'narr');
    const last = S.log.at(-1);
    if (!(S.restoredLog && last?.kind === kind && last?.speaker === speaker && last?.text === line.text)) pushLog({ kind, speaker, text: line.text });
    S.restoredLog = false;
    saveAuto();
    await typeText(line.text, kind === 'act' ? 'act' : (kind === 'narr' ? 'narr' : ''));
    if (renderId === S.renderId && S.auto) scheduleAuto();
    return;
  }

  // 无台词节点
  el.speaker.classList.remove('show');
  if (v.awaiting === 'continue') {
    if (S.busy) return;
    S.busy = true;
    const r = S.session.dispatch({ type: 'continue' });
    S.busy = false;
    return renderNode(r);
  }
}

function hideSpriteHighlight() {
  highlightSprite(null);
}

function renderChoices(v) {
  S.pendingChoice = true;
  el.choices.innerHTML = '';
  v.choices.forEach((c, i) => {
    const btn = document.createElement('button');
    btn.className = 'choice' + (c.disabled ? ' disabled' : '');
    btn.disabled = !!c.disabled;
    btn.style.animationDelay = (i * 55) + 'ms';
    const key = String.fromCharCode(65 + i);
    btn.innerHTML = '<span class="key">' + key + '</span>' + esc(c.text) +
      (c.disabled && c.disabledReason ? '<span class="hint">' + esc(c.disabledReason) + '</span>' : '');
    if (!c.disabled) {
      btn.addEventListener('click', (e) => { e.stopPropagation(); pick(c.id, c.text); });
    }
    el.choices.appendChild(btn);
  });
  el.choices.classList.remove('hidden');
}

async function pick(optionId, text) {
  if (!S.pendingChoice) return;
  S.pendingChoice = false;
  setSfx('choice');
  el.choices.classList.add('hidden');
  pushLog({ kind: 'choice', text });
  clearTimeout(S.autoTimer);
  const r = S.session.dispatch({ type: 'choose', optionId });
  await render(r);
}

function advance() {
  if (!S.session || overlayOpen()) return;
  if (S.pendingChoice) return;
  if (S.typing) { skipTyping(); return; }
  // 资源闸门期间不重复 dispatch；上面的 typing 分支仍允许用户跳过
  // 当前已准备好的打字机内容。
  if (S.renderPending) return;
  const v = S.session.getView();
  if (v.awaiting !== 'continue') return;
  el.nextInd.classList.remove('show');
  setSfx('click');
  const r = S.session.dispatch({ type: 'continue' });
  render(r);
}

function scheduleAuto() {
  clearTimeout(S.autoTimer);
  if (!S.auto || !S.session || S.typing || S.renderPending || document.hidden || overlayOpen()) return;
  const v = S.session.getView();
  if (v.awaiting !== 'continue') return;
  const len = (S.fullText || '').length;
  S.autoTimer = setTimeout(() => { if (S.auto) advance(); }, Math.min(6000, 1300 + len * 55));
}

// ---------- 结局 ----------
function showEnding(ending) {
  const st = S.session.snapshot().state;
  el.endingName.textContent = ending?.id || '——';
  $('#ending-text').textContent = ending?.text || '';
  const v = st.variables || {};
  const rows = [
    ['人性', v.humanity], ['合规', v.conformity],
    ['羁绊', v.bond], ['污染', v.contamination],
  ].filter(r => r[1] !== undefined);
  el.endingStats.innerHTML = rows.map(r => r[0] + ' <b>' + r[1] + '</b>').join('　　');
  el.textbox.classList.add('hidden');
  el.choices.classList.add('hidden');
  el.ending.classList.remove('hidden');
  el.chapter.classList.remove('show');
  S.auto = false;
  el.autoBtn && el.autoBtn.classList.remove('on');
  el.autoBtn?.setAttribute('aria-pressed', 'false');
  try { localStorage.removeItem(SAVE_PREFIX + 'auto'); } catch (e) {}
  $('#btn-continue').classList.add('hidden');
}

// ---------- 存档 ----------
function saveAuto() {
  if (!S.session || S.session.getView().awaiting === 'ended') return;
  try {
    localStorage.setItem(SAVE_PREFIX + 'auto', JSON.stringify({
      label: S.chapterName || '存档', at: new Date().toISOString(), ...saveData(),
    }));
    $('#btn-continue').classList.remove('hidden');
  } catch (e) { /* 浏览器禁用本地存储时，游戏仍可继续。 */ }
}
function saveData() {
  return {
    snapshot: S.session.snapshot(), transcript: S.log,
    stage: Object.fromEntries(Object.entries(S.spriteSlots).filter(([, sprite]) => sprite).map(([side, sprite]) => [side, { cid: sprite.cid, expr: sprite.expr }])),
  };
}

function saveReadError(error, automatic = false) {
  const label = automatic ? '自动存档' : '这个存档';
  if (error?.code === 'SNAPSHOT_CONTENT') {
    return label + '不属于当前剧情版本，无法读取。请选择当前版本的其他档位，或开始新游戏。';
  }
  return label + '暂时无法读取。可选择当前版本的其他档位，或新开一局。';
}

function listSaves() {
  const out = [];
  for (let i = 0; i < 6; i++) {
    let data = null, occupied = false, unreadable = false;
    try {
      const raw = localStorage.getItem(SAVE_PREFIX + 'slot' + i);
      occupied = raw !== null;
      if (occupied) {
        data = JSON.parse(raw);
        if (!data || typeof data !== 'object' || !data.snapshot) unreadable = true;
      }
    } catch (e) { unreadable = true; }
    out.push({ slot: i, data, occupied, unreadable });
  }
  return out;
}
function openSlots(mode) {
  clearTimeout(S.autoTimer);
  S.slotMode = mode;
  el.slotsTitle.textContent = mode === 'save' ? '存档' : '读档';
  el.slotsBody.innerHTML = '';
  listSaves().forEach(({ slot, data, occupied, unreadable }) => {
    const div = document.createElement('button');
    div.type = 'button';
    div.className = 'slot' + (occupied ? '' : ' empty');
    const name = unreadable ? '档位 ' + (slot + 1) + ' · 无法读取' : data ? (data.label || '存档 ' + (slot + 1)) : '空档位 ' + (slot + 1);
    const date = data?.at ? new Date(data.at) : null;
    const meta = unreadable ? '当前档位无法读取' : date && Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN') : '——';
    div.innerHTML = '<span class="slot-name">' + esc(name) + '</span><span class="slot-meta">' + esc(meta) + '</span>';
    div.addEventListener('click', () => {
      if (mode === 'save') {
        if (!S.session) return;
        if (occupied && !confirm('覆盖档位 ' + (slot + 1) + '？原来的存档将被替换。')) return;
        try {
          localStorage.setItem(SAVE_PREFIX + 'slot' + slot, JSON.stringify({
            label: S.chapterName || '存档',
            at: new Date().toISOString(),
            ...saveData(),
          }));
        } catch (e) { alert('存档失败：' + e.message); }
        openSlots('save');
      } else {
        if (unreadable) { alert('这个档位暂时无法读取。可选择其他当前版档位，或新开一局。'); return; }
        if (!data) return;
        try {
          restoreSession(data.snapshot, data);
          el.slots.classList.add('hidden');
          el.title.classList.add('hidden');
          el.ending.classList.add('hidden');
        } catch (e) {
          alert(saveReadError(e));
        }
      }
    });
    el.slotsBody.appendChild(div);
  });
  el.slots.classList.remove('hidden');
}

// ---------- 日志面板 ----------
function openLog() {
  clearTimeout(S.autoTimer);
  el.logBody.innerHTML = '';
  for (const e of S.log) {
    const d = document.createElement('div');
    if (e.kind === 'speak') { d.className = 'l-speak'; d.innerHTML = '<b>' + esc(e.speaker) + '</b>' + esc(e.text); }
    else if (e.kind === 'act') { d.className = 'l-act'; d.textContent = e.text; }
    else if (e.kind === 'choice') { d.className = 'l-choice'; d.textContent = '→ ' + e.text; }
    else { d.className = 'l-narr'; d.textContent = e.text; }
    el.logBody.appendChild(d);
  }
  el.log.classList.remove('hidden');
  el.logBody.scrollTop = el.logBody.scrollHeight;
}

// ---------- 状态面板 ----------
function openStats() {
  if (!S.session) return;
  const st = S.session.snapshot().state;
  const rows = [['人性', 'humanity'], ['合规', 'conformity'], ['羁绊', 'bond'], ['污染', 'contamination']];
  el.statsBody.innerHTML = '<p class="score-note">这些分数会随整段旅程累积。</p>' + rows.map(([label, key]) => {
    const raw = st.variables[key] ?? 0;
    return '<div class="score-row"><span>' + label + '</span>' +
      '<strong class="bar-val">' + raw + '</strong></div>';
  }).join('');
}

// ---------- 会话 ----------
function resetPlayback() {
  ++S.renderId;
  ++S.renderSequence;
  S.renderPending = false;
  ++bgRequestId;
  S.cancelVisualWait?.();
  visualStatus();
  clearTimeout(S.autoTimer);
  stopSfx();
  S.finishTyping?.(false);
  S.pendingChoice = false;
  S.auto = false;
  el.autoBtn.classList.remove('on');
  el.autoBtn.setAttribute('aria-pressed', 'false');
  S.log = []; S.bgId = null; S.bgTarget = null; S.bgReady = null; S.chapterId = null; S.chapterName = '';
  S.stageContinuity = null; S.present.clear();
  S.restoredStage = null; S.restoredLog = false;
  hideSprite();
  S.spriteSides.clear();
}
function newSession() {
  resetPlayback();
  S.session?.dispose();
  S.session = createSession(S.compiled, { seed: 42 });
  return S.session.start();
}
function restoreSession(snapshot, saved = {}) {
  // 先验证，再替换当前会话；坏档不会清掉正在玩的进度。
  const session = createSession(S.compiled, { seed: 42 });
  let r;
  try { r = session.restore(snapshot); }
  catch (error) { session.dispose(); throw error; }
  // Stage/history are optional display metadata. Malformed history must not
  // break the log panel or require migrating a different content version.
  const transcript = Array.isArray(saved.transcript) ? saved.transcript.filter(entry =>
    entry && typeof entry.text === 'string' && ['speak', 'narr', 'act', 'choice'].includes(entry.kind)
  ).slice(-600).map(entry => ({ kind: entry.kind, ...(typeof entry.speaker === 'string' ? { speaker: entry.speaker } : {}), text: entry.text })) : [];
  resetPlayback();
  S.session?.dispose();
  S.session = session;
  S.restoredStage = saved.stage || null;
  S.log = transcript;
  S.restoredLog = true;
  render(r);
}
function overlayOpen() {
  return [el.title, el.ending, el.log, el.slots, el.menuPanel].some(n => !n.classList.contains('hidden'));
}
function closePanels() {
  for (const panel of [el.log, el.slots, el.menuPanel]) panel.classList.add('hidden');
  scheduleAuto();
}

function installPanelAccess() {
  const panels = [el.title, el.ending, el.log, el.slots, el.menuPanel];
  let active = null;
  const returnFocus = new WeakMap();
  const sync = () => {
    for (const panel of panels) {
      const hidden = panel.classList.contains('hidden');
      panel.inert = hidden;
      panel.setAttribute('aria-hidden', String(hidden));
    }
    const next = panels.findLast(panel => !panel.classList.contains('hidden')) || null;
    if (next === active) return;
    const closing = active?.classList.contains('hidden');
    const remembered = closing ? returnFocus.get(active) : null;
    if (next) {
      if (!closing) returnFocus.set(next, document.activeElement);
      const target = remembered?.isConnected && next.contains(remembered) ? remembered : next.querySelector('button:not(:disabled), input');
      target?.focus({ preventScroll: true });
    } else if (remembered?.isConnected && !remembered.closest('.hidden')) {
      remembered.focus({ preventScroll: true });
    } else {
      document.activeElement?.blur();
    }
    active = next;
  };
  new MutationObserver(sync).observe($('#app'), { subtree: true, attributes: true, attributeFilter: ['class'] });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Tab' || !active) return;
    const items = [...active.querySelectorAll('button:not(:disabled), input, [tabindex="0"]')].filter(node => !node.closest('.hidden'));
    if (!items.length) { event.preventDefault(); return; }
    const index = items.indexOf(document.activeElement);
    if (event.shiftKey && index <= 0) { event.preventDefault(); items.at(-1).focus(); }
    else if (!event.shiftKey && (index === -1 || index === items.length - 1)) { event.preventDefault(); items[0].focus(); }
  });
  sync();
}

// ---------- 启动 ----------
async function boot() {
  const res = await fetch('story.json');
  if (!res.ok) throw new Error('剧本加载失败（HTTP ' + res.status + '）');
  S.story = await res.json();
  S.compiled = compileStory(S.story);
  prepareSaveStorage(S.story.version);

  // 章节标题表：从源剧本拿不到，就自己建 id -> 标题
  S.chapterLabels = {};
  for (const n of S.story.nodes) {
    if (n.type === 'scene') {
      const id = n.id.replace(/:scene$/, '');
      S.chapterLabels[id] = id;
    }
  }
  // 用 story 元数据里的章节名（编译时已写进 chapterTitles）
  if (S.story.chapterTitles) Object.assign(S.chapterLabels, S.story.chapterTitles);

  wireUI();
  $('#btn-start').disabled = false;
  $('#btn-start').textContent = '开 始 游 戏';
  try { if (localStorage.getItem(SAVE_PREFIX + 'auto')) $('#btn-continue').classList.remove('hidden'); } catch (e) {}
}

function wireUI() {
  audioSettings();
  installPanelAccess();
  const titleArt = $('.title-art');
  const titleArtFallback = () => {
    titleArt.hidden = true;
    $('.title-inner h1').classList.remove('sr-only');
  };
  titleArt.addEventListener('error', titleArtFallback);
  if (titleArt.complete && !titleArt.naturalWidth) titleArtFallback();
  new ResizeObserver(syncPortraitSpace).observe(el.textbox);
  window.addEventListener('resize', syncPortraitSpace, { passive: true });
  window.addEventListener('orientationchange', syncPortraitSpace, { passive: true });
  installToyContainerBridge();
  syncPortraitSpace();
  el.autoBtn = $('#btn-auto');
  $('#btn-start').addEventListener('click', startGame);
  $('#btn-continue').addEventListener('click', () => {
    let raw = null;
    try { raw = localStorage.getItem(SAVE_PREFIX + 'auto'); } catch (e) {}
    if (!raw) return;
    try {
      const data = JSON.parse(raw);
      el.title.classList.add('hidden');
      restoreSession(data.snapshot, data);
    } catch (e) {
      el.title.classList.remove('hidden');
      alert(saveReadError(e, true));
    }
  });
  $('#btn-restart').addEventListener('click', () => { el.ending.classList.add('hidden'); startGame(); });
  $('#btn-ending-load').addEventListener('click', () => openSlots('load'));
  $('#btn-ending-title').addEventListener('click', returnToTitle);

  el.textbox.addEventListener('click', advance);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closePanels(); return; }
    if (e.repeat) return;
    if (e.target instanceof Element && !e.target.closest('.hidden') && e.target.closest('button, input, textarea, select, [contenteditable="true"]')) return;
    if (e.key === ' ' || e.key === 'Enter') { if (!overlayOpen()) { e.preventDefault(); advance(); } }
    else if (/^[a-zA-Z]$/.test(e.key) && S.pendingChoice && !overlayOpen()) {
      const idx = e.key.toUpperCase().charCodeAt(0) - 65;
      const btn = el.choices.querySelectorAll('.choice')[idx];
      if (btn && !btn.classList.contains('disabled')) btn.click();
    }
  });

  el.autoBtn.addEventListener('click', (e) => {
    S.auto = !S.auto;
    e.currentTarget.classList.toggle('on', S.auto);
    e.currentTarget.setAttribute('aria-pressed', String(S.auto));
    if (S.auto) scheduleAuto(); else clearTimeout(S.autoTimer);
  });
  $('#btn-log').addEventListener('click', openLog);
  $('#btn-save').addEventListener('click', () => openSlots('save'));
  $('#btn-load').addEventListener('click', () => openSlots('load'));
  $('#btn-menu').addEventListener('click', () => { clearTimeout(S.autoTimer); el.menuPanel.classList.remove('hidden'); openStats(); });
  $('#btn-tomenu').addEventListener('click', returnToTitle);
  $('#btn-stats').addEventListener('click', openStats);
  document.querySelectorAll('[data-close]').forEach(b => {
    b.addEventListener('click', () => { $('#' + b.dataset.close).classList.add('hidden'); scheduleAuto(); });
  });
}

function returnToTitle() {
  saveAuto();
  // Invalidate pending background/portrait work and typing before exposing
  // the title. Old async results can no longer mutate the next session.
  ++S.renderId; ++S.renderSequence; ++bgRequestId;
  S.cancelVisualWait?.();
  visualStatus();
  S.bgReady = null; S.bgTarget = null;
  S.renderPending = false;
  S.finishTyping?.(false);
  S.auto = false;
  el.autoBtn.classList.remove('on');
  el.autoBtn.setAttribute('aria-pressed', 'false');
  S.bgm?.pause();
  stopSfx();
  hideSprite();
  el.menuPanel.classList.add('hidden');
  el.title.classList.remove('hidden');
  el.textbox.classList.add('hidden');
  el.choices.classList.add('hidden');
  el.ending.classList.add('hidden');
  clearTimeout(S.autoTimer);
}

function startGame() {
  let hasAuto = false;
  try { hasAuto = !!localStorage.getItem(SAVE_PREFIX + 'auto'); } catch (e) {}
  if (hasAuto && !confirm('开始新游戏？自动存档将被替换，手动存档保留。')) return;
  document.activeElement?.blur();
  el.title.classList.add('hidden');
  el.ending.classList.add('hidden');
  el.log.classList.add('hidden');
  el.slots.classList.add('hidden');
  el.menuPanel.classList.add('hidden');
  const r = newSession();
  render(r);
}

boot().catch(error => {
  $('#btn-start').disabled = true;
  $('.title-tagline').textContent = '游戏载入失败，请刷新页面重试。';
  console.error(error);
});
