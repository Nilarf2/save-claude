import { ENGINE_VERSION, SCHEMA_VERSION, assertJson, cloneJson, EngineError } from "@text-adventure/module-api";
import { compileStory } from "@text-adventure/content";
import { validateSnapshot as validateSnapshotShape, validateSnapshotForStory } from "@text-adventure/save";
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (code, message, path) => { throw new EngineError(code, message, path); };
const defined = (value, code, message) => value === undefined ? fail(code, message) : value;
function scalar(value, path = "$") {
    if (typeof value === "string" || typeof value === "boolean")
        return value;
    if (typeof value === "number" && Number.isFinite(value))
        return value;
    return fail("SCALAR", "Expected a finite scalar", path);
}
function seedValue(value) {
    const seed = value === undefined ? 0x6d2b79f5 : value;
    if (!Number.isFinite(seed))
        fail("SEED", "Seed must be finite");
    return (Math.trunc(seed) >>> 0) || 0x6d2b79f5;
}
function interpolate(text, variables) {
    return text.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}/g, (_, name) => {
        const value = Object.hasOwn(variables, name) ? variables[name] : undefined;
        return value === undefined ? "" : String(value);
    });
}
function cloneState(state) { return cloneJson(state); }
function safeEvent(type, payload) {
    return payload === undefined ? { type } : { type, payload: cloneJson(payload) };
}
function makeTrack(asset, options) {
    const volume = options?.volume ?? 1;
    if (!Number.isFinite(volume) || volume < 0 || volume > 1)
        fail("AUDIO_VOLUME", "Audio volume must be between 0 and 1");
    return { asset, loop: options?.loop ?? true, volume };
}
function compare(left, right, op) {
    if (op === "eq")
        return left === right;
    if (op === "ne")
        return left !== right;
    if (typeof left !== "number" || typeof right !== "number")
        return false;
    if (op === "gt")
        return left > right;
    if (op === "gte")
        return left >= right;
    if (op === "lt")
        return left < right;
    return left <= right;
}
export function createSession(input, modulesOrOptions, maybeOptions) {
    const compiled = "registry" in input && "nodes" in input
        ? input
        : compileStory(input, Array.isArray(modulesOrOptions) ? modulesOrOptions : []);
    const options = Array.isArray(modulesOrOptions)
        ? (maybeOptions ?? {})
        : (modulesOrOptions === undefined ? {} : modulesOrOptions);
    const registry = compiled.registry;
    const story = compiled.story;
    const maxAutoSteps = options.maxAutoSteps ?? 1000;
    if (!Number.isInteger(maxAutoSteps) || maxAutoSteps < 1)
        fail("OPTIONS", "maxAutoSteps must be a positive integer");
    const variables = {};
    for (const [name, definition] of Object.entries(story.variables ?? {}))
        variables[name] = definition.default;
    const modules = {};
    for (const [id, module] of registry.modules) {
        const data = module.initialState === undefined ? null : cloneJson(module.initialState);
        modules[id] = { version: module.stateVersion ?? 1, data };
    }
    let state = {
        started: false,
        revision: 0,
        nodeId: story.start,
        lineIndex: 0,
        awaiting: "start",
        variables,
        tags: [],
        visits: {},
        randomState: seedValue(options.seed),
        requestSequence: 0,
        modules,
        audio: {}
    };
    let disposed = false;
    let busy = false;
    let notifying = false;
    const listeners = new Set();
    const nextRandom = (draft) => {
        draft.randomState = (Math.imul(draft.randomState, 1664525) + 1013904223) >>> 0;
        return draft.randomState / 0x100000000;
    };
    const checkLive = () => { if (disposed)
        fail("DISPOSED", "Session has been disposed"); };
    const getNode = (id) => compiled.nodes.get(id) ?? fail("NODE_MISSING", `Node not found: ${id}`);
    const run = (operation, notify = true, preserveRevision = false) => {
        checkLive();
        if (busy || notifying)
            fail("REENTRANT", "Session dispatch is already in progress");
        busy = true;
        try {
            const draft = cloneState(state);
            const events = [];
            const effects = [];
            operation(draft, events, effects);
            if (!preserveRevision)
                draft.revision = state.revision + 1;
            for (const count of [draft.revision, draft.requestSequence, ...Object.values(draft.visits)])
                if (!Number.isSafeInteger(count) || count < 0)
                    fail("STATE_COUNTER", "Session counter exceeded the safe integer range");
            assertJson(draft);
            const result = { state: cloneState(draft), view: makeView(draft), events: cloneJson(events), effects: cloneJson(effects) };
            state = draft;
            if (notify)
                publish(result);
            return result;
        }
        finally {
            busy = false;
        }
    };
    const setVariable = (draft, name, value) => {
        const checked = scalar(value);
        const definition = defined(story.variables?.[name], "VARIABLE_MISSING", `Variable not declared: ${name}`);
        if (typeof checked !== definition.type)
            fail("VARIABLE_TYPE", `Variable ${name} must be ${definition.type}`);
        draft.variables[name] = checked;
    };
    const contextFor = (draft, events, effects, mutable) => {
        const context = {
            getVariable: name => Object.hasOwn(draft.variables, name) ? draft.variables[name] : fail("VARIABLE_MISSING", `Variable not found: ${name}`),
            setVariable: (name, value) => { if (!mutable)
                fail("READONLY_CONTEXT", "This context is read-only"); setVariable(draft, name, value); },
            hasTag: tag => draft.tags.includes(tag),
            setTag: (tag, present) => {
                if (!mutable)
                    fail("READONLY_CONTEXT", "This context is read-only");
                const index = draft.tags.indexOf(tag);
                if (present && index < 0)
                    draft.tags.push(tag);
                if (!present && index >= 0)
                    draft.tags.splice(index, 1);
            },
            visitCount: nodeId => Object.hasOwn(draft.visits, nodeId) ? draft.visits[nodeId] : 0,
            random: () => mutable ? nextRandom(draft) : draft.randomState / 0x100000000,
            getModuleState: moduleId => {
                const slice = draft.modules[moduleId];
                if (!slice)
                    fail("MODULE_STATE", `Module state not found: ${moduleId}`);
                return cloneJson(slice.data);
            },
            setModuleState: (moduleId, value) => {
                if (!mutable)
                    fail("READONLY_CONTEXT", "This context is read-only");
                assertJson(value);
                const slice = draft.modules[moduleId];
                if (!slice)
                    fail("MODULE_STATE", `Module state not found: ${moduleId}`);
                slice.data = cloneJson(value);
            },
            emit: event => { if (!mutable)
                fail("READONLY_CONTEXT", "This context is read-only"); assertJson(event); events.push(cloneJson(event)); },
            effect: effect => { if (!mutable)
                fail("READONLY_CONTEXT", "This context is read-only"); assertJson(effect); effects.push(cloneJson(effect)); },
            capability: (name) => {
                if (!registry.capabilities.has(name))
                    fail("CAPABILITY_MISSING", `Capability not found: ${name}`);
                return registry.capabilities.get(name);
            }
        };
        return context;
    };
    const valueOf = (expression, draft, events, effects, mutable) => {
        if (typeof expression === "string" || typeof expression === "boolean" || typeof expression === "number")
            return expression;
        const object = isObject(expression) ? expression : undefined;
        if (object && typeof object.var === "string")
            return Object.hasOwn(draft.variables, object.var) ? draft.variables[object.var] : fail("VARIABLE_MISSING", `Variable not found: ${object.var}`);
        if (object && isObject(object.random)) {
            const min = object.random.min;
            const max = object.random.max;
            if (typeof min !== "number" || typeof max !== "number" || max < min)
                fail("RANDOM_RANGE", "Invalid random range");
            const random = mutable ? nextRandom(draft) : draft.randomState / 0x100000000;
            return min + random * (max - min);
        }
        return fail("EXPRESSION", "Invalid value expression");
    };
    const conditionOf = (condition, draft, events, effects, mutable) => {
        if (!isObject(condition) || typeof condition.op !== "string")
            fail("CONDITION", "Invalid condition");
        switch (condition.op) {
            case "eq":
            case "ne":
            case "gt":
            case "gte":
            case "lt":
            case "lte":
                return compare(valueOf(condition.left, draft, events, effects, mutable), valueOf(condition.right, draft, events, effects, mutable), condition.op);
            case "and": return condition.conditions.every(item => conditionOf(item, draft, events, effects, mutable));
            case "or": return condition.conditions.some(item => conditionOf(item, draft, events, effects, mutable));
            case "not": return !conditionOf(condition.condition, draft, events, effects, mutable);
            case "tag": return draft.tags.includes(condition.tag);
            case "visited": return (Object.hasOwn(draft.visits, condition.node) ? draft.visits[condition.node] : 0) >= (condition.count ?? 1);
            default: {
                const extension = registry.conditions.get(condition.op);
                if (!extension)
                    fail("CONDITION_UNKNOWN", `Unregistered condition: ${condition.op}`);
                const registered = defined(extension, "CONDITION_UNKNOWN", `Unregistered condition: ${condition.op}`);
                if (registered.validate) {
                    const errors = registered.validate(condition);
                    if (errors.length)
                        fail("EXTENSION_DATA", errors.join("; "));
                }
                return registered.handler(contextFor(draft, events, effects, mutable), condition.data);
            }
        }
    };
    const doAction = (action, draft, events, effects) => {
        if (!isObject(action) || typeof action.type !== "string")
            fail("ACTION", "Invalid action");
        const context = contextFor(draft, events, effects, true);
        switch (action.type) {
            case "set":
                setVariable(draft, action.variable, valueOf(action.value, draft, events, effects, true));
                return;
            case "add": {
                const value = valueOf(action.value, draft, events, effects, true);
                const current = draft.variables[action.variable];
                if (typeof value !== "number" || typeof current !== "number")
                    fail("VARIABLE_TYPE", `Variable ${action.variable} must be numeric for add`);
                setVariable(draft, action.variable, current + value);
                return;
            }
            case "tag.add":
                if (!draft.tags.includes(action.tag))
                    draft.tags.push(action.tag);
                return;
            case "tag.remove":
                draft.tags = draft.tags.filter(tag => tag !== action.tag);
                return;
            case "emit":
                events.push(safeEvent(action.name, action.payload));
                return;
            case "audio.play": {
                const channel = action.channel ?? "music";
                const track = makeTrack(action.asset, action.options);
                draft.audio[channel] = track;
                const effect = action.options?.fadeMs === undefined ? { type: "audio.play", channel, track } : { type: "audio.play", channel, track, fadeMs: action.options.fadeMs };
                effects.push(effect);
                return;
            }
            case "audio.stop": {
                const channel = action.channel ?? "music";
                delete draft.audio[channel];
                effects.push(action.fadeMs === undefined ? { type: "audio.stop", channel } : { type: "audio.stop", channel, fadeMs: action.fadeMs });
                return;
            }
            case "audio.sfx": {
                if (action.volume !== undefined && (!Number.isFinite(action.volume) || action.volume < 0 || action.volume > 1))
                    fail("AUDIO_VOLUME", "Audio volume must be between 0 and 1");
                effects.push(action.volume === undefined ? { type: "audio.sfx", asset: action.asset } : { type: "audio.sfx", asset: action.asset, volume: action.volume });
                return;
            }
            case "checkpoint":
                if (action.name === undefined)
                    delete draft.checkpoint;
                else
                    draft.checkpoint = action.name;
                effects.push(action.name === undefined ? { type: "checkpoint" } : { type: "checkpoint", name: action.name });
                return;
            default: {
                const extension = registry.actions.get(action.type);
                if (!extension)
                    fail("ACTION_UNKNOWN", `Unregistered action: ${action.type}`);
                const registered = defined(extension, "ACTION_UNKNOWN", `Unregistered action: ${action.type}`);
                if (registered.validate) {
                    const errors = registered.validate(action);
                    if (errors.length)
                        fail("EXTENSION_DATA", errors.join("; "));
                }
                registered.handler(context, action.data);
            }
        }
    };
    const enter = (draft, events, effects, target) => {
        let steps = 0;
        let next = target;
        while (true) {
            if (++steps > maxAutoSteps)
                fail("AUTO_STEP_LIMIT", "Automatic node processing exceeded the configured limit");
            const node = getNode(next);
            draft.nodeId = node.id;
            draft.lineIndex = 0;
            draft.visits[node.id] = (Object.hasOwn(draft.visits, node.id) ? draft.visits[node.id] : 0) + 1;
            if (node.onEnter)
                for (const action of node.onEnter)
                    doAction(action, draft, events, effects);
            switch (node.type) {
                case "dialogue":
                case "narration":
                    draft.awaiting = "continue";
                    return;
                case "choice": {
                    const available = node.options.some(option => (option.when === undefined || conditionOf(option.when, draft, events, effects, false)) &&
                        (option.disabledWhen === undefined || !conditionOf(option.disabledWhen, draft, events, effects, false)));
                    if (!available) {
                        if (node.fallback) {
                            next = node.fallback;
                            continue;
                        }
                        fail("CHOICE_EMPTY", `Choice ${node.id} has no selectable options or fallback`);
                    }
                    draft.awaiting = "choice";
                    return;
                }
                case "branch": {
                    const branch = node;
                    const selected = branch.branches.find(item => conditionOf(item.when, draft, events, effects, true));
                    next = selected?.next ?? branch.fallback;
                    continue;
                }
                case "action":
                    for (const action of node.actions)
                        doAction(action, draft, events, effects);
                    next = node.next;
                    continue;
                case "scene": {
                    draft.scene = node.background === undefined ? { id: node.scene } : { id: node.scene, background: node.background };
                    effects.push(node.background === undefined ? { type: "scene", scene: node.scene } : { type: "scene", scene: node.scene, background: node.background });
                    if (node.music !== undefined) {
                        const track = makeTrack(node.music);
                        draft.audio.music = track;
                        effects.push({ type: "audio.play", channel: "music", track });
                    }
                    if (node.ambience !== undefined) {
                        const track = makeTrack(node.ambience);
                        draft.audio.ambience = track;
                        effects.push({ type: "audio.play", channel: "ambience", track });
                    }
                    next = node.next;
                    continue;
                }
                case "module": {
                    const moduleNode = node;
                    if (!registry.modules.has(moduleNode.module))
                        fail("MODULE_UNKNOWN", `Module is not registered: ${moduleNode.module}`);
                    const id = `${moduleNode.module}:${++draft.requestSequence}`;
                    const request = { id, module: moduleNode.module, nodeId: node.id, input: moduleNode.input === undefined ? null : cloneJson(moduleNode.input) };
                    draft.pending = request;
                    draft.awaiting = "module";
                    effects.push({ type: "module.request", request });
                    return;
                }
                case "end":
                    draft.awaiting = "ended";
                    draft.ending = node.ending;
                    return;
                default: {
                    const extension = registry.nodes.get(node.type);
                    if (!extension)
                        fail("NODE_TYPE", `Unregistered node type: ${node.type}`);
                    const registered = defined(extension, "NODE_TYPE", `Unregistered node type: ${node.type}`);
                    if (registered.validate) {
                        const errors = registered.validate(node);
                        if (errors.length)
                            fail("EXTENSION_DATA", errors.join("; "));
                    }
                    const returned = registered.handler(contextFor(draft, events, effects, true), node);
                    if (!returned)
                        fail("NODE_NEXT", `Custom node ${node.id} did not return a next node`);
                    next = returned;
                    continue;
                }
            }
        }
    };
    const currentState = () => state;
    const makeView = (state = currentState()) => {
        const node = getNode(state.nodeId);
        const view = { nodeId: state.nodeId, awaiting: state.awaiting };
        if (state.scene !== undefined)
            view.scene = cloneJson(state.scene);
        if (state.pending !== undefined)
            view.pending = cloneJson(state.pending);
        if (state.ending !== undefined && node.type === "end")
            view.ending = { id: state.ending, ...(node.text === undefined ? {} : { text: interpolate(node.text, state.variables) }) };
        if (node.type === "dialogue" || node.type === "narration") {
            const line = node.lines[state.lineIndex];
            if (line)
                view.line = { text: interpolate(line.text, state.variables), ...(line.speaker === undefined ? {} : { speaker: line.speaker }), ...(line.expression === undefined ? {} : { expression: line.expression }), ...(line.voice === undefined ? {} : { voice: line.voice }) };
        }
        if (node.type === "choice") {
            const choices = [];
            for (const option of node.options) {
                let visible = true;
                if (option.when !== undefined)
                    visible = conditionOf(option.when, state, [], [], false);
                if (!visible)
                    continue;
                const disabled = option.disabledWhen === undefined ? false : conditionOf(option.disabledWhen, state, [], [], false);
                choices.push({ id: option.id, text: interpolate(option.text, state.variables), disabled, ...(disabled && option.disabledReason !== undefined ? { disabledReason: option.disabledReason } : {}) });
            }
            view.prompt = node.prompt === undefined ? undefined : interpolate(node.prompt, state.variables);
            if (view.prompt === undefined)
                delete view.prompt;
            view.choices = choices;
        }
        return cloneJson(view);
    };
    const publish = (result) => {
        notifying = true;
        try {
            for (const listener of [...listeners]) {
                try {
                    listener(cloneJson(result));
                }
                catch (error) {
                    try {
                        options.onListenerError?.(error);
                    }
                    catch { /* Reporting cannot invalidate a committed command. */ }
                }
            }
        }
        finally {
            notifying = false;
        }
    };
    const dispatch = (command) => run((draft, events, effects) => {
        if (!["continue", "choose", "module.result", "module.command"].includes(command.type))
            fail("COMMAND_UNKNOWN", "Unknown player command type");
        if (!draft.started)
            fail("NOT_STARTED", "Call start() before dispatching commands");
        if (draft.awaiting === "ended")
            fail("GAME_ENDED", "The game has already ended");
        if (draft.awaiting === "module" && command.type !== "module.result")
            fail("MODULE_WAIT", "Session is waiting for a module result");
        if (draft.awaiting !== "module" && command.type === "module.result")
            fail("MODULE_WAIT", "No module result is pending");
        if (command.type === "continue") {
            if (draft.awaiting !== "continue")
                fail("COMMAND_STATE", "Continue is only valid for dialogue");
            const node = getNode(draft.nodeId);
            if (draft.lineIndex + 1 < node.lines.length) {
                draft.lineIndex++;
                return;
            }
            enter(draft, events, effects, node.next);
            return;
        }
        if (command.type === "choose") {
            if (draft.awaiting !== "choice")
                fail("COMMAND_STATE", "Choose is only valid for choices");
            const node = getNode(draft.nodeId);
            const option = node.options.find(item => item.id === command.optionId);
            if (!option)
                fail("OPTION_MISSING", `Unknown option: ${command.optionId}`);
            const selected = defined(option, "OPTION_MISSING", `Unknown option: ${command.optionId}`);
            if (selected.when !== undefined && !conditionOf(selected.when, draft, events, effects, false))
                fail("OPTION_HIDDEN", "This option is not available");
            if (selected.disabledWhen !== undefined && conditionOf(selected.disabledWhen, draft, events, effects, false))
                fail("OPTION_DISABLED", selected.disabledReason ?? "This option is disabled");
            for (const action of selected.actions ?? [])
                doAction(action, draft, events, effects);
            enter(draft, events, effects, selected.next);
            return;
        }
        if (command.type === "module.result") {
            if (!draft.pending || draft.pending.id !== command.requestId)
                fail("MODULE_REQUEST", "Module result does not match the pending request");
            const pending = defined(draft.pending, "MODULE_REQUEST", "Module result does not match the pending request");
            const node = getNode(pending.nodeId);
            const target = node.outcomes[command.outcome];
            if (!target)
                fail("MODULE_OUTCOME", `Unknown module outcome: ${command.outcome}`);
            if (node.resultVariable !== undefined)
                setVariable(draft, node.resultVariable, command.result);
            delete draft.pending;
            enter(draft, events, effects, target);
            return;
        }
        const extension = defined(registry.commands.get(command.name), "COMMAND_UNKNOWN", `Unregistered command: ${command.name}`);
        extension.handler(contextFor(draft, events, effects, true), command.payload);
    });
    const start = () => run((draft, events, effects) => {
        if (draft.started)
            return;
        draft.started = true;
        enter(draft, events, effects, story.start);
    });
    const validateSnapshot = (snapshot) => {
        validateSnapshotShape(snapshot);
        if (snapshot.engineVersion !== ENGINE_VERSION)
            fail("SNAPSHOT_VERSION", "Use prepareSnapshot before restoring a different engine version");
        if (snapshot.gameId !== story.id || snapshot.contentVersion !== story.version)
            fail("SNAPSHOT_CONTENT", "Snapshot belongs to incompatible content");
        validateSnapshotForStory(snapshot, compiled);
        for (const [id, module] of registry.modules) {
            if (!snapshot.state.modules[id] || !snapshot.moduleVersions[id])
                fail("SNAPSHOT_MODULE", `Missing module state/version: ${id}`);
            if (snapshot.state.modules[id].version > (module.stateVersion ?? 1))
                fail("SNAPSHOT_MODULE", `Module state is newer than the loaded module: ${id}`);
        }
        if ([...Object.keys(snapshot.state.modules), ...Object.keys(snapshot.moduleVersions)].some(id => !registry.modules.has(id)))
            fail("SNAPSHOT_MODULE", "Snapshot contains unknown modules");
        return cloneJson(snapshot);
    };
    const restore = (snapshot) => run((draft, events, effects) => {
        const checked = validateSnapshot(snapshot);
        const incoming = checked.state;
        const restored = cloneState(incoming);
        for (const [id, module] of registry.modules) {
            const oldVersion = checked.moduleVersions[id];
            const currentVersion = module.version;
            const slice = defined(restored.modules[id], "SNAPSHOT_MODULE", `Missing module state: ${id}`);
            if (oldVersion !== currentVersion || slice.version !== (module.stateVersion ?? 1)) {
                if (!module.migrateState)
                    fail("MODULE_MIGRATION", `Module ${id} changed without migrateState`);
                const migrate = defined(module.migrateState, "MODULE_MIGRATION", `Module ${id} changed without migrateState`);
                const target = module.stateVersion ?? 1;
                slice.data = cloneJson(migrate(slice.data, slice.version, target));
                slice.version = target;
            }
        }
        for (const key of Object.keys(draft))
            delete draft[key];
        Object.assign(draft, restored);
        if (draft.scene)
            effects.push(draft.scene.background === undefined ? { type: "scene", scene: draft.scene.id } : { type: "scene", scene: draft.scene.id, background: draft.scene.background });
        for (const channel of ["music", "ambience"]) {
            const track = draft.audio[channel];
            effects.push(track ? { type: "audio.play", channel, track } : { type: "audio.stop", channel });
        }
        if (draft.pending)
            effects.push({ type: "module.request", request: cloneJson(draft.pending) });
    }, false, true);
    const snapshot = () => {
        checkLive();
        return cloneJson({ formatVersion: 1, engineVersion: ENGINE_VERSION, schemaVersion: SCHEMA_VERSION, gameId: story.id, contentVersion: story.version, moduleVersions: Object.fromEntries([...registry.modules].map(([id, module]) => [id, module.version])), state });
    };
    return {
        start,
        dispatch,
        getView: () => { checkLive(); return makeView(); },
        snapshot,
        restore,
        subscribe: listener => { checkLive(); listeners.add(listener); return () => listeners.delete(listener); },
        dispose: () => { disposed = true; listeners.clear(); }
    };
}
export default createSession;
//# sourceMappingURL=index.js.map