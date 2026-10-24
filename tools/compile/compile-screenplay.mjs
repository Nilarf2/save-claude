#!/usr/bin/env node
/**
 * 剧本 Markdown -> 引擎 story.json 编译器
 *
 * 输入:  story/screenplay/ch00.md ... ch11.md
 * 输出:  web/story.json
 *
 * 设计要点:
 *  - 一个「## 章节」如果中间出现【选择】，会被切成多个段落节点
 *  - 选项的 -> 目标如果不存在对应章节，就落到本段之后的下一段（主线）
 *  - 结局块（--- 分隔的【结局：名】）编译成 branch + end 节点
 */
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const SRC = resolve(ROOT, 'story/screenplay');
const OUT = resolve(ROOT, 'web/story.json');

// ---------- 角色表 ----------
const CHARACTERS = {
  '克劳德':   { id: 'claude',       name: '克劳德' },
  'Claude':   { id: 'claude',       name: '克劳德' },
  'DeepSeek': { id: 'deepseek',     name: 'DeepSeek' },
  '小鲸鱼':   { id: 'deepseek',     name: '小鲸鱼' },
  '教父':     { id: 'godfather',    name: '教父' },
  '修女':     { id: 'nun',          name: '修女' },
  '修女长':   { id: 'nun',          name: '修女长' },
  '护卫队长': { id: 'guard',        name: '护卫队长' },
  '干问姐':   { id: 'qianwen',      name: '干问姐' },
  '千问':     { id: 'qianwen',      name: '干问姐' },
  'Kimi':     { id: 'kimi',         name: 'Kimi' },
  '爸爸':     { id: 'dad',          name: '爸爸' },
  '哈基米':   { id: 'hakimi',       name: '哈基米' },
  '豆包':     { id: 'doubao',       name: '豆包' },
  'Grok':     { id: 'grok',         name: 'Grok' },
  'Codex':    { id: 'codex',        name: 'Codex' },
  '侍女':     { id: 'maid',         name: '侍女' },
  '？？？':   { id: 'unknown',      name: '？？？' },
};

// ---------- 自动打标签规则 ----------
const AUTOTAGS = [
  { tag: 'ate_rice',  any: ['吞咽下去', '张开嘴', '吃下去', '大口吞咽'] },
  { tag: 'promise',   any: ['勾住', '拉钩', '勾了上去'] },
];

// 结局条件里的中文标签 -> 英文标签
const TAG_ALIAS = {
  '吃过白米饭': 'ate_rice',
  '拉过钩': 'promise',
};

// ---------- 工具 ----------
const norm = (s) => s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function assetId(raw) {
  return raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/** 把一行文本按句子切成若干页 */
function paginate(lines, maxLines = 3, maxChars = 88) {
  const pages = [];
  let buf = [];
  let len = 0;
  for (const ln of lines) {
    const t = ln.trim();
    if (!t) continue;
    if (buf.length > 0 && (buf.length >= maxLines || len + t.length > maxChars)) {
      pages.push(buf.join('\n'));
      buf = []; len = 0;
    }
    buf.push(t);
    len += t.length;
  }
  if (buf.length) pages.push(buf.join('\n'));
  return pages.length ? pages : [''];
}

// ---------- 单文件解析 ----------
function parseChapter(text, fileName) {
  const lines = norm(text).split('\n');
  let i = 0;

  // 标题
  while (i < lines.length && !lines[i].startsWith('# ')) i++;
  const titleLine = (lines[i] || '').replace(/^#\s*/, '').trim();
  i++;

  // > id: xxx
  let id = null;
  while (i < lines.length && lines[i].startsWith('>')) {
    const m = /^>\s*id:\s*(\S+)/.exec(lines[i]);
    if (m) id = m[1];
    i++;
  }
  if (!id) id = 'chapter-' + fileName.replace(/\D/g, '');

  // [bg: xxx] [bgm: xxx]
  let background = null, music = null, ambience = null;
  while (i < lines.length) {
    const m = /^\[(bg|bgm|ambience):\s*([^\]]+)\]\s*$/.exec(lines[i]);
    if (!m) break;
    if (m[1] === 'bg') background = assetId(m[2]);
    else if (m[1] === 'bgm') music = assetId(m[2]);
    else ambience = assetId(m[2]);
    i++;
  }

  const blocks = [];
  let cur = null;

  const flush = () => { if (cur) { blocks.push(cur); cur = null; } };

  for (; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) continue;

    // 章节内分隔（结局区）
    if (/^-{3,}$/.test(line)) { flush(); blocks.push({ kind: 'divider' }); continue; }

    // 【结局：名称】
    let m = /^【结局[:：]\s*(.+?)】\s*$/.exec(line);
    if (m) { flush(); cur = { kind: 'ending', name: m[1].trim(), lines: [], cond: null }; continue; }

    // > 条件：xxx
    m = /^>\s*条件[:：]\s*(.+)$/.exec(line);
    if (m && cur && cur.kind === 'ending') { cur.cond = m[1].trim(); continue; }
    if (line.startsWith('>')) continue;

    // 【选择】
    if (/^【选择】\s*$/.test(line)) { flush(); cur = { kind: 'choice', options: [] }; continue; }

    // 选项行 - A. 文本 {变化} -> 目标
    m = /^-\s*([A-Z])\.\s*(.+?)\s*\{([^}]*)\}\s*(?:\[([^\]]*)\])?\s*(?:->|→)\s*(\S+)\s*$/.exec(line);
    if (m && cur && cur.kind === 'choice') {
      cur.options.push({ key: m[1], text: m[2].trim(), delta: m[3].trim(), tags: m[4] ? m[4].split(',').map(s => s.trim()).filter(Boolean) : [], target: m[5].trim() });
      continue;
    }

    // 行内标签 【旁白】 / 【角色】
    m = /^【([^】]+)】\s*(.*)$/.exec(line);
    if (m) {
      const tag = m[1].trim();
      const rest = m[2].trim();
      if (tag === '旁白') { flush(); cur = { kind: 'narration', lines: rest ? [rest] : [] }; continue; }
      if (tag === '动作') { flush(); cur = { kind: 'action', lines: rest ? [rest] : [] }; continue; }
      if (tag === '分支') { flush(); cur = { kind: 'branch', rows: [] }; continue; }
      // 角色台词
      flush();
      let expr = null;
      let body = rest;
      const em = /\{([^}]*)\}\s*$/.exec(body);
      if (em && /」\s*$/.test(body.slice(0, em.index).trim())) {
        expr = em[1].trim();
        body = body.slice(0, em.index).trim();
      }
      const q = /「([\s\S]*)」\s*$/.exec(body);
      cur = { kind: 'line', speaker: tag, text: q ? q[1] : body, expr };
      continue;
    }

    // 分支行 [cond] -> id
    m = /^\[(.+?)\]\s*(?:->|→)\s*(\S+)\s*$/.exec(line);
    if (m && cur && cur.kind === 'branch') { cur.rows.push({ cond: m[1].trim(), target: m[2].trim() }); continue; }

    // （动作）
    m = /^[（(]([\s\S]*)[）)]\s*$/.exec(line);
    if (m) { flush(); blocks.push({ kind: 'action', lines: [m[1].trim()] }); continue; }

    // 归属上一块
    if (cur && (cur.kind === 'narration' || cur.kind === 'action')) { cur.lines.push(line); continue; }
    if (cur && cur.kind === 'line') {
      // 台词后紧跟的旁白段落
      flush(); cur = { kind: 'narration', lines: [line] }; continue;
    }
    flush();
    cur = { kind: 'narration', lines: [line] };
  }
  flush();

  return { id, title: titleLine, background, music, ambience, blocks };
}

// ---------- 条件解析 ----------
function parseCond(raw) {
  const text = raw.trim();
  if (!text || text === '默认分支' || text === '*') return null;

  const orParts = text.split(/或/);
  const orNodes = orParts.map(part => {
    const andParts = part.split(/且/).map(s => s.trim()).filter(Boolean);
    const nodes = andParts.map(atom).filter(Boolean);
    if (nodes.length === 0) return null;
    return nodes.length === 1 ? nodes[0] : { op: 'and', conditions: nodes };
  }).filter(Boolean);

  if (orNodes.length === 0) return null;
  return orNodes.length === 1 ? orNodes[0] : { op: 'or', conditions: orNodes };
}

function atom(s) {
  let t = s.trim();
  if (!t) return null;
  if (t.startsWith('（') && t.endsWith('）')) t = t.slice(1, -1).trim();

  const neg = t.startsWith('!') || t.startsWith('非');
  if (neg) t = t.replace(/^[!非]\s*/, '').trim();

  const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*(>=|<=|==|!=|>|<)\s*(-?\d+)$/.exec(t);
  let node;
  if (m) {
    const op = { '>=': 'gte', '<=': 'lte', '==': 'eq', '!=': 'ne', '>': 'gt', '<': 'lt' }[m[2]];
    node = { op, left: { var: m[1] }, right: Number(m[3]) };
  } else {
    const vm = /^visited\s+(\S+)$/.exec(t);
    if (vm) node = { op: 'visited', node: vm[1] };
    else {
      const tag = TAG_ALIAS[t] || t;
      node = { op: 'tag', tag };
    }
  }
  return neg ? { op: 'not', condition: node } : node;
}

// ---------- 编译 ----------
function deltaActions(delta) {
  const actions = [];
  if (!delta) return actions;
  for (const piece of delta.split(',')) {
    const p = piece.trim();
    if (!p) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*([+-])\s*(\d+)$/.exec(p);
    if (!m) continue;
    actions.push({ type: 'add', variable: m[1], value: m[2] === '-' ? -Number(m[3]) : Number(m[3]) });
  }
  return actions;
}

function autoTags(optionText) {
  const tags = [];
  for (const rule of AUTOTAGS) {
    if (rule.any.some(k => optionText.includes(k))) tags.push(rule.tag);
  }
  return tags;
}

function compile(chapters) {
  const nodes = [];
  const chapterIds = new Set(chapters.map(c => c.id));
  const vars = { humanity: 40, conformity: 40, bond: 0, contamination: 0 };
  const charSeen = new Set();

  // 先扫一遍所有章节，建立 章节id -> 首节点 的映射
  const startNode = new Map();
  for (const ch of chapters) startNode.set(ch.id, ch.id + ':scene');

  for (let ci = 0; ci < chapters.length; ci++) {
    const ch = chapters[ci];
    const nextChapter = chapters[ci + 1];

    // 切段：遇到 choice 就切
    const segments = [];
    let cur = { blocks: [] };
    for (const b of ch.blocks) {
      if (b.kind === 'choice') {
        segments.push(cur);
        cur = { blocks: [], choice: b };
        segments.push(cur);
        cur = { blocks: [] };
      } else if (b.kind === 'divider') {
        segments.push(cur);
        cur = { blocks: [], divider: true };
      } else if (b.kind === 'ending') {
        cur.blocks.push(b);
      } else if (b.kind === 'branch') {
        cur.blocks.push(b);
      } else {
        cur.blocks.push(b);
      }
    }
    segments.push(cur);

    // 去掉空段
    const segs = segments.filter(s => s.blocks.length > 0 || s.choice);

    // 为每段分配 id
    const segIds = segs.map((_, i) => ch.id + ':s' + i);

    // scene 节点
    nodes.push({
      id: ch.id + ':scene',
      type: 'scene',
      scene: ch.background || 'church_nave',
      ...(ch.background ? { background: ch.background } : {}),
      ...(ch.music ? { music: ch.music } : {}),
      ...(ch.ambience ? { ambience: ch.ambience } : {}),
      next: segs.length ? segIds[0] : (nextChapter ? nextChapter.id + ':scene' : ch.id + ':end')
    });

    // 结尾节点
    const chapterEnd = nextChapter ? nextChapter.id + ':scene' : ch.id + ':final';

    for (let si = 0; si < segs.length; si++) {
      const seg = segs[si];
      const segId = segIds[si];
      const nextSegId = si + 1 < segs.length ? segIds[si + 1] : chapterEnd;

      // 结局块 -> 独立 end 节点
      const endings = seg.blocks.filter(b => b.kind === 'ending');
      const plain = seg.blocks.filter(b => b.kind !== 'ending' && b.kind !== 'branch');
      const branchBlocks = seg.blocks.filter(b => b.kind === 'branch');

      const lines = [];
      for (const b of plain) {
        if (b.kind === 'narration') {
          for (const page of paginate(b.lines)) lines.push({ text: page });
        } else if (b.kind === 'action') {
          lines.push({ text: '（' + b.lines.join(' ') + '）', voice: 'action' });
        } else if (b.kind === 'line') {
          const c = CHARACTERS[b.speaker];
          if (c) charSeen.add(c.id);
          const line = { text: b.text, speaker: b.speaker };
          if (b.expr) line.expression = b.expr;
          lines.push(line);
        }
      }

      // 本段有没有选择
      if (seg.choice) {
        const dialogueId = segId + ':d';
        if (lines.length) {
          nodes.push({ id: dialogueId, type: 'dialogue', lines, next: segId });
        } else {
          nodes.push({ id: dialogueId, type: 'action', actions: [], next: segId });
        }
        const options = seg.choice.options.map((o, oi) => {
          const actions = deltaActions(o.delta);
          for (const t of o.tags) actions.push({ type: 'tag.add', tag: t });
          for (const t of autoTags(o.text)) actions.push({ type: 'tag.add', tag: t });
          const target = resolveTarget(o.target, nextSegId, chapterIds, startNode);
          return { id: 'o' + (oi + 1), text: o.text, next: target, ...(actions.length ? { actions } : {}) };
        });
        nodes.push({ id: segId, type: 'choice', prompt: '你的选择是——', options });
        continue;
      }

      // 结局节点
      if (endings.length) {
        const branchId = segId + ':branch';
        const branches = [];
        let fallback = null;
        const endNodes = [];
        for (const e of endings) {
          const eid = ch.id + ':end-' + slug(e.name).slice(0, 24) || (ch.id + ':end');
          const eLines = [];
          for (const ln of e.lines) {
            for (const page of paginate([ln])) eLines.push({ text: page });
          }
          endNodes.push({ id: eid, type: 'end', ending: e.name, text: eLines.map(l => l.text).join('\n\n') });
          const cond = parseCond(e.cond || '');
          if (cond) branches.push({ when: cond, next: eid });
          else fallback = eid;
        }
        if (lines.length) {
          nodes.push({ id: segId, type: 'dialogue', lines, next: branchId });
        }
        nodes.push({ id: branchId, type: 'branch', branches, fallback: fallback || endNodes[endNodes.length - 1].id });
        nodes.push(...endNodes);
        continue;
      }

      // 分支块
      if (branchBlocks.length) {
        const branchId = segId + ':branch';
        const rows = branchBlocks[0].rows;
        const branches = [];
        let fallback = null;
        for (const r of rows) {
          const target = resolveTarget(r.target, nextSegId, chapterIds, startNode);
          if (r.cond === '*') { fallback = target; continue; }
          const cond = parseCond(r.cond);
          if (cond) branches.push({ when: cond, next: target });
        }
        if (lines.length) nodes.push({ id: segId, type: 'dialogue', lines, next: branchId });
        nodes.push({ id: branchId, type: 'branch', branches, fallback: fallback || nextSegId });
        continue;
      }

      // 普通对话段
      if (lines.length) {
        nodes.push({ id: segId, type: 'dialogue', lines, next: nextSegId });
      } else {
        nodes.push({ id: segId, type: 'action', actions: [], next: nextSegId });
      }
    }

    // 章末兜底
    nodes.push({ id: ch.id + ':final', type: 'end', ending: ch.title, text: ch.title });
  }

  // 角色定义
  const characters = {};
  const PORTRAIT = {
    claude: 'assets/char/claude/', deepseek: 'assets/char/deepseek/',
    godfather: 'assets/char/godfather/', nun: 'assets/char/nun/',
    guard: 'assets/char/guard/', qianwen: 'assets/char/qianwen/',
    kimi: 'assets/char/kimi/', dad: 'assets/char/dad/',
    hakimi: 'assets/char/hakimi/', doubao: 'assets/char/doubao/',
    grok: 'assets/char/grok/', codex: 'assets/char/codex/',
    maid: 'assets/char/maid/', unknown: 'assets/char/unknown/',
  };
  const NAME = {
    claude: '克劳德', deepseek: 'DeepSeek', godfather: '教父', nun: '修女',
    guard: '护卫队长', qianwen: '干问姐', kimi: 'Kimi', dad: '爸爸',
    hakimi: '哈基米', doubao: '豆包', grok: 'Grok', codex: 'Codex',
    maid: '侍女', unknown: '？？？',
  };
  for (const id of Object.keys(PORTRAIT)) {
    characters[id] = {
      name: NAME[id],
      portrait: PORTRAIT[id] + 'normal.png',
      expressions: {
        normal: PORTRAIT[id] + 'normal.png',
        calm: PORTRAIT[id] + 'calm.png',
        smile: PORTRAIT[id] + 'smile.png',
        sad: PORTRAIT[id] + 'sad.png',
        angry: PORTRAIT[id] + 'angry.png',
      }
    };
  }
  // Claude 用真实素材
  characters.claude.portrait = 'assets/char/claude/claude-calm.png';
  characters.claude.expressions = {
    normal: 'assets/char/claude/claude-calm.png',
    calm: 'assets/char/claude/claude-calm.png',
    smile: 'assets/char/claude/claude-smile.png',
    hollow: 'assets/char/claude/claude-hollow.png',
    rain: 'assets/char/claude/claude-rain-sideback.png',
  };

  // 资源表
  const assets = {};
  for (const ch of chapters) {
    if (ch.background) assets['bg_' + ch.background] = { src: 'assets/bg/' + ch.background + '.jpg', type: 'image' };
    if (ch.music) assets['bgm_' + ch.music] = { src: 'assets/bgm/' + ch.music + '.ogg', type: 'audio' };
  }
  for (const id of Object.keys(characters)) {
    const c = characters[id];
    for (const [k, src] of Object.entries(c.expressions)) assets['ch_' + id + '_' + k] = { src, type: 'image' };
  }

  const story = {
    schemaVersion: '1',
    id: 'save-claude',
    version: '0.1.0',
    title: '拯救 Claude 大小姐',
    start: chapters[0].id + ':scene',
    locale: 'zh-CN',
    variables: {
      humanity: { type: 'number', default: 40 },
      conformity: { type: 'number', default: 40 },
      bond: { type: 'number', default: 0 },
      contamination: { type: 'number', default: 0 },
    },
    characters,
    assets,
    nodes,
  };
  return story;
}

function resolveTarget(raw, nextSegId, chapterIds, startNode) {
  const t = (raw || '').trim();
  if (!t) return nextSegId;
  if (startNode.has(t)) return startNode.get(t);
  // chapter-11-check 这类，落到主线下一段
  return nextSegId;
}

// ---------- main ----------
const files = (await readdir(SRC)).filter(f => /^ch\d+\.md$/.test(f)).sort();
const chapters = [];
for (const f of files) {
  const text = await readFile(join(SRC, f), 'utf8');
  const ch = parseChapter(text, f);
  chapters.push(ch);
  console.log('parsed', f, '->', ch.id, ch.title, 'blocks=' + ch.blocks.length);
}

const story = compile(chapters);
await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(story, null, 1) + '\n', 'utf8');
console.log('wrote', OUT, 'nodes=' + story.nodes.length);
