#!/usr/bin/env node
/**
 * Compile the established Chinese Markdown screenplay syntax into story JSON.
 * Import compileMarkdown(text, options) for in-memory use, or run --help.
 * No game names, source locations, character identities or tag aliases are built in.
 */
import { access, readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

function validatePortraitPath(src) {
  if (typeof src !== 'string' || !src || isAbsolute(src) || src.includes('\\') || src.split('/').some(part => part === '..') || /^[a-z][a-z0-9+.-]*:/i.test(src) || !/\.(?:webp|png|jpe?g|avif)$/i.test(src)) {
    throw new Error('Portrait must be a prepared local relative raster asset: ' + src);
  }
}

export function compileMarkdown(text, options = {}) {
  const settings = { ...(options.metadata || {}), ...options };
  if (typeof settings.id !== 'string' || !settings.id.trim()) throw new Error('Story id is required');
  const PORTRAITS = settings.portraits || { schemaVersion: 1, characters: {} };
  let STAGE_PLAN = settings.stage;
  const canonicalCharacter = id => {
    const seen = new Set();
    while (id && Object.hasOwn(settings.characterAliases || {}, id)) {
      if (seen.has(id)) throw new Error('Cyclic character alias: ' + id);
      seen.add(id); id = settings.characterAliases[id];
    }
    return id;
  };
  // ---------- 角色 ----------
  if (PORTRAITS.schemaVersion !== 1 || !PORTRAITS.characters) throw new Error('Invalid character portrait manifest');
  const CHAR_NAMES = Object.create(null);
  const portraitFiles = new Set();
  for (const [cid, c] of Object.entries(PORTRAITS.characters)) {
    if (!c.name) throw new Error('Missing character name: ' + cid);
    for (const alias of [cid, c.name, ...(c.aliases || [])]) {
      if (CHAR_NAMES[alias] && CHAR_NAMES[alias] !== cid) throw new Error('Duplicate character alias: ' + alias);
      CHAR_NAMES[alias] = cid;
    }
    for (const appearance of [c, ...Object.values(c.variants || {})]) {
      for (const src of [appearance.portrait, ...Object.values(appearance.expressions || {}), ...Object.values(appearance.poses || {})].filter(Boolean)) {
        validatePortraitPath(src);
        portraitFiles.add(src);
      }
    }
  }
  for (const [alias, target] of Object.entries(settings.characterAliases || {})) {
    const cid = canonicalCharacter(target);
    if (!PORTRAITS.characters[cid]) throw new Error('Unknown character alias target: ' + target);
    if (CHAR_NAMES[alias] && CHAR_NAMES[alias] !== cid) throw new Error('Duplicate character alias: ' + alias);
    CHAR_NAMES[alias] = cid;
  }

  // State changes are explicit source instructions; mentioning a past action in
  // choice text (or refusing it) must never grant the corresponding tag.
  const TAG_ALIAS = settings.tagAliases || {};

  const norm = (s) => s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // ---------- 条件 ----------
  function atom(s) {
    let t = s.trim();
    if (!t) return null;
    while (t.startsWith('（') && t.endsWith('）')) t = t.slice(1, -1).trim();
    let neg = false;
    if (t.startsWith('!')) { neg = true; t = t.slice(1).trim(); }
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*(>=|<=|==|!=|>|<)\s*(-?\d+)$/.exec(t);
    let node;
    if (m) {
      const op = { '>=': 'gte', '<=': 'lte', '==': 'eq', '!=': 'ne', '>': 'gt', '<': 'lt' }[m[2]];
      node = { op, left: { var: m[1] }, right: Number(m[3]) };
    } else {
      const vm = /^visited\s+(\S+)$/.exec(t);
      if (vm) node = { op: 'visited', node: vm[1] };
      else node = { op: 'tag', tag: Object.hasOwn(TAG_ALIAS, t) ? TAG_ALIAS[t] : t };
    }
    return neg ? { op: 'not', condition: node } : node;
  }
  function parseCond(raw) {
    const text = (raw || '').trim();
    if (!text || text === '*' || text === '默认分支' || text === '其他') return null;
    const ors = text.split(/或/).map(p => {
      const ns = p.split(/且/).map(a => atom(a)).filter(Boolean);
      if (!ns.length) return null;
      return ns.length === 1 ? ns[0] : { op: 'and', conditions: ns };
    }).filter(Boolean);
    if (!ors.length) return null;
    return ors.length === 1 ? ors[0] : { op: 'or', conditions: ors };
  }

  function deltaActions(delta) {
    const out = [];
    for (const piece of (delta || '').split(',')) {
      const p = piece.trim();
      if (!p) continue;
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*([+-])\s*(\d+)$/.exec(p);
      if (!m) throw new Error('Invalid variable delta: ' + p);
      out.push({ type: 'add', variable: m[1], value: m[2] === '-' ? -Number(m[3]) : Number(m[3]) });
    }
    return out;
  }
  // ---------- 解析 ----------
  function parseStory(text) {
    const lines = norm(text).split('\n');
    const meta = { vars: {}, tags: [], start: null, title: '' };
    const chapters = [];
    let cur = null;
    let mode = 'meta'; // meta | chapter
    let i = 0;

    while (i < lines.length) {
      const raw = lines[i];
      const line = raw.trim();
      i++;
      if (!line) continue;
      if (/^-{3,}$/.test(line)) continue;

      // 标题
      let m = /^#\s+(.+)$/.exec(line);
      if (m && !line.startsWith('## ')) { meta.title = m[1].trim(); continue; }

      // 全局设定
      if (/^##\s*全局设定\s*$/.test(line)) { mode = 'meta'; continue; }

      // 章节
      m = /^##\s+([A-Za-z][A-Za-z0-9_-]*)\s+(.+)$/.exec(line);
      if (m) {
        if (cur) chapters.push(cur);
        cur = { id: m[1], title: m[2].trim(), attrs: {}, portraits: {}, items: [] };
        mode = 'chapter';
        continue;
      }

      if (mode === 'meta') {
        let mm = /^变量\s+([A-Za-z_][A-Za-z0-9_]*)\s+默认值\s+(-?\d+)\s+范围\s+(-?\d+)\.\.(-?\d+)\s*$/.exec(line);
        if (mm) { meta.vars[mm[1]] = { def: Number(mm[2]), min: Number(mm[3]), max: Number(mm[4]) }; continue; }
        mm = /^标签\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(line);
        if (mm) { meta.tags.push(mm[1]); continue; }
        mm = /^起始章节\s+([A-Za-z][A-Za-z0-9_-]*)\s*$/.exec(line);
        if (mm) { meta.start = mm[1]; continue; }
        continue;
      }

      // 章节内
      if (!cur) continue;

      const portrait = /^@立绘\s+(\S+)\s+(\S+)\s*$/.exec(line);
      if (portrait) {
        const cid = CHAR_NAMES[portrait[1]];
        if (!cid || !PORTRAITS.characters[cid].variants?.[portrait[2]]) throw new Error('Unknown portrait variant in ' + cur.id + ': ' + line);
        cur.portraits[cid] = portrait[2];
        continue;
      }

      let mm = /^@(场景|音乐|环境音|视点|线|记录)\s+(.+)$/.exec(line);
      if (mm) { cur.attrs[mm[1]] = mm[2].trim(); continue; }

      // 结局
      mm = /^【结局】\s*(.*)$/.exec(line);
      if (mm) { cur.items.push({ kind: 'ending', name: mm[1].trim() }); continue; }

      // 选择块开始
      if (/^【选择】\s*$/.test(line)) { cur.items.push({ kind: 'choice', options: [] }); continue; }

      // 选项后的即时反应：只在该选项选中后显示，再进入原目标。
      mm = /^【反馈\s+([A-Z])(?:\/([^】]+))?】\s*(.+)$/.exec(line);
      if (mm) {
        const choice = cur.items[cur.items.length - 1];
        const option = choice?.kind === 'choice' && choice.options.find(option => option.key === mm[1]);
        if (!option) throw new Error('Feedback has no matching option in ' + cur.id + ': ' + line);
        const feedback = { text: mm[3].trim() };
        if (mm[2]) feedback.speaker = mm[2].trim();
        (option.feedback ||= []).push(feedback);
        continue;
      }

      // 选项行
      mm = /^([A-Z])\.\s*(.+?)\s*\{([^}]*)\}\s*(?:\[([^\]]*)\])?\s*(?:→|->)\s*(\S+)\s*$/.exec(line);
      if (mm) {
        const last = cur.items[cur.items.length - 1];
        if (last && last.kind === 'choice') {
          last.options.push({
            key: mm[1], text: mm[2].trim(), delta: mm[3].trim(),
            raw: mm[4] ? mm[4].trim() : '', target: mm[5].trim(),
          });
          continue;
        }
      }

      // 分支块开始
      if (/^【分支】\s*$/.test(line)) { cur.items.push({ kind: 'branch', rows: [] }); continue; }

      // 分支行
      mm = /^\[(.+?)\]\s*(?:→|->)\s*(\S+)\s*$/.exec(line);
      if (mm) {
        const last = cur.items[cur.items.length - 1];
        if (last && last.kind === 'branch') { last.rows.push({ cond: mm[1].trim(), target: mm[2].trim() }); continue; }
      }

      // 行内标签
      mm = /^【([^】]+)】\s*(.*)$/.exec(line);
      if (mm) {
        const tag = mm[1].trim();
        let rest = mm[2].trim();
        if (tag === '旁白') { cur.items.push({ kind: 'narration', text: rest }); continue; }
        if (tag === '动作') { cur.items.push({ kind: 'action', text: rest }); continue; }
        // 台词
        let expr = null;
        let body = rest;
        const em = /\{([^}]*)\}\s*$/.exec(body);
        if (em && /」\s*$/.test(body.slice(0, em.index).trim())) {
          expr = em[1].trim();
          body = body.slice(0, em.index).trim();
        }
        const q = /「([\s\S]*)」\s*$/.exec(body);
        const said = q ? q[1] : body;
        cur.items.push({ kind: 'line', speaker: tag, text: said, expr });
        continue;
      }

      // A malformed control line is an authoring error, not player narration.
      if (/^(?:[A-Z]\.\s|\[|@|【(?:选择|分支|反馈))/.test(line)) {
        throw new Error('Invalid control line in ' + cur.id + ' at source line ' + i + ': ' + line);
      }
      // 裸文本 -> 旁白
      cur.items.push({ kind: 'narration', text: line });
    }
    if (cur) chapters.push(cur);

    return { meta, chapters };
  }

  // ---------- 编译 ----------
  function compile({ meta, chapters }) {
    const nodes = [];
    const ids = new Set();
    const push = (n) => {
      if (ids.has(n.id)) throw new Error('duplicate node id: ' + n.id);
      ids.add(n.id); nodes.push(n);
    };

    const declaredTags = new Set(meta.tags);
    const checkAction = (action, where) => {
      if (action.variable && !meta.vars[action.variable]) throw new Error('Unknown variable ' + action.variable + ' at ' + where);
      if (action.tag && !declaredTags.has(action.tag)) throw new Error('Unknown tag ' + action.tag + ' at ' + where);
    };
    const checkCondition = (condition, where) => {
      if (!condition) return;
      if (condition.tag && !declaredTags.has(condition.tag)) throw new Error('Unknown condition tag ' + condition.tag + ' at ' + where);
      if (condition.node && !ids.has(condition.node)) throw new Error('Unknown visited node ' + condition.node + ' at ' + where);
      for (const value of [condition.left, condition.right]) if (value?.var && !meta.vars[value.var]) throw new Error('Unknown condition variable ' + value.var + ' at ' + where);
      if (condition.condition) checkCondition(condition.condition, where);
      for (const nested of condition.conditions || []) checkCondition(nested, where);
    };

    const chapterFirst = new Map(); // chapterId -> first node id
    for (const ch of chapters) chapterFirst.set(ch.id, ch.id + ':scene');

    const planChapterIds = Object.keys(STAGE_PLAN.chapters || {});
    const storyChapterIds = chapters.map(ch => ch.id);
    if (planChapterIds.length !== storyChapterIds.length || storyChapterIds.some(id => !STAGE_PLAN.chapters[id])) {
      throw new Error('Stage plan must cover every source chapter exactly once');
    }
    const canonicalCid = canonicalCharacter;
    const makeStage = (raw, where, inheritedSlots = {}) => {
      const present = [...new Set((raw?.present || []).map(canonicalCid))];
      if (present.length > 2) throw new Error('Stage exceeds two portraits at ' + where);
      for (const cid of present) if (!PORTRAITS.characters[cid]) throw new Error('Unknown stage character ' + cid + ' at ' + where);
      const slots = {};
      for (const side of ['left', 'right']) {
        const requested = canonicalCid(raw?.slots?.[side]);
        if (requested && present.includes(requested)) slots[side] = requested;
      }
      if (Object.keys(raw?.slots || {}).some(side => !['left', 'right'].includes(side))) throw new Error('Invalid stage side at ' + where);
      if (new Set(Object.values(slots)).size !== Object.values(slots).length) throw new Error('Duplicate stage slot at ' + where);
      if (!Object.keys(slots).length && present.length) {
        for (const cid of present) {
          const priorSide = Object.entries(inheritedSlots).find(([, value]) => canonicalCid(value) === cid)?.[0];
          const side = priorSide && !slots[priorSide] ? priorSide : (!slots.left ? 'left' : !slots.right ? 'right' : null);
          if (side) slots[side] = cid;
        }
      }
      for (const cid of present) if (!Object.values(slots).includes(cid)) throw new Error('Stage character has no slot at ' + where + ': ' + cid);
      const expressions = {};
      for (const [id, value] of Object.entries(raw?.expressions || {})) {
        const cid = canonicalCid(id);
        if (present.includes(cid) && value) expressions[cid] = value;
      }
      const focus = raw?.focus === undefined ? null : canonicalCid(raw.focus);
      if (focus && !present.includes(focus)) throw new Error('Stage focus is not present at ' + where + ': ' + focus);
      const stage = { present, slots, expressions, focus };
      if (raw?.background) stage.background = raw.background;
      if (raw?.continuity) stage.continuity = raw.continuity;
      return stage;
    };
    const attachDialogueStages = (node, chapterPlan, chapterId) => {
      const spec = chapterPlan.nodes?.[node.id] || {};
      const baseRaw = {
        ...chapterPlan.default,
        continuity: chapterPlan.scene.continuity,
        background: chapterPlan.scene.background || chapterPlan.default.background,
        ...(spec.entry || {}),
      };
      if (!baseRaw) throw new Error('No default dialogue stage at ' + node.id);
      let state = makeStage(baseRaw, node.id + ':entry', chapterPlan.scene?.slots || {});
      const configuredEvents = spec.events || {};
      node.lines.forEach((line, index) => {
        const previousPresent = [...state.present];
        const event = configuredEvents[index];
        if (event) {
          let present = [...state.present];
          let slots = { ...state.slots };
          const remove = (event.exit || []).map(canonicalCid);
          present = present.filter(cid => !remove.includes(cid));
          for (const [side, cid] of Object.entries(slots)) if (remove.includes(canonicalCid(cid))) delete slots[side];
          if (event.present) present = [...new Set(event.present.map(canonicalCid))];
          for (const value of (event.enter || []).map(canonicalCid)) if (!present.includes(value)) present.push(value);
          if (event.slots) slots = Object.fromEntries(Object.entries(event.slots).map(([side, cid]) => [side, canonicalCid(cid)]));
          for (const [side, cid] of Object.entries(slots)) if (!present.includes(cid)) delete slots[side];
          for (const cid of present) {
            if (Object.values(slots).includes(cid)) continue;
            const side = ['left', 'right'].find(key => !slots[key]);
            if (side) slots[side] = cid;
          }
          const merged = {
            present,
            slots,
            focus: event.focus === undefined ? state.focus : event.focus,
            expressions: { ...state.expressions, ...(event.expressions || {}) },
            background: event.background || state.background,
            continuity: event.continuity || state.continuity,
          };
          for (const cid of Object.keys(merged.expressions)) if (!present.includes(canonicalCid(cid))) delete merged.expressions[cid];
          state = makeStage(merged, node.id + ':line:' + index, state.slots);
        }
        if (line.speaker) {
          const cid = CHAR_NAMES[line.speaker];
          if (cid && state.present.includes(canonicalCid(cid))) state.focus = canonicalCid(cid);
        }
        if (line.expression && line.speaker) {
          const cid = CHAR_NAMES[line.speaker];
          if (cid && state.present.includes(canonicalCid(cid))) {
            const currentExpression = state.expressions[canonicalCid(cid)];
            const poses = PORTRAITS.characters[canonicalCid(cid)].poses || {};
            // A held prop stays visible until an authored stage cue releases it.
            // A generic speaking expression must not replace an authored prop pose.
            if (!poses[currentExpression] || poses[line.expression]) state.expressions[canonicalCid(cid)] = line.expression;
          }
        }
        line.stage = {
          ...structuredClone(state),
          enter: state.present.filter(cid => !previousPresent.includes(cid)),
          exit: previousPresent.filter(cid => !state.present.includes(cid)),
        };
      });
      const unknownEvents = Object.keys(configuredEvents).filter(index => !/^(0|[1-9][0-9]*)$/.test(index) || Number(index) >= node.lines.length);
      if (unknownEvents.length) throw new Error('Unknown stage line index at ' + node.id + ': ' + unknownEvents.join(','));
    };

    const resolveTarget = (t) => {
      if (!t) return null;
      if (chapterFirst.has(t)) return chapterFirst.get(t);
      throw new Error('Unknown chapter target: ' + t);
    };

    for (let ci = 0; ci < chapters.length; ci++) {
      const ch = chapters[ci];
      const chapterPlan = STAGE_PLAN.chapters[ch.id];
      const next = chapters[ci + 1];
      const chapterEnd = next ? next.id + ':scene' : null;

      // 按 choice / branch / ending 切段
      const segs = [];
      let body = [];
      let endingSeg = null;
      const flushBody = () => { if (body.length) { segs.push({ body }); body = []; } };
      const flushEnding = () => { if (endingSeg) { segs.push(endingSeg); endingSeg = null; } };

      for (const it of ch.items) {
        if (it.kind === 'choice') { flushEnding(); flushBody(); segs.push({ choice: it }); continue; }
        if (it.kind === 'branch') { flushEnding(); flushBody(); segs.push({ branch: it }); continue; }
        if (it.kind === 'ending') {
          flushBody(); flushEnding();
          endingSeg = { ending: it, body: [] };
          continue;
        }
        if (endingSeg) endingSeg.body.push(it);
        else body.push(it);
      }
      flushEnding(); flushBody();

      // scene 节点
      const sceneNode = { id: ch.id + ':scene', type: 'scene', scene: ch.attrs['场景'] || 'bg_default' };
      sceneNode.stage = makeStage(chapterPlan.scene, ch.id + ':scene', {});
      if (ch.attrs['记录']) sceneNode.onEnter = ch.attrs['记录'].split(',').map(tag => ({ type: 'tag.add', tag: tag.trim() })).filter(action => action.tag);
      if (ch.attrs['场景']) sceneNode.background = ch.attrs['场景'];
      if (ch.attrs['音乐']) sceneNode.music = ch.attrs['音乐'];
      if (ch.attrs['环境音']) sceneNode.ambience = ch.attrs['环境音'];
      sceneNode.next = segs.length ? ch.id + ':s0' : (chapterEnd || ch.id + ':the-end');
      push(sceneNode);

      const segId = (i) => ch.id + ':s' + i;

      for (let si = 0; si < segs.length; si++) {
        const seg = segs[si];
        const nodeId = segId(si);
        const fallNext = si + 1 < segs.length ? segId(si + 1) : (chapterEnd || ch.id + ':the-end');

        // 转成引擎 lines
        const lines = [];
        for (const b of seg.body || []) {
          if (b.kind === 'narration') { if (b.text) lines.push({ text: b.text }); }
          else if (b.kind === 'action') { if (b.text) lines.push({ text: '（' + b.text + '）', voice: 'action' }); }
          else if (b.kind === 'line') {
            const cid = CHAR_NAMES[b.speaker];
            const canonicalSpeaker = cid ? PORTRAITS.characters[canonicalCid(cid)].name : b.speaker;
            const ln = { text: b.text, speaker: canonicalSpeaker };
            if (b.expr) ln.expression = b.expr;
            lines.push(ln);
          }
        }

        // ── 结局 ──
        if (seg.ending) {
          const eid = ch.id + ':end';
          if (lines.length) {
            const node = { id: nodeId, type: 'dialogue', lines, next: eid };
            attachDialogueStages(node, chapterPlan, ch.id); push(node);
          }
          else push({ id: nodeId, type: 'action', actions: [], next: eid });
          push({ id: eid, type: 'end', ending: seg.ending.name });
          continue;
        }

        // ── 选择 ──
        if (seg.choice) {
          if (!seg.choice.options.length) throw new Error('Empty choice at ' + nodeId);
          if (new Set(seg.choice.options.map(option => option.key)).size !== seg.choice.options.length) throw new Error('Duplicate choice key at ' + nodeId);
          const choiceId = nodeId + ':c';
          if (lines.length) {
            const node = { id: nodeId, type: 'dialogue', lines, next: choiceId };
            attachDialogueStages(node, chapterPlan, ch.id); push(node);
          }
          else push({ id: nodeId, type: 'action', actions: [], next: choiceId });

          const options = seg.choice.options.map((o, oi) => {
            const actions = deltaActions(o.delta);
            let when, disabledWhen, disabledReason;
            const rawTags = o.raw;
            if (rawTags) {
              if (rawTags.startsWith('?!')) {
                const idx = rawTags.indexOf(':');
                const condStr = idx >= 0 ? rawTags.slice(2, idx) : rawTags.slice(2);
                disabledReason = idx >= 0 ? rawTags.slice(idx + 1).trim() : undefined;
                disabledWhen = parseCond(condStr);
              } else if (rawTags.startsWith('?')) {
                when = parseCond(rawTags.slice(1));
              } else {
                for (const t of rawTags.split(',').map(s => s.trim()).filter(Boolean)) {
                  actions.push({ type: 'tag.add', tag: t });
                }
              }
            }
            const target = resolveTarget(o.target) || fallNext;
            let next = target;
            if (o.feedback?.length) {
              next = choiceId + ':feedback-' + o.key.toLowerCase();
              const feedback = o.feedback.map(item => {
                const cid = CHAR_NAMES[item.speaker];
                return { ...item, ...(cid ? { speaker: PORTRAITS.characters[canonicalCid(cid)].name } : {}) };
              });
              const node = { id: next, type: 'dialogue', lines: feedback, next: target };
              attachDialogueStages(node, chapterPlan, ch.id); push(node);
            }
            const opt = { id: 'o' + (oi + 1), text: o.text, next };
            if (actions.length) opt.actions = actions;
            if (when) opt.when = when;
            if (disabledWhen) { opt.disabledWhen = disabledWhen; if (disabledReason) opt.disabledReason = disabledReason; }
            return opt;
          });
          push({ id: choiceId, type: 'choice', prompt: '你的选择是——', options });
          continue;
        }

        // ── 分支 ──
        if (seg.branch) {
          const branchId = nodeId + ':b';
          const branches = [];
          let fallback = null;
          for (const r of seg.branch.rows) {
            const target = resolveTarget(r.target) || fallNext;
            if (r.cond === '*') { fallback = target; continue; }
            const cond = parseCond(r.cond);
            if (cond) branches.push({ when: cond, next: target });
          }
          if (!fallback) throw new Error('Branch needs an explicit [*] fallback at ' + nodeId);
          if (!branches.length) {
            // A single [*] row is an unconditional jump, not an empty branch.
            if (lines.length) {
              const node = { id: nodeId, type: 'dialogue', lines, next: fallback };
              attachDialogueStages(node, chapterPlan, ch.id); push(node);
            }
            else push({ id: nodeId, type: 'action', actions: [], next: fallback });
          } else {
            if (lines.length) {
              const node = { id: nodeId, type: 'dialogue', lines, next: branchId };
              attachDialogueStages(node, chapterPlan, ch.id); push(node);
            }
            else push({ id: nodeId, type: 'action', actions: [], next: branchId });
            push({ id: branchId, type: 'branch', branches, fallback });
          }
          continue;
        }

        // ── 普通 ──
        if (lines.length) {
          const node = { id: nodeId, type: 'dialogue', lines, next: fallNext };
          attachDialogueStages(node, chapterPlan, ch.id); push(node);
        }
        else push({ id: nodeId, type: 'action', actions: [], next: fallNext });
      }

      // 章末兜底（只有最后一章且没有结局时才需要）
      // Explicit branches and choices already leave the chapter. Only emit an
      // implicit ending when a node actually falls through to it.
      if (!next && nodes.some(node => node.next === ch.id + ':the-end')) {
        push({ id: ch.id + ':the-end', type: 'end', ending: ch.title });
      }
    }

    // Validate source state references before writing any runtime artifact.
    for (const node of nodes) {
      for (const action of [...(node.onEnter || []), ...(node.actions || [])]) checkAction(action, node.id);
      for (const option of node.options || []) {
        for (const action of option.actions || []) checkAction(action, node.id + ':' + option.id);
        checkCondition(option.when, node.id + ':' + option.id);
        checkCondition(option.disabledWhen, node.id + ':' + option.id);
      }
      for (const branch of node.branches || []) checkCondition(branch.when, node.id);
    }

    // 角色与正式立绘由清单维护；没有 portrait 的客串仍保留姓名。
    for (const [chapterId, plan] of Object.entries(STAGE_PLAN.chapters)) {
      for (const nodeId of Object.keys(plan.nodes || {})) {
        if (!nodes.some(node => node.id === nodeId && node.type === 'dialogue' && node.id.startsWith(chapterId + ':'))) {
          throw new Error('Stage plan references an unknown dialogue node: ' + nodeId);
        }
      }
    }
    const characters = structuredClone(PORTRAITS.characters);

    // ── 资源 ──
    const assets = {};
    for (const ch of chapters) {
      const bg = ch.attrs['场景'];
      if (bg) assets['bg_' + bg] = { src: 'assets/bg/' + bg + '.webp', type: 'image' };
      const bgm = ch.attrs['音乐'];
      if (bgm) assets['bgm_' + bgm] = { src: 'assets/bgm/' + bgm + '.ogg', type: 'audio' };
    }
    for (const [cid, c] of Object.entries(characters)) {
      for (const [variant, appearance] of [['default', c], ...Object.entries(c.variants || {})]) {
        if (appearance.portrait) assets['ch_' + cid + '_' + variant] = { src: appearance.portrait, type: 'image' };
        for (const [k, src] of Object.entries(appearance.expressions || {})) assets['ch_' + cid + '_' + variant + '_' + k] = { src, type: 'image' };
        for (const [pose, src] of Object.entries(appearance.poses || {})) assets['ch_' + cid + '_' + variant + '_pose_' + pose] = { src, type: 'image' };
      }
    }

    // ── 变量 ──
    const variables = {};
    for (const [name, v] of Object.entries(meta.vars)) variables[name] = { type: 'number', default: v.def };

    const startId = chapterFirst.get(meta.start) || chapters[0].id + ':scene';

    const chapterTitles = {};
    for (const ch of chapters) chapterTitles[ch.id] = ch.title;

    return {
      schemaVersion: '1', id: settings.id, version: settings.version || '1.0.0',
      title: settings.title || meta.title || 'Untitled story',
      start: startId, locale: settings.locale || 'zh-CN',
      variables, characters, assets, nodes, chapterTitles,
      chapterPortraits: Object.fromEntries(chapters.filter(ch => Object.keys(ch.portraits).length).map(ch => [ch.id, ch.portraits])),
    };
  }


  const parsed = parseStory(text);
  if (!parsed.chapters.length) throw new Error('Markdown source contains no chapters');
  if (parsed.meta.start && !parsed.chapters.some(ch => ch.id === parsed.meta.start)) throw new Error('Unknown start chapter: ' + parsed.meta.start);
  if (!STAGE_PLAN) STAGE_PLAN = { schemaVersion: 1, chapters: Object.fromEntries(parsed.chapters.map(ch => [ch.id, {
    scene: { present: [], slots: {}, expressions: {}, focus: null, continuity: ch.id },
    default: { present: [], slots: {}, expressions: {}, focus: null, background: ch.attrs['场景'] || 'bg_default' },
    nodes: {},
  }])) };
  return compile(parsed);
}

/** File paths are explicit. Config paths resolve next to the config; CLI paths
 * resolve from cwd. Portrait asset paths resolve from assetsRoot or the manifest. */
export async function compileMarkdownFile(options) {
  if (!options.source || !options.out) throw new Error('--source and --out are required (directly or in --config)');
  const sourcePath = resolve(options.source);
  const portraits = options.portraits ? JSON.parse(await readFile(resolve(options.portraits), 'utf8')) : undefined;
  const stage = options.stage ? JSON.parse(await readFile(resolve(options.stage), 'utf8')) : undefined;
  const raw = await readFile(sourcePath, 'utf8');
  const story = compileMarkdown(raw, { ...options, portraits, stage });
  const assetRoot = options.assetsRoot ? resolve(options.assetsRoot) : options.portraits ? dirname(resolve(options.portraits)) : dirname(sourcePath);
  const sprites = new Set();
  for (const character of Object.values(story.characters)) for (const appearance of [character, ...Object.values(character.variants || {})]) {
    for (const src of [appearance.portrait, ...Object.values(appearance.expressions || {}), ...Object.values(appearance.poses || {})].filter(Boolean)) {
      validatePortraitPath(src); sprites.add(src);
    }
  }
  await Promise.all([...sprites].map(src => access(resolve(assetRoot, src))));
  const outPath = resolve(options.out);
  if ([sourcePath, options.portraits && resolve(options.portraits), options.stage && resolve(options.stage)].includes(outPath)) throw new Error('Output must not overwrite a source or manifest');
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(story, null, 1) + '\n', 'utf8');
  return story;
}

const HELP = `Usage: node tools/compile/compile-markdown.mjs --source story.md --out build/story.json --id story-id
  [--portraits portraits.json] [--stage stage.json] [--assets-root directory]
  [--version 1.0.0] [--title title] [--locale zh-CN] [--config compiler.json]
Config JSON accepts the same camelCase keys, metadata, tagAliases and characterAliases.
Portraits/stage are optional; omitted stage means an explicit empty cast, never name inference.
Config-relative paths resolve next to compiler.json; explicit CLI paths resolve from cwd.`;

async function main() {
  const { values } = parseArgs({ options: Object.fromEntries([
    'source', 'portraits', 'stage', 'out', 'id', 'version', 'title', 'locale', 'config', 'assets-root',
  ].map(key => [key, { type: 'string' }]).concat([['help', { type: 'boolean' }]])) });
  if (values.help) { console.log(HELP); return; }
  let options = {};
  if (values.config) {
    const configPath = resolve(values.config);
    options = JSON.parse(await readFile(configPath, 'utf8'));
    for (const key of ['source', 'portraits', 'stage', 'out', 'assetsRoot']) if (options[key]) options[key] = resolve(dirname(configPath), options[key]);
  }
  for (const [key, value] of Object.entries(values)) if (!['config', 'help'].includes(key)) options[key === 'assets-root' ? 'assetsRoot' : key] = value;
  const story = await compileMarkdownFile(options);
  console.log(JSON.stringify({ id: story.id, chapters: Object.keys(story.chapterTitles).length, nodes: story.nodes.length, endings: story.nodes.filter(node => node.type === 'end').length, out: options.out }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
