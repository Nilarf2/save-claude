/* Shared by the offline classic-script page and Node authoring tools. No runtime execution. */
(function (root) {
  'use strict';
  const builtins = new Set(['dialogue', 'narration', 'choice', 'branch', 'action', 'scene', 'module', 'end']);
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const reject = message => { throw Error(message); };

  function analyzeGraph(data) {
    const ids = data.nodes.map(node => node.id);
    const outgoing = new Map(ids.map(id => [id, []])), incoming = new Map(ids.map(id => [id, []]));
    for (const edge of data.edges) {
      outgoing.get(edge.from).push(edge.to);
      incoming.get(edge.to).push(edge.from);
    }
    const walk = (starts, graph) => {
      const seen = new Set(), queue = [...starts];
      while (queue.length) {
        const id = queue.pop();
        if (seen.has(id)) continue;
        seen.add(id);
        for (const target of graph.get(id) ?? []) queue.push(target);
      }
      return seen;
    };
    const reachable = walk([data.start], outgoing);
    const customNodes = data.nodes.filter(node => !builtins.has(node.type)).map(node => node.id);
    // Modules have declared outcomes, but completion still depends on a host. Custom nodes may
    // return targets not declared in next; neither kind is treated as a proven dead end.
    const dynamicNodes = data.nodes.filter(node => node.type === 'module' || !builtins.has(node.type)).map(node => node.id);
    const canReachEnd = walk(data.nodes.filter(node => node.type === 'end').map(node => node.id), incoming);
    const canReachUnknown = walk(dynamicNodes, incoming);
    const unknownReachability = customNodes.some(id => reachable.has(id));
    return {
      reachable: ids.filter(id => reachable.has(id)),
      unreachable: unknownReachability ? [] : ids.filter(id => !reachable.has(id)),
      unknownReachability: unknownReachability ? ids.filter(id => !reachable.has(id)) : [],
      orphan: ids.filter(id => id !== data.start && incoming.get(id).length === 0),
      deadEnds: data.nodes.filter(node => node.type !== 'end' && builtins.has(node.type) && node.type !== 'module' && outgoing.get(node.id).length === 0).map(node => node.id),
      cannotReachEnd: ids.filter(id => !canReachEnd.has(id) && !canReachUnknown.has(id)),
      unknownEnd: ids.filter(id => !canReachEnd.has(id) && canReachUnknown.has(id)),
      dynamicNodes,
      conditionalEdges: data.edges.filter(edge => edge.when !== undefined || edge.disabledWhen !== undefined).length,
      notes: [
        '静态分析只看已声明连线，忽略条件真假、变量、随机值和选项禁用；静态连通不证明玩家实际可通关。',
        '零入边表示已声明边中没有入口；自定义节点可能动态返回未声明目标。模块完成时间与结果依赖宿主。',
        '结局节点允许没有出边；到达动态扩展或模块而缺少已知结局路径时标为无法判断，不认定为死路。'
      ]
    };
  }

  function assertData(value, depth = 0) {
    if (depth > 100) reject('证据嵌套过深');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (Array.isArray(value)) { for (const child of value) assertData(child, depth + 1); return; }
    if (!object(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) reject('证据必须是有限 JSON 数据');
    // JSON object keys stay data; dictionaries may use names inherited by plain objects.
    // Never merge them into prototypes: consumers use Map/own-property reads and text output.
    for (const child of Object.values(value)) assertData(child, depth + 1);
  }

  function validateEvidence(value, data) {
    assertData(value);
    if (!object(value) || value.storyId !== data.storyId || value.contentVersion !== data.contentVersion) reject('路线的故事 ID 或版本与当前地图不匹配');
    if (typeof value.seed !== 'number' || !Number.isFinite(value.seed) || typeof value.ending !== 'string' || !value.ending) reject('路线缺少 seed 或 ending');
    const snapshot = value.snapshot;
    if (!object(snapshot) || snapshot.formatVersion !== 1 || snapshot.schemaVersion !== '1' || typeof snapshot.engineVersion !== 'string' || !object(snapshot.moduleVersions) || Object.values(snapshot.moduleVersions).some(version => typeof version !== 'string') || snapshot.gameId !== data.storyId || snapshot.contentVersion !== data.contentVersion || !object(snapshot.state)) reject('路线快照格式、故事 ID 或版本不匹配');
    const state = snapshot.state, nodes = new Map(data.nodes.map(node => [node.id, node]));
    if (state.started !== true || state.awaiting !== 'ended' || state.ending !== value.ending || !nodes.has(state.nodeId) || nodes.get(state.nodeId).type !== 'end' || nodes.get(state.nodeId).ending !== value.ending || state.pending !== undefined) reject('路线没有匹配的实际结束快照');
    for (const key of ['revision', 'lineIndex', 'randomState', 'requestSequence']) if (!Number.isSafeInteger(state[key]) || state[key] < 0) reject('路线快照计数格式错误');
    if (state.lineIndex !== 0 || state.randomState > 0xffffffff || !object(state.modules) || !object(state.audio)) reject('路线快照状态格式错误');
    if (!object(state.variables) || Object.values(state.variables).some(item => !['string', 'number', 'boolean'].includes(typeof item)) || !Array.isArray(state.tags) || state.tags.some(tag => typeof tag !== 'string') || !object(state.visits)) reject('路线变量、标签或访问计数格式错误');
    for (const [name, definition] of Object.entries(data.variables ?? {})) if (typeof state.variables[name] !== definition.type) reject('路线变量类型与当前故事不匹配');
    if (Object.keys(state.variables).some(name => !own(data.variables ?? {}, name))) reject('路线包含当前故事未声明的变量');
    for (const slice of Object.values(state.modules)) if (!object(slice) || !Number.isSafeInteger(slice.version) || slice.version < 1 || !own(slice, 'data')) reject('模块状态切片格式错误');
    for (const [channel, track] of Object.entries(state.audio)) if (!['music', 'ambience'].includes(channel) || !object(track) || typeof track.asset !== 'string' || typeof track.loop !== 'boolean' || typeof track.volume !== 'number' || track.volume < 0 || track.volume > 1) reject('音频状态格式错误');
    if (state.scene !== undefined && (!object(state.scene) || typeof state.scene.id !== 'string' || (state.scene.background !== undefined && typeof state.scene.background !== 'string'))) reject('场景状态格式错误');
    if (Object.keys(state.modules).some(id => !own(snapshot.moduleVersions, id)) || Object.keys(snapshot.moduleVersions).some(id => !own(state.modules, id))) reject('模块版本与状态切片不匹配');
    const visited = [];
    for (const [id, count] of Object.entries(state.visits)) {
      if (!nodes.has(id) || !Number.isSafeInteger(count) || count < 0) reject('路线包含陌生节点或无效访问计数');
      if (count > 0) visited.push({ id, count });
    }
    if (!Array.isArray(value.trace) || value.trace.length === 0 || value.trace.length > 10000) reject('路线缺少有效停顿 trace');
    for (const [index, view] of value.trace.entries()) {
      if (view?.awaiting === 'ended' && index + 1 !== value.trace.length) reject('结局只能是最后一次停顿');
      if (!object(view) || !nodes.has(view.nodeId) || !own(state.visits, view.nodeId) || state.visits[view.nodeId] < 1) reject('路线停顿节点没有访问证据');
      const node = nodes.get(view.nodeId);
      if (view.scene !== undefined && (!object(view.scene) || typeof view.scene.id !== 'string' || (view.scene.background !== undefined && typeof view.scene.background !== 'string'))) reject('停顿场景格式错误');
      if ((view.pending !== undefined && view.awaiting !== 'module') || (view.ending !== undefined && view.awaiting !== 'ended') || (view.choices !== undefined && view.awaiting !== 'choice')) reject('停顿字段与等待类型不一致');
      if (view.awaiting === 'continue') {
        if (!['dialogue', 'narration'].includes(node.type) || !object(view.line) || typeof view.line.text !== 'string') reject('对白停顿格式错误');
        for (const key of ['speaker', 'expression', 'voice']) if (view.line[key] !== undefined && typeof view.line[key] !== 'string') reject('对白停顿字段格式错误');
      } else if (view.awaiting === 'choice') {
        if (node.type !== 'choice' || !Array.isArray(view.choices) || view.choices.some(choice => !object(choice) || typeof choice.text !== 'string' || typeof choice.disabled !== 'boolean' || !node.options.some(option => option.id === choice.id) || (choice.disabledReason !== undefined && typeof choice.disabledReason !== 'string')) || (view.prompt !== undefined && typeof view.prompt !== 'string')) reject('选择停顿格式错误');
      } else if (view.awaiting === 'module') {
        if (node.type !== 'module' || !object(view.pending) || typeof view.pending.id !== 'string' || view.pending.module !== node.module || view.pending.nodeId !== node.id || !own(view.pending, 'input')) reject('模块停顿格式错误');
      } else if (view.awaiting === 'ended') {
        if (node.type !== 'end' || !object(view.ending) || view.ending.id !== node.ending || (view.ending.text !== undefined && typeof view.ending.text !== 'string')) reject('结局停顿格式错误');
      } else reject('不支持的停顿状态');
    }
    const last = value.trace[value.trace.length - 1];
    if (last.awaiting !== 'ended' || last.nodeId !== state.nodeId || last.ending.id !== value.ending) reject('最终停顿与结束快照不一致');
    // Existing check-route output has views, not per-command inputs or automatic-edge order.
    // Preserve data as data and derive highlights exclusively from positive visits.
    return JSON.parse(JSON.stringify({ storyId: value.storyId, contentVersion: value.contentVersion, seed: value.seed, ending: value.ending, trace: value.trace, snapshot, visited }));
  }

  root.StoryMapReview = Object.freeze({ analyzeGraph, validateEvidence });
})(globalThis);
