import { assertJson, cloneJson, ENGINE_VERSION, EngineError, SCHEMA_VERSION } from "@text-adventure/module-api";
function record(value, path) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new EngineError("SNAPSHOT_SHAPE", "Expected an object", path);
    }
}
function nonEmptyString(value, path) {
    if (typeof value !== "string" || value.length === 0) {
        throw new EngineError("SNAPSHOT_SHAPE", "Expected a non-empty string", path);
    }
}
function integer(value, path, minimum = 0) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
        throw new EngineError("SNAPSHOT_SHAPE", `Expected an integer >= ${minimum}`, path);
    }
}
function stringRecord(value, path) {
    record(value, path);
    for (const [key, child] of Object.entries(value)) {
        if (typeof child !== "string" || child.length === 0) {
            throw new EngineError("SNAPSHOT_SHAPE", "Expected non-empty string values", `${path}/${key}`);
        }
    }
}
function isScalar(value) {
    return typeof value === "string" || typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value));
}
function validateModuleSlice(value, path) {
    record(value, path);
    integer(value.version, `${path}/version`, 1);
    if (!("data" in value))
        throw new EngineError("SNAPSHOT_SHAPE", "Missing module state data", `${path}/data`);
    assertJson(value.data, `${path}/data`);
}
function validateTrack(value, path) {
    record(value, path);
    nonEmptyString(value.asset, `${path}/asset`);
    if (typeof value.loop !== "boolean")
        throw new EngineError("SNAPSHOT_SHAPE", "Expected a boolean", `${path}/loop`);
    if (typeof value.volume !== "number" || !Number.isFinite(value.volume) || value.volume < 0 || value.volume > 1) {
        throw new EngineError("SNAPSHOT_SHAPE", "Expected a volume between 0 and 1", `${path}/volume`);
    }
}
export function validateSnapshot(value) {
    assertJson(value);
    record(value, "$");
    if (value.formatVersion !== 1)
        throw new EngineError("SNAPSHOT_FORMAT", "Unsupported save format version", "$/formatVersion");
    nonEmptyString(value.engineVersion, "$/engineVersion");
    if (value.schemaVersion !== SCHEMA_VERSION) {
        throw new EngineError("SNAPSHOT_SCHEMA", `Unsupported content schema: ${String(value.schemaVersion)}`, "$/schemaVersion");
    }
    nonEmptyString(value.gameId, "$/gameId");
    nonEmptyString(value.contentVersion, "$/contentVersion");
    stringRecord(value.moduleVersions, "$/moduleVersions");
    const state = value.state;
    record(state, "$/state");
    if (typeof state.started !== "boolean")
        throw new EngineError("SNAPSHOT_SHAPE", "Expected a boolean", "$/state/started");
    integer(state.revision, "$/state/revision");
    nonEmptyString(state.nodeId, "$/state/nodeId");
    integer(state.lineIndex, "$/state/lineIndex");
    if (!["start", "continue", "choice", "module", "ended"].includes(String(state.awaiting))) {
        throw new EngineError("SNAPSHOT_SHAPE", "Unknown runtime wait state", "$/state/awaiting");
    }
    record(state.variables, "$/state/variables");
    for (const [key, child] of Object.entries(state.variables)) {
        if (!isScalar(child))
            throw new EngineError("SNAPSHOT_SHAPE", "Expected a scalar variable value", `$/state/variables/${key}`);
    }
    if (!Array.isArray(state.tags) || state.tags.some(tag => typeof tag !== "string")) {
        throw new EngineError("SNAPSHOT_SHAPE", "Expected an array of strings", "$/state/tags");
    }
    record(state.visits, "$/state/visits");
    for (const [nodeId, count] of Object.entries(state.visits))
        integer(count, `$/state/visits/${nodeId}`);
    integer(state.randomState, "$/state/randomState");
    if (state.randomState > 0xffffffff)
        throw new EngineError("SNAPSHOT_SHAPE", "PRNG state must be uint32", "$/state/randomState");
    integer(state.requestSequence, "$/state/requestSequence");
    record(state.modules, "$/state/modules");
    for (const [moduleId, slice] of Object.entries(state.modules))
        validateModuleSlice(slice, `$/state/modules/${moduleId}`);
    if (state.pending !== undefined) {
        record(state.pending, "$/state/pending");
        nonEmptyString(state.pending.id, "$/state/pending/id");
        nonEmptyString(state.pending.module, "$/state/pending/module");
        nonEmptyString(state.pending.nodeId, "$/state/pending/nodeId");
        if (!("input" in state.pending))
            throw new EngineError("SNAPSHOT_SHAPE", "Missing module request input", "$/state/pending/input");
        assertJson(state.pending.input, "$/state/pending/input");
    }
    if (state.scene !== undefined) {
        record(state.scene, "$/state/scene");
        nonEmptyString(state.scene.id, "$/state/scene/id");
        if (state.scene.background !== undefined && typeof state.scene.background !== "string") {
            throw new EngineError("SNAPSHOT_SHAPE", "Expected a string", "$/state/scene/background");
        }
    }
    record(state.audio, "$/state/audio");
    for (const [channel, track] of Object.entries(state.audio)) {
        if (channel !== "music" && channel !== "ambience")
            throw new EngineError("SNAPSHOT_SHAPE", "Unknown audio channel", `$/state/audio/${channel}`);
        validateTrack(track, `$/state/audio/${channel}`);
    }
    if (state.ending !== undefined && typeof state.ending !== "string")
        throw new EngineError("SNAPSHOT_SHAPE", "Expected a string", "$/state/ending");
    if (state.checkpoint !== undefined && typeof state.checkpoint !== "string")
        throw new EngineError("SNAPSHOT_SHAPE", "Expected a string", "$/state/checkpoint");
}
export function serializeSnapshot(snapshot) {
    validateSnapshot(snapshot);
    return JSON.stringify(cloneJson(snapshot));
}
export function parseSnapshot(serialized) {
    let parsed;
    try {
        parsed = JSON.parse(serialized);
    }
    catch (error) {
        throw new EngineError("SNAPSHOT_PARSE", error instanceof Error ? error.message : "Invalid JSON");
    }
    validateSnapshot(parsed);
    return cloneJson(parsed);
}
function defaultVersionCompatibility(saved, current) {
    if (saved === current)
        return true;
    const savedMajor = /^(\d+)\./.exec(saved)?.[1];
    const currentMajor = /^(\d+)\./.exec(current)?.[1];
    return savedMajor !== undefined && savedMajor === currentMajor;
}
function assertVersionCompatibility(label, saved, current, check) {
    if (!check(saved, current)) {
        throw new EngineError("SNAPSHOT_VERSION", `${label} version ${saved} is incompatible with ${current}`);
    }
}
function migrateModules(snapshot, compiled, compatible) {
    const registry = compiled.registry.modules;
    const savedIds = Object.keys(snapshot.moduleVersions);
    for (const moduleId of Object.keys(snapshot.state.modules)) {
        if (!registry.has(moduleId))
            throw new EngineError("SNAPSHOT_MODULE", `Save contains unavailable module state: ${moduleId}`);
        if (!Object.hasOwn(snapshot.moduleVersions, moduleId))
            throw new EngineError("SNAPSHOT_MODULE", `Save is missing module version: ${moduleId}`);
    }
    for (const moduleId of savedIds) {
        if (!registry.has(moduleId))
            throw new EngineError("SNAPSHOT_MODULE", `Save requires unavailable module: ${moduleId}`);
        if (!snapshot.state.modules[moduleId])
            throw new EngineError("SNAPSHOT_MODULE", `Save is missing state for module: ${moduleId}`);
    }
    for (const [moduleId, mod] of registry) {
        const targetStateVersion = mod.stateVersion ?? 1;
        const savedVersion = snapshot.moduleVersions[moduleId];
        let slice = snapshot.state.modules[moduleId];
        if (savedVersion === undefined) {
            const data = mod.initialState === undefined ? null : cloneJson(mod.initialState);
            snapshot.state.modules[moduleId] = { version: targetStateVersion, data };
            snapshot.moduleVersions[moduleId] = mod.version;
            continue;
        }
        if (!(compatible ?? defaultVersionCompatibility)(savedVersion, mod.version)) {
            throw new EngineError("SNAPSHOT_MODULE_VERSION", `Module ${moduleId} version ${savedVersion} is incompatible with ${mod.version}`);
        }
        if (!slice)
            throw new EngineError("SNAPSHOT_MODULE", `Save is missing state for module: ${moduleId}`);
        if (slice.version > targetStateVersion) {
            throw new EngineError("SNAPSHOT_MODULE_STATE_VERSION", `Module ${moduleId} state is newer than this module`);
        }
        if (slice.version < targetStateVersion) {
            if (!mod.migrateState)
                throw new EngineError("SNAPSHOT_MODULE_MIGRATION", `Module ${moduleId} has no state migration`);
            const migrated = mod.migrateState(cloneJson(slice.data), slice.version, targetStateVersion);
            assertJson(migrated, `$/state/modules/${moduleId}/data`);
            snapshot.state.modules[moduleId] = { version: targetStateVersion, data: cloneJson(migrated) };
            slice = snapshot.state.modules[moduleId];
        }
        snapshot.moduleVersions[moduleId] = mod.version;
    }
}
/** Validate cursor and story-dependent invariants without migrating or mutating data. */
export function validateSnapshotForStory(snapshot, compiled) {
    validateSnapshot(snapshot);
    const state = snapshot.state;
    const node = compiled.nodes.get(state.nodeId);
    const reject = (message) => { throw new EngineError("SNAPSHOT_STATE", message); };
    if (!node)
        reject(`Save refers to missing node: ${state.nodeId}`);
    if (!state.started) {
        if (state.awaiting !== "start" || state.nodeId !== compiled.story.start || state.lineIndex !== 0 || state.pending || state.ending)
            reject("Invalid unstarted cursor");
    }
    else {
        if (state.awaiting === "start")
            reject("Started session cannot await start");
        if (state.awaiting === "continue" && (!(node.type === "dialogue" || node.type === "narration") || state.lineIndex >= node.lines.length))
            reject("Invalid dialogue cursor");
        if (state.awaiting === "choice" && node.type !== "choice")
            reject("Invalid choice cursor");
        if (state.awaiting === "ended" && (node.type !== "end" || state.ending !== node.ending))
            reject("Invalid ending cursor");
        if (state.awaiting !== "continue" && state.lineIndex !== 0)
            reject("Unexpected line cursor");
    }
    if ((state.awaiting === "module") !== Boolean(state.pending))
        reject("Pending request and wait state disagree");
    if (state.pending) {
        if (node.type !== "module" || state.pending.nodeId !== state.nodeId || state.pending.module !== node.module ||
            state.pending.id !== `${state.pending.module}:${state.requestSequence}` || state.requestSequence < 1 || !compiled.registry.modules.has(state.pending.module))
            reject("Pending request does not match the current module node");
    }
    if (state.awaiting !== "ended" && state.ending !== undefined)
        reject("Unexpected ending state");
    for (const id of Object.keys(state.visits))
        if (!compiled.nodes.has(id))
            reject(`Unknown visited node: ${id}`);
    for (const [name, definition] of Object.entries(compiled.story.variables ?? {})) {
        if (typeof state.variables[name] !== definition.type)
            reject(`Variable ${name} is missing or has the wrong type`);
    }
    for (const name of Object.keys(state.variables))
        if (!Object.hasOwn(compiled.story.variables ?? {}, name))
            reject(`Undeclared variable: ${name}`);
}
export function prepareSnapshot(input, compiled, options = {}) {
    validateSnapshot(input);
    let snapshot = cloneJson(input);
    assertVersionCompatibility("Engine", snapshot.engineVersion, ENGINE_VERSION, options.isEngineVersionCompatible ?? defaultVersionCompatibility);
    if (snapshot.gameId !== compiled.story.id)
        throw new EngineError("SNAPSHOT_GAME", "Save belongs to another game");
    if (snapshot.contentVersion !== compiled.story.version) {
        if (!options.migrateContent)
            throw new EngineError("SNAPSHOT_CONTENT", "Save content version differs and no content migration was provided");
        snapshot = options.migrateContent(snapshot, compiled);
        validateSnapshot(snapshot);
        if (snapshot.gameId !== compiled.story.id || snapshot.contentVersion !== compiled.story.version) {
            throw new EngineError("SNAPSHOT_CONTENT_MIGRATION", "Content migration did not target the loaded game version");
        }
    }
    if (!compiled.nodes.has(snapshot.state.nodeId)) {
        throw new EngineError("SNAPSHOT_NODE", `Save refers to missing node: ${snapshot.state.nodeId}`);
    }
    for (const nodeId of Object.keys(snapshot.state.visits)) {
        if (!compiled.nodes.has(nodeId))
            throw new EngineError("SNAPSHOT_NODE", `Visit history refers to missing node: ${nodeId}`);
    }
    if (snapshot.state.pending) {
        if (!compiled.nodes.has(snapshot.state.pending.nodeId)) {
            throw new EngineError("SNAPSHOT_NODE", `Pending request refers to missing node: ${snapshot.state.pending.nodeId}`);
        }
        if (!compiled.registry.modules.has(snapshot.state.pending.module)) {
            throw new EngineError("SNAPSHOT_MODULE", `Pending request requires unavailable module: ${snapshot.state.pending.module}`);
        }
    }
    for (const [name, definition] of Object.entries(compiled.story.variables ?? {})) {
        const value = snapshot.state.variables[name];
        const validType = definition.type === "string" ? typeof value === "string" :
            definition.type === "number" ? typeof value === "number" : typeof value === "boolean";
        if (!validType)
            throw new EngineError("SNAPSHOT_VARIABLE", `Variable ${name} is missing or has the wrong type`);
    }
    migrateModules(snapshot, compiled, options.isModuleVersionCompatible);
    snapshot.engineVersion = ENGINE_VERSION;
    validateSnapshotForStory(snapshot, compiled);
    return snapshot;
}
function validateSlotId(slotId) {
    if (typeof slotId !== "string" || slotId.trim().length === 0 || slotId.length > 180) {
        throw new EngineError("SAVE_SLOT", "Save slot ID must contain 1 to 180 characters");
    }
}
function cloneRecord(save) {
    validateSnapshot(save.snapshot);
    validateSlotId(save.slotId);
    if (!Number.isFinite(Date.parse(save.savedAt)))
        throw new EngineError("SAVE_DATE", "Invalid save timestamp");
    if (save.label !== undefined && typeof save.label !== "string")
        throw new EngineError("SAVE_LABEL", "Save label must be a string");
    return cloneJson(save);
}
function toEntry(save) {
    return {
        slotId: save.slotId,
        gameId: save.snapshot.gameId,
        contentVersion: save.snapshot.contentVersion,
        savedAt: save.savedAt,
        ...(save.label === undefined ? {} : { label: save.label })
    };
}
export class MemorySaveStore {
    records = new Map();
    async list(gameId) {
        return [...this.records.values()]
            .filter(save => gameId === undefined || save.snapshot.gameId === gameId)
            .map(toEntry)
            .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
    }
    async read(slotId) {
        validateSlotId(slotId);
        const save = this.records.get(slotId);
        return save ? cloneJson(save) : null;
    }
    async write(save) {
        const valid = cloneRecord(save);
        this.records.set(valid.slotId, valid);
    }
    async delete(slotId) {
        validateSlotId(slotId);
        return this.records.delete(slotId);
    }
}
export class SaveManager {
    store;
    constructor(store) {
        this.store = store;
    }
    list(gameId) {
        return this.store.list(gameId);
    }
    read(slotId) {
        return this.store.read(slotId);
    }
    async save(slotId, source, label) {
        const snapshot = "snapshot" in source && typeof source.snapshot === "function" ? source.snapshot() : source;
        validateSnapshot(snapshot);
        await this.store.write({ slotId, snapshot: cloneJson(snapshot), savedAt: new Date().toISOString(), ...(label === undefined ? {} : { label }) });
    }
    async load(slotId, compiled, options = {}) {
        const save = await this.store.read(slotId);
        return save ? prepareSnapshot(save.snapshot, compiled, options) : null;
    }
    async restore(slotId, session, compiled, options = {}) {
        const snapshot = await this.load(slotId, compiled, options);
        if (!snapshot)
            return null;
        return session.restore(snapshot);
    }
    delete(slotId) {
        return this.store.delete(slotId);
    }
    async export(slotId) {
        const save = await this.store.read(slotId);
        return save ? serializeSnapshot(save.snapshot) : null;
    }
    async import(slotId, serialized, label) {
        const snapshot = parseSnapshot(serialized);
        await this.save(slotId, snapshot, label);
    }
}
//# sourceMappingURL=index.js.map