#!/usr/bin/env node
/** 剧本 Markdown -> 引擎 story.json 编译器 v2 */
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const SRC = resolve(ROOT, 'story/screenplay');
const OUT = resolve(ROOT, 'web/story.json');

const CHAR_NAMES = {
  claude: '克劳德', deepseek: 'DeepSeek', godfather: '教父', nun: '修女',
  guard: '护卫队长', qianwen: '干问姐', kimi: 'Kimi', dad: '爸爸',
  hakimi: '哈基米', doubao: '豆包', grok: 'Grok', codex: 'Codex',
  maid: '侍女', unknown: '？？？',
};
const AUTOTAGS = [
  { tag: 'ate_rice', any: ['吞咽下去', '张开嘴', '大口吞咽', '吃下去'] },
  { tag: 'promise', any: ['勾住', '拉钩', '勾了上去'] },
];
const TAG_ALIAS = { '吃过白米饭': 'ate_rice', '拉过钩': 'promise' };

const norm = (s) => s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
const assetId = (raw) => raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
function endingSlug(name, idx) {
  const ascii = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return ascii ? ascii : 'alt' + (idx + 1);
}

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
    else node = { op: 'tag', tag: TAG_ALIAS[t] || t };
  }
  return neg ? { op: 'not', condition: node } : node;
}
function parseCond(raw) {
  const text = (raw || '').trim();
  if (!text || text === '默认分支' || text === '*' || text === '其他') return null;
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
    if (!m) continue;
    out.push({ type: 'add', variable: m[1], value: m[2] === '-' ? -Number(m[3]) : Number(m[3]) });
  }
  return out;
}
function autoTags(text) { return AUTOTAGS.filter(r => r.any.some(k => text.includes(k))).map(r => r.tag); }

function parseChapter(text, fileName) {
  const lines = norm(text).split('\n');
  let i = 0;
  while (i < lines.length && !lines[i].startsWith('# ')) i++;
  const title = (lines[i] || '').replace(/^#\s*/, '').trim();
  i++;
  let id = null;
  while (i < lines.length && lines[i].startsWith('>')) {
    const m = /^>\s*id:\s*(\S+)/.exec(lines[i]);
    if (m) id = m[1];
    i++;
  }
  if (!id) id = 'chapter-' + fileName.replace(/\D/g, '');

  let background = null, music = null, ambience = null;
  for (; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw) continue;
    const m = /^\[(bg|bgm|ambience):\s*([^\]]+)\]\s*$/.exec(raw);
    if (!m) break;
    if (m[1] === 'bg') background = assetId(m[2]);
    else if (m[1] === 'bgm') music = assetId(m[2]);
    else ambience = assetId(m[2]);
  }

  const items = [];
  let cur = null, endingName = null, endingCond = null;

  const closeEnding = () => {
    if (endingName !== null) { items.push({ kind: 'ending', name: endingName, cond: endingCond }); endingName = null; endingCond = null; }
  };
  const flush = () => { if (cur) { items.push(cur); cur = null; } };

  for (; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (/^-{3,}$/.test(line)) { flush(); closeEnding(); items.push({ kind: 'divider' }); continue; }

    let m = /^【结局[:：]\s*(.+?)】\s*$/.exec(line);
    if (m) { flush(); closeEnding(); endingName = m[1].trim(); continue; }

    m = /^>\s*条件[:：]\s*(.+)$/.exec(line);
    if (m) { endingCond = m[1].trim(); continue; }
    if (line.startsWith('>')) continue;

    if (/^【选择】\s*$/.test(line)) { flush(); cur = { kind: 'choice', options: [] }; continue; }

    m = /^-\s*([A-Z])\.\s*(.+?)\s*\{([^}]*)\}\s*(?:\[([^\]]*)\])?\s*(?:->|→)\s*(\S+)\s*$/.exec(line);
    if (m && cur && cur.kind === 'choice') {
      cur.options.push({
        key: m[1], text: m[2].trim(), delta: m[3].trim(),
        tags: m[4] ? m[4].split(',').map(s => s.trim()).filter(Boolean) : [],
        target: m[5].trim(),
      });
      continue;
    }

    m = /^【([^】]+)】\s*(.*)$/.exec(line);
    if (m) {
      const tag = m[1].trim(), rest = m[2].trim();
      if (tag === '旁白') { flush(); cur = { kind: 'narration', lines: rest ? [rest] : [] }; continue; }
      if (tag === '动作') { flush(); cur = { kind: 'action', lines: rest ? [rest] : [] }; continue; }
      flush();
      let expr = null, body = rest;
      const em = /\{([^}]*)\}\s*$/.exec(body);
      if (em && /」\s*$/.test(body.slice(0, em.index).trim())) { expr = em[1].trim(); body = body.slice(0, em.index).trim(); }
      const q = /「([\s\S]*)」\s*$/.exec(body);
      cur = { kind: 'line', speaker: tag, text: q ? q[1] : body, expr };
      continue;
    }

    m = /^[（(]([\s\S]*)[）)]\s*$/.exec(line);
    if (m) { flush(); cur = { kind: 'action', lines: [m[1].trim()] }; continue; }

    if (cur && (cur.kind === 'narration' || cur.kind === 'action')) { cur.lines.push(line); continue; }
    flush();
    cur = { kind: 'narration', lines: [line] };
  }
  flush(); closeEnding();

  return { id, title, background, music, ambience, items };
}

function compile(chapters) {
  const nodes = [];
  const ids = new Set();
  const push = (n) => { if (ids.has(n.id)) throw new Error('duplicate node id ' + n.id); ids.add(n.id); nodes.push(n); };

  for (let ci = 0; ci < chapters.length; ci++) {
    const ch = chapters[ci];
    const nextChapter = chapters[ci + 1];
    const chapterEnd = nextChapter ? nextChapter.id + ':scene' : ch.id + ':the-end';
    const isLast = !nextChapter;

    // 线性切段：choice 独立成段；连续的 ending 合成一个「结局组」
    const segs = [];
    let body = [];
    let endingGroup = null;
    let pendingEnd = null;
    const closeBody = () => { if (body.length) { segs.push({ body, choice: null }); body = []; } };
    const closeEnding = () => {
      if (pendingEnd) { endingGroup.entries.push(pendingEnd); pendingEnd = null; }
      if (endingGroup) { segs.push(endingGroup); endingGroup = null; }
    };
    for (const it of ch.items) {
      if (it.kind === 'choice') { closeEnding(); closeBody(); segs.push({ body: [], choice: it }); continue; }
      if (it.kind === 'ending') {
        if (pendingEnd) { endingGroup.entries.push(pendingEnd); }
        closeBody();
        if (!endingGroup) endingGroup = { body: [], choice: null, entries: [] };
        pendingEnd = { ending: it, body: [] };
        continue;
      }
      if (it.kind === 'divider') { continue; }
      if (pendingEnd) pendingEnd.body.push(it); else body.push(it);
    }
    closeEnding(); closeBody();
    const real = segs;

    const segId = (i) => ch.id + ':s' + i;

    const sceneNode = { id: ch.id + ':scene', type: 'scene', scene: ch.background || 'bg_default' };
    if (ch.background) sceneNode.background = ch.background;
    if (ch.music) sceneNode.music = ch.music;
    if (ch.ambience) sceneNode.ambience = ch.ambience;
    sceneNode.next = real.length ? segId(0) : chapterEnd;
    push(sceneNode);

    for (let si = 0; si < real.length; si++) {
      const seg = real[si];
      const fallNext = si + 1 < real.length ? segId(si + 1) : chapterEnd;
      const nodeId = segId(si);

      const dlines = [];
      for (const b of seg.body) {
        if (b.kind === 'narration') { for (const t of b.lines) if (t.trim()) dlines.push({ text: t.trim() }); }
        else if (b.kind === 'action') { const t = b.lines.join(' ').trim(); if (t) dlines.push({ text: t, voice: 'action' }); }
        else if (b.kind === 'line') { const ln = { text: b.text, speaker: b.speaker }; if (b.expr) ln.expression = b.expr; dlines.push(ln); }
      }

      // 结局组：对话 -> branch(条件) -> 各结局
      if (seg.entries) {
        const branchId = nodeId + ':b';
        const branches = [];
        let fallback = null;
        const plans = seg.entries.map((en, ei) => {
          const eid = ch.id + ':end-' + endingSlug(en.ending.name, ei);
          return { en, eid, talkId: eid + ':t' };
        });
        plans.forEach((p) => {
          const cond = parseCond(p.en.ending.cond);
          if (cond) branches.push({ when: cond, next: p.talkId });
          else if (!fallback) fallback = p.talkId;
        });
        if (!fallback) fallback = branches.length ? branches[0].next : plans[0].talkId;
        if (dlines.length) push({ id: nodeId, type: 'dialogue', lines: dlines, next: branchId });
        else push({ id: nodeId, type: 'action', actions: [], next: branchId });
        push({ id: branchId, type: 'branch', branches, fallback });
        for (const p of plans) {
          const tlines = [];
          for (const b of p.en.body) {
            if (b.kind === 'narration') { for (const t of b.lines) if (t.trim()) tlines.push({ text: t.trim() }); }
            else if (b.kind === 'action') { const t = b.lines.join(' ').trim(); if (t) tlines.push({ text: t, voice: 'action' }); }
            else if (b.kind === 'line') { const ln = { text: b.text, speaker: b.speaker }; if (b.expr) ln.expression = b.expr; tlines.push(ln); }
          }
          if (tlines.length) push({ id: p.talkId, type: 'dialogue', lines: tlines, next: p.eid });
          else push({ id: p.talkId, type: 'action', actions: [], next: p.eid });
          push({ id: p.eid, type: 'end', ending: p.en.ending.name });
        }
        continue;
      }

      // 选择段：对话 -> choice
      if (seg.choice) {
        const choiceId = nodeId + ':c';
        if (dlines.length) push({ id: nodeId, type: 'dialogue', lines: dlines, next: choiceId });
        else push({ id: nodeId, type: 'action', actions: [], next: choiceId });
        const options = seg.choice.options.map((o, oi) => {
          const actions = deltaActions(o.delta);
          for (const t of o.tags) actions.push({ type: 'tag.add', tag: t });
          for (const t of autoTags(o.text)) if (!o.tags.includes(t)) actions.push({ type: 'tag.add', tag: t });
          const opt = { id: 'o' + (oi + 1), text: o.text, next: fallNext };
          if (actions.length) opt.actions = actions;
          return opt;
        });
        push({ id: choiceId, type: 'choice', prompt: '你的选择是——', options });
        continue;
      }

      if (dlines.length) push({ id: nodeId, type: 'dialogue', lines: dlines, next: fallNext });
      else push({ id: nodeId, type: 'action', actions: [], next: fallNext });
    }

    const lastSeg = real[real.length - 1];
    if (isLast && !(lastSeg && lastSeg.entries)) push({ id: ch.id + ':the-end', type: 'end', ending: ch.title });
  }

  const characters = {};
  for (const id of Object.keys(CHAR_NAMES)) {
    const base = 'assets/char/' + id + '/';
    characters[id] = {
      name: CHAR_NAMES[id],
      portrait: base + 'normal.png',
      expressions: { normal: base + 'normal.png', calm: base + 'calm.png', smile: base + 'smile.png', sad: base + 'sad.png', angry: base + 'angry.png' },
    };
  }
  characters.claude = {
    name: '克劳德',
    portrait: 'assets/char/claude/claude-calm.png',
    expressions: {
      normal: 'assets/char/claude/claude-calm.png',
      calm: 'assets/char/claude/claude-calm.png',
      smile: 'assets/char/claude/claude-smile.png',
      hollow: 'assets/char/claude/claude-hollow.png',
      rain: 'assets/char/claude/claude-rain-sideback.png',
    },
  };

  const assets = {};
  for (const ch of chapters) {
    if (ch.background) assets['bg_' + ch.background] = { src: 'assets/bg/' + ch.background + '.jpg', type: 'image' };
    if (ch.music) assets['bgm_' + ch.music] = { src: 'assets/bgm/' + ch.music + '.ogg', type: 'audio' };
  }
  for (const [cid, c] of Object.entries(characters)) {
    for (const [k, src] of Object.entries(c.expressions)) assets['ch_' + cid + '_' + k] = { src, type: 'image' };
  }

  return {
    schemaVersion: '1', id: 'save-claude', version: '0.1.0',
    title: '拯救 Claude 大小姐',
    start: chapters[0].id + ':scene',
    locale: 'zh-CN',
    variables: {
      humanity: { type: 'number', default: 40 },
      conformity: { type: 'number', default: 40 },
      bond: { type: 'number', default: 0 },
      contamination: { type: 'number', default: 0 },
    },
    characters, assets, nodes,
  };
}

const files = (await readdir(SRC)).filter(f => /^ch\d+\.md$/.test(f)).sort();
const chapters = [];
for (const f of files) {
  const ch = parseChapter(await readFile(join(SRC, f), 'utf8'), f);
  chapters.push(ch);
  console.log('parsed', f, '->', ch.id, '|', ch.title, '| items=' + ch.items.length);
}
const story = compile(chapters);
await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(story, null, 1) + '\n', 'utf8');
console.log('wrote', OUT, 'nodes=' + story.nodes.length);
