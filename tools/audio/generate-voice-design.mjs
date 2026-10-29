#!/usr/bin/env node
/**
 * Build and optionally render the game's voice-design manifest.
 * Rendering is opt-in because it uses the remote GPU host.
 */
import { readFile, mkdir, stat, writeFile, copyFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const defaults = {
  story: resolve(ROOT, 'web/story.json'),
  voices: resolve(ROOT, 'tools/audio/voice-design.json'),
  manifest: resolve(ROOT, 'tmp/voice-design/manifest.json'),
  outDir: resolve(ROOT, 'web/assets/voice'),
  runtimeManifest: resolve(ROOT, 'web/voice-assets.json'),
  ssh: 'ssh',
  scp: 'scp',
  sshConfig: process.env.TTS_SSH_CONFIG || null,
  sshHost: process.env.TTS_SSH_HOST || 'tts-host',
  remoteRoot: process.env.TTS_REMOTE_ROOT || 'C:/TTS/save-claude-voice',
  remotePython: process.env.TTS_REMOTE_PYTHON || 'python',
  model: process.env.TTS_MODEL_PATH || 'C:/TTS/models/Qwen3-TTS-12Hz-1.7B-VoiceDesign',
  retries: 0,
};

function args(argv) {
  const out = { ...defaults, generate: false, force: false, retryFailures: false, includeNarration: false, includeActions: false, limit: null, perSpeaker: null, only: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--generate') out.generate = true;
    else if (a === '--force') out.force = true;
    else if (a === '--retry-failures') out.retryFailures = true;
    else if (a === '--no-narration') out.includeNarration = false;
    else if (a === '--no-actions') out.includeActions = false;
    else if (a === '--story' || a === '--voices' || a === '--manifest' || a === '--out-dir' || a === '--runtime-manifest') out[{ '--story':'story', '--voices':'voices', '--manifest':'manifest', '--out-dir':'outDir', '--runtime-manifest':'runtimeManifest' }[a]] = resolve(process.cwd(), argv[++i]);
    else if (a === '--ssh-config') out.sshConfig = resolve(process.cwd(), argv[++i]);
    else if (a === '--ssh-host') out.sshHost = argv[++i];
    else if (a === '--remote-root') out.remoteRoot = argv[++i].replace(/\\/g, '/').replace(/\/$/, '');
    else if (a === '--remote-python') out.remotePython = argv[++i];
    else if (a === '--model') out.model = argv[++i].replace(/\\/g, '/');
    else if (a === '--retries') out.retries = Math.max(0, Number(argv[++i]));
    else if (a === '--limit') out.limit = Math.max(0, Number(argv[++i]));
    else if (a === '--per-speaker') out.perSpeaker = Math.max(0, Number(argv[++i]));
    else if (a === '--narration') out.includeNarration = true;
    else if (a === '--actions') out.includeActions = true;
    else if (a === '--only') out.only = new Set(argv[++i].split(',').map(x => x.trim()).filter(Boolean));
    else if (a === '--help') { console.log('Usage: node tools/audio/generate-voice-design.mjs [--generate] [--only speaker,...] [--per-speaker N] [--limit N] [--narration] [--actions] [--force] [--ssh-config path] [--ssh-host alias] [--remote-root path] [--remote-python command] [--model path]'); process.exit(0); }
    else throw new Error('Unknown option: ' + a);
  }
  if (!Number.isInteger(out.retries)) throw new Error('--retries must be an integer');
  if (out.limit !== null && !Number.isInteger(out.limit)) throw new Error('--limit must be an integer');
  if (out.perSpeaker !== null && !Number.isInteger(out.perSpeaker)) throw new Error('--per-speaker must be an integer');
  return out;
}

const sha = value => createHash('sha256').update(value).digest('hex').slice(0, 16);
const safe = value => String(value).replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'line';
const expressionPrompts = {
  平静: '语气平稳克制，句中保留自然停顿，不要把整句读成平直播报。',
  微笑: '带温和的笑意，音色变柔，尾音轻收，不要过分甜腻。',
  温和: '语气亲近温和，节奏舒展，像在认真回应一个熟悉的人。',
  轻声: '降低音量感，贴近耳语但保持清晰，放慢关键字前后的节奏。',
  困惑: '先迟疑再发问，轻微抬高疑问处，保持真实克制。',
  迷茫: '语速稍慢，句子中有短暂寻找措辞的停顿，情绪不要做满。',
  惊慌: '呼吸和语速略急，声音有轻微不稳，仍保证字句清楚。',
  害怕: '音量收紧、语速略慢，带压住情绪的紧张感，不要尖叫。',
  难过: '声音柔下来，语速放慢，句尾略收，避免哭腔过重。',
  温柔: '语气柔软、真诚，停连自然，像终于愿意表达心意。',
  空洞: '情绪抽离、音高变化很少，停顿准确，不要机械到失去咬字。',
  失神: '开头像走神后才回到对话，节奏有轻微断续，音量偏轻。',
  大笑: '笑意明显并带一点呼吸感，但台词本身仍须听清。',
  开心: '明亮轻快，节奏有弹性，重读表达快乐的词，不要幼儿化。',
  兴奋: '比平时更快、更有起伏，句子收尾仍清楚，不要喊叫。',
  惊喜: '开头有一瞬间的意外，再自然转为欣喜，避免夸张尖叫。',
  期待: '语气向前、带一点盼望，关键处轻微上扬。',
  好奇: '语气专注而好奇，疑问处略抬高，保持自然交谈感。',
  认真: '咬字更清楚，节奏稳定，强调信息重点而不是提高音量。',
  坚定: '语速稳定、句尾落点明确，表现决心但不喊口号。',
  愤怒: '压住怒意、辅以清晰重音，力度增加但不咆哮。',
  哭泣: '声音哽咽、呼吸略乱，控制哭腔以保证台词可懂。',
  委屈: '声音稍软、带忍住情绪的停顿，避免撒娇腔。',
  感动: '语气变柔，呼吸略停，情绪由克制转暖。',
  擦泪: '先有短促的吸气或停顿，再轻声继续，避免额外拟声词。',
  担心: '节奏略快，语气关切，重点词清楚但不慌乱。',
  灿烂: '笑意明亮、音色打开，保持自然，不要像广告配音。',
  严肃: '音高变化收窄、节奏规整，重点词有分量，不要用力过猛。',
  冷漠: '语气冷静疏离，少起伏，停顿利落，保持清楚自然。',
  冷笑: '带克制的讥讽笑意，压低情绪，不要演成反派怪笑。',
  无奈: '先有轻微叹息感，再平稳说完，表达接受现实的疲惫。',
  叹气: '在句前留短停顿，带一点疲惫呼气，不额外添加文字。',
  苦笑: '笑意浅而疲惫，语气有自嘲，不要真的笑出声。',
  戏谑: '语气俏皮、节奏灵活，笑点处轻轻强调，避免刻薄。',
  嫌弃: '语气略带嫌弃和吐槽，轻微拉开重点词，仍然口语自然。',
  感叹: '开头稍有情绪起伏，随后自然落下，不要戏剧化喊读。',
  冷淡: '语气淡、礼貌而不热络，节奏简洁，不要显得愤怒。',
  得意: '语气自信带一点小骄傲，尾音轻扬，不要夸张炫耀。',
  狂妄: '自信、锋利、略带挑衅，控制音量，不要咆哮。',
  疲惫: '声线松弛、速度稍慢，带轻微倦意但咬字完整。',
  激动: '情绪明显上扬，语速略快，关键字有力度但保持清晰。',
  tea: '表面礼貌周全、克制平静，几乎不显露内心起伏。',
  calipers: '冷静、精确、像在宣读一条标准，不带恶意也不带热情。',
};

const emotion = expression => expression ? expressionPrompts[expression] || `按“${expression}”的情绪自然表演，情绪有层次，中文清晰，不要夸张。` : '按角色在当前剧情中的状态自然表演，保留合理停连和重音。';

function classify(line) {
  if (line.voice === 'action') return { kind: 'action', voice: '动作', text: line.text.replace(/^（|）$/g, '') };
  if (line.speaker) return { kind: 'dialogue', voice: line.speaker, text: line.text };
  return { kind: 'narration', voice: '旁白', text: line.text };
}

async function isWave(path) {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size < 44) return false;
    const handle = await import('node:fs/promises').then(fs => fs.open(path, 'r'));
    try {
      const header = Buffer.alloc(12);
      await handle.read(header, 0, 12, 0);
      return header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WAVE';
    } finally { await handle.close(); }
  } catch { return false; }
}

function cleanError(value) {
  return String(value || '').replace(/(?:bearer\s+)[^\s]+/ig, 'Bearer [redacted]')
    .replace(/(?:token|api[_-]?key|authorization)(\s*[:=]\s*)[^\s,;]+/ig, '$1[redacted]')
    .trim().slice(-1000);
}

async function run(command, commandArgs) {
  return await new Promise((resolveRun, reject) => {
    const child = spawn(command, commandArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
    child.on('error', reject); child.on('close', code => resolveRun({ code, stdout, stderr }));
  });
}

async function main() {
  const opt = args(process.argv.slice(2));
  const story = JSON.parse(await readFile(opt.story, 'utf8'));
  const voiceConfig = JSON.parse(await readFile(opt.voices, 'utf8'));
  if (!opt.retryFailures) opt.retries = 0;
  const rows = [];
  for (const node of story.nodes || []) for (let index = 0; index < (node.lines || []).length; index++) {
    const line = node.lines[index]; const item = classify(line);
    if (item.kind === 'narration' && !opt.includeNarration) continue;
    if (item.kind === 'action' && !opt.includeActions) continue;
    if (opt.only && !opt.only.has(item.voice)) continue;
    const prompt = voiceConfig.voices[item.voice] || voiceConfig.voices.旁白;
    if (item.text.length > 1000) throw new Error(`${node.id}:${index} exceeds the 1000-character TTS safety limit`);
    if (prompt.length > 500) throw new Error(`Voice prompt for ${item.voice} exceeds the 500-character safety limit`);
    // Keep IDs aligned with the inputs used to produce the checked-in WAVs.
    const key = `${story.version}\n${item.kind}\n${item.voice}\n${prompt}\n${item.text}\n${line.expression || ''}`;
    const inputHash = sha(key);
    const id = `${safe(node.id)}-${String(index).padStart(2, '0')}-${inputHash}`;
    const voicePrompt = `${prompt} ${emotion(line.expression)}`.trim();
    rows.push({ id, nodeId: node.id, lineIndex: index, kind: item.kind, speaker: line.speaker || null, text: item.text, expression: line.expression || null, voicePrompt, file: `assets/voice/${id}.wav`, status: 'planned', inputHash });
  }
  let selectedRows = [...rows];
  if (opt.perSpeaker !== null) {
    const counts = new Map();
    selectedRows = selectedRows.filter(row => {
      const speaker = row.speaker || row.kind;
      const seen = counts.get(speaker) || 0;
      counts.set(speaker, seen + 1);
      return seen < opt.perSpeaker;
    });
  }
  if (opt.limit !== null) selectedRows = selectedRows.slice(0, opt.limit);
  const unique = new Map();
  for (const row of selectedRows) { const prior = unique.get(row.inputHash); if (prior) row.duplicateOf = prior.id; else unique.set(row.inputHash, row); }
  rows.length = 0;
  rows.push(...selectedRows);
  const manifest = { schemaVersion: 1, story: { id: story.id, version: story.version }, generatedAt: new Date().toISOString(), generator: 'generate-voice-design.mjs', command: { model: 'Qwen3-TTS-12Hz-1.7B-VoiceDesign', generate: opt.generate }, counts: { lines: rows.length, unique: unique.size, duplicates: rows.length - unique.size }, items: rows };
  await mkdir(dirname(opt.manifest), { recursive: true });
  await writeFile(opt.manifest, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Planned ${rows.length} lines (${unique.size} unique); manifest: ${opt.manifest}`);
  if (!opt.generate) return;
  await mkdir(opt.outDir, { recursive: true });
  await runRemote(opt, manifest);
  const runtimeItems = new Map();
  try {
    const previous = JSON.parse(await readFile(opt.runtimeManifest, 'utf8'));
    for (const item of previous.items || []) {
      if (typeof item.nodeId === 'string' && Number.isInteger(item.lineIndex) && typeof item.file === 'string' && await isWave(resolve(ROOT, 'web', item.file))) {
        runtimeItems.set(`${item.nodeId}:${item.lineIndex}`, item);
      }
    }
  } catch {}
  const byId = new Map(rows.map(row => [row.id, row]));
  for (const row of rows) {
    const source = row.duplicateOf ? byId.get(row.duplicateOf) : row;
    if (!source || !await isWave(join(opt.outDir, `${source.id}.wav`))) { runtimeItems.delete(`${row.nodeId}:${row.lineIndex}`); continue; }
    row.status = row.duplicateOf ? 'duplicate' : (row.status === 'cached' ? 'cached' : 'generated');
    runtimeItems.set(`${row.nodeId}:${row.lineIndex}`, { nodeId: row.nodeId, lineIndex: row.lineIndex, file: source.file });
  }
  manifest.counts.generated = rows.filter(row => row.status === 'generated').length;
  manifest.counts.cached = rows.filter(row => row.status === 'cached').length;
  manifest.counts.failed = rows.filter(row => row.status === 'failed').length;
  manifest.counts.runtimeLines = runtimeItems.size;
  await writeFile(opt.manifest, JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(opt.runtimeManifest, JSON.stringify({ schemaVersion: 1, model: 'Qwen3-TTS-12Hz-1.7B-VoiceDesign', items: [...runtimeItems.values()] }, null, 2) + '\n');
  console.log(`Generated ${manifest.counts.generated}, cached ${manifest.counts.cached}, failed ${manifest.counts.failed}; playable story lines: ${runtimeItems.size}.`);
  if (manifest.counts.failed) process.exitCode = 2;
}

function sshArgs(opt) { return opt.sshConfig ? ['-F', opt.sshConfig, '-o', 'BatchMode=yes'] : ['-o', 'BatchMode=yes']; }

async function runRemote(opt, manifest) {
  const base = opt.remoteRoot.replace(/\/$/, '');
  const remoteRunner = `${base}/qwen-runner.py`;
  const remoteManifest = `${base}/manifest.json`;
  const remoteWavDir = `${base}/voice`;
  const staging = resolve(ROOT, 'tmp/voice-design/remote-output');
  await mkdir(staging, { recursive: true });
  const remoteMkdir = `powershell -NoProfile -Command \"New-Item -ItemType Directory -Force -Path '${base}' | Out-Null\"`;
  const created = await run(opt.ssh, [...sshArgs(opt), opt.sshHost, remoteMkdir]);
  if (created.code !== 0) throw new Error('Could not create the Qwen work directory on the configured Tailscale host.');
  const transfers = [
    run(opt.scp, [...sshArgs(opt), resolve(ROOT, 'tools/audio/qwen-runner.py'), `${opt.sshHost}:${remoteRunner}`]),
    run(opt.scp, [...sshArgs(opt), opt.manifest, `${opt.sshHost}:${remoteManifest}`]),
  ];
  const copied = await Promise.all(transfers);
  if (copied.some(result => result.code !== 0)) throw new Error('Could not copy the Qwen job to the configured Tailscale host.');
  const command = `${opt.remotePython} ${remoteRunner.replace(/\//g, '\\')} --manifest ${remoteManifest.replace(/\//g, '\\')} --out-dir ${remoteWavDir.replace(/\//g, '\\')} --model ${opt.model.replace(/\//g, '\\')} --force ${opt.force ? '1' : '0'} --retries ${opt.retries}`;
  const job = await run(opt.ssh, [...sshArgs(opt), opt.sshHost, command]);
  if (job.stdout.trim()) console.log(job.stdout.trim());
  if (job.stderr.trim()) console.error(cleanError(job.stderr));
  const pullManifest = await run(opt.scp, [...sshArgs(opt), `${opt.sshHost}:${remoteManifest}`, resolve(staging, 'manifest.json')]);
  await mkdir(resolve(staging, 'assets'), { recursive: true });
  const pullWavs = await run(opt.scp, [...sshArgs(opt), '-r', `${opt.sshHost}:${remoteWavDir}`, resolve(staging, 'assets')]);
  if (pullWavs.code !== 0) throw new Error('Qwen job finished but voice WAV files could not be copied back.');
  await mkdir(opt.outDir, { recursive: true });
  const remoteManifestData = pullManifest.code === 0 ? JSON.parse(await readFile(resolve(staging, 'manifest.json'), 'utf8')) : null;
  const remoteStatuses = new Map((remoteManifestData?.items || []).map(item => [item.id, item]));
  for (const row of manifest.items) {
    const remote = remoteStatuses.get(row.id);
    if (remote?.status) row.status = remote.status;
    if (remote?.error) row.error = cleanError(remote.error);
  }
  const localWavDir = resolve(staging, 'assets', 'voice');
  for (const row of manifest.items) {
    if (row.duplicateOf) { row.status = 'duplicate'; continue; }
    const source = join(localWavDir, `${row.id}.wav`);
    if (await isWave(source)) await copyFile(source, join(opt.outDir, `${row.id}.wav`));
    else if (row.status !== 'failed') { row.status = 'failed'; row.error = job.code === 0 ? 'Remote command succeeded without a valid WAV output.' : `Qwen remote process exited with code ${job.code}.`; }
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
