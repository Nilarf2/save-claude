export const ENGINE_VERSION = "0.1.0";
export const SCHEMA_VERSION = "1";
export class EngineError extends Error {
    code;
    path;
    constructor(code, message, path) {
        super(message);
        this.code = code;
        this.path = path;
        this.name = "EngineError";
    }
}
export function assertJson(value, path = "$", depth = 0) {
    if (depth > 100)
        throw new EngineError("JSON_DEPTH", "JSON nesting exceeds 100 levels", path);
    if (value === null || typeof value === "string" || typeof value === "boolean")
        return;
    if (typeof value === "number" && Number.isFinite(value))
        return;
    if (typeof value !== "object" || value === undefined)
        throw new EngineError("JSON_VALUE", "Expected a finite JSON value", path);
    if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++)
            assertJson(value[i], `${path}/${i}`, depth + 1);
        return;
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null)
        throw new EngineError("JSON_OBJECT", "Expected a plain JSON object", path);
    for (const [key, child] of Object.entries(value)) {
        if (["__proto__", "prototype", "constructor"].includes(key))
            throw new EngineError("JSON_KEY", `Reserved key: ${key}`, path);
        assertJson(child, `${path}/${key}`, depth + 1);
    }
}
export function cloneJson(value) {
    assertJson(value);
    return JSON.parse(JSON.stringify(value));
}
export function createModuleRegistry(modules = []) {
    const byId = new Map();
    for (const mod of modules) {
        if (typeof mod.id !== "string" || !/^[a-z][a-z0-9-]*$/.test(mod.id) || ["constructor", "prototype", "__proto__"].includes(mod.id) || byId.has(mod.id))
            throw new EngineError("MODULE_ID", `Invalid or duplicate module ID: ${mod.id}`);
        if (typeof mod.version !== "string" || !mod.version.trim() || !Number.isSafeInteger(mod.stateVersion ?? 1) || (mod.stateVersion ?? 1) < 1)
            throw new EngineError("MODULE_VERSION", `Invalid version: ${mod.id}`);
        if (mod.initialState !== undefined)
            assertJson(mod.initialState);
        byId.set(mod.id, { ...mod, id: mod.id, version: mod.version, stateVersion: mod.stateVersion ?? 1, register: mod.register.bind(mod), ...(mod.migrateState ? { migrateState: mod.migrateState.bind(mod) } : {}), ...(mod.dependencies ? { dependencies: { ...mod.dependencies } } : {}), ...(mod.initialState !== undefined ? { initialState: cloneJson(mod.initialState) } : {}) });
    }
    const ordered = [];
    const visiting = new Set();
    const visited = new Set();
    const visit = (mod) => {
        if (visiting.has(mod.id))
            throw new EngineError("MODULE_CYCLE", `Circular dependency: ${mod.id}`);
        if (visited.has(mod.id))
            return;
        visiting.add(mod.id);
        for (const [id, required] of Object.entries(mod.dependencies ?? {})) {
            const dependency = byId.get(id);
            if (!dependency || (required !== "*" && dependency.version !== required))
                throw new EngineError("MODULE_DEPENDENCY", `${mod.id} needs ${id}@${required}`);
            visit(dependency);
        }
        visiting.delete(mod.id);
        visited.add(mod.id);
        ordered.push(mod);
    };
    for (const mod of byId.values())
        visit(mod);
    const nodes = new Map();
    const conditions = new Map();
    const actions = new Map();
    const commands = new Map();
    const capabilities = new Map();
    for (const mod of ordered) {
        const add = (map, name, handler, validate) => {
            if (!name.startsWith(`${mod.id}:`) || !/^[a-z][a-z0-9-]*:[a-zA-Z0-9_.-]+$/.test(name) || map.has(name))
                throw new EngineError("MODULE_REGISTRATION", `Invalid or conflicting registration: ${name}`);
            map.set(name, { owner: mod.id, handler, ...(validate ? { validate } : {}) });
        };
        mod.register({
            node: (name, handler, validate) => add(nodes, name, handler, validate),
            condition: (name, handler, validate) => add(conditions, name, handler, validate),
            action: (name, handler, validate) => add(actions, name, handler, validate),
            command: (name, handler) => add(commands, name, handler),
            capability: (name, value) => {
                if (!name.startsWith(`${mod.id}:`) || !/^[a-z][a-z0-9-]*:[a-zA-Z0-9_.-]+$/.test(name) || capabilities.has(name))
                    throw new EngineError("MODULE_REGISTRATION", `Invalid or conflicting capability: ${name}`);
                capabilities.set(name, value);
            }
        });
    }
    return { modules: new Map(ordered.map(mod => [mod.id, mod])), nodes, conditions, actions, commands, capabilities };
}
//# sourceMappingURL=index.js.map