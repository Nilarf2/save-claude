import { assertJson, cloneJson, createModuleRegistry, EngineError } from "@text-adventure/module-api";
const ID = /^[a-zA-Z][a-zA-Z0-9_.:-]*$/;
const asObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
function fail(diagnostics, code, message, path) {
    diagnostics.push({ code, message, path, severity: "error" });
}
function warn(diagnostics, code, message, path) {
    diagnostics.push({ code, message, path, severity: "warning" });
}
function validateExpression(value, path, diagnostics) {
    if (typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)))
        return;
    const object = asObject(value);
    if (!object) {
        fail(diagnostics, "EXPRESSION", "Expected a scalar or expression object", path);
        return;
    }
    if (typeof object.var === "string" && object.var && Object.keys(object).length === 1)
        return;
    const random = asObject(object.random);
    if (random && Object.keys(object).length === 1 && Object.keys(random).length === 2 && typeof random.min === "number" && typeof random.max === "number" && Number.isInteger(random.min) && Number.isInteger(random.max) && random.max >= random.min)
        return;
    fail(diagnostics, "EXPRESSION", "Unknown or invalid value expression", path);
}
function validateCondition(value, path, diagnostics, registry) {
    const obj = asObject(value);
    if (!obj || typeof obj.op !== "string") {
        fail(diagnostics, "CONDITION", "Expected condition object with op", path);
        return;
    }
    switch (obj.op) {
        case "eq":
        case "ne":
        case "gt":
        case "gte":
        case "lt":
        case "lte":
            validateExpression(obj.left, `${path}/left`, diagnostics);
            validateExpression(obj.right, `${path}/right`, diagnostics);
            return;
        case "and":
        case "or":
            if (!Array.isArray(obj.conditions) || obj.conditions.length === 0) {
                fail(diagnostics, "CONDITION", "conditions must be a non-empty array", `${path}/conditions`);
                return;
            }
            obj.conditions.forEach((condition, i) => validateCondition(condition, `${path}/conditions/${i}`, diagnostics, registry));
            return;
        case "not":
            validateCondition(obj.condition, `${path}/condition`, diagnostics, registry);
            return;
        case "tag":
            if (typeof obj.tag !== "string" || !obj.tag)
                fail(diagnostics, "CONDITION", "tag must be a non-empty string", `${path}/tag`);
            return;
        case "visited":
            if (typeof obj.node !== "string" || (obj.count !== undefined && (!Number.isInteger(obj.count) || obj.count < 0)))
                fail(diagnostics, "CONDITION", "visited requires a node and non-negative integer count", path);
            return;
        default: {
            const extension = registry.conditions.get(obj.op);
            if (!extension)
                fail(diagnostics, "CONDITION_UNKNOWN", `Unregistered condition ${obj.op}`, `${path}/op`);
            else if (extension.validate)
                for (const error of extension.validate(value))
                    fail(diagnostics, "EXTENSION_DATA", error, path);
        }
    }
}
function validateAction(value, path, diagnostics, registry) {
    const obj = asObject(value);
    if (!obj || typeof obj.type !== "string") {
        fail(diagnostics, "ACTION", "Expected action object with type", path);
        return;
    }
    if (obj.type.startsWith("audio.")) {
        if (obj.channel !== undefined && !["music", "ambience"].includes(String(obj.channel)))
            fail(diagnostics, "AUDIO_CHANNEL", "Unknown audio channel", `${path}/channel`);
        const options = obj.options === undefined ? undefined : asObject(obj.options);
        if (obj.options !== undefined && !options)
            fail(diagnostics, "AUDIO_OPTIONS", "options must be an object", `${path}/options`);
        if (options?.loop !== undefined && typeof options.loop !== "boolean")
            fail(diagnostics, "AUDIO_LOOP", "loop must be boolean", `${path}/options/loop`);
        for (const [key, value] of [["volume", obj.volume], ["options/volume", options?.volume]]) {
            if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1))
                fail(diagnostics, "AUDIO_VOLUME", "volume must be between 0 and 1", `${path}/${key}`);
        }
        for (const [key, value] of [["fadeMs", obj.fadeMs], ["options/fadeMs", options?.fadeMs]]) {
            if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0))
                fail(diagnostics, "AUDIO_FADE", "fadeMs must be non-negative", `${path}/${key}`);
        }
    }
    switch (obj.type) {
        case "set":
        case "add":
            if (typeof obj.variable !== "string" || !obj.variable)
                fail(diagnostics, "ACTION", "variable must be a non-empty string", `${path}/variable`);
            validateExpression(obj.value, `${path}/value`, diagnostics);
            return;
        case "tag.add":
        case "tag.remove":
            if (typeof obj.tag !== "string" || !obj.tag)
                fail(diagnostics, "ACTION", "tag must be a non-empty string", `${path}/tag`);
            return;
        case "emit":
            if (typeof obj.name !== "string" || !obj.name)
                fail(diagnostics, "ACTION", "event name must be a non-empty string", `${path}/name`);
            return;
        case "audio.play":
        case "audio.sfx":
            if (typeof obj.asset !== "string" || !obj.asset)
                fail(diagnostics, "ACTION", "asset must be a non-empty logical asset ID", `${path}/asset`);
            return;
        case "audio.stop": return;
        case "checkpoint":
            if (obj.name !== undefined && typeof obj.name !== "string")
                fail(diagnostics, "CHECKPOINT", "name must be text", `${path}/name`);
            return;
        default: {
            const extension = registry.actions.get(obj.type);
            if (!extension)
                fail(diagnostics, "ACTION_UNKNOWN", `Unregistered action ${obj.type}`, `${path}/type`);
            else if (extension.validate)
                for (const error of extension.validate(value))
                    fail(diagnostics, "EXTENSION_DATA", error, path);
        }
    }
}
function validateActions(value, path, diagnostics, registry) {
    if (!Array.isArray(value)) {
        fail(diagnostics, "ACTIONS", "Expected an action array", path);
        return;
    }
    value.forEach((action, i) => validateAction(action, `${path}/${i}`, diagnostics, registry));
}
function validateNode(node, index, diagnostics, registry) {
    const path = `/nodes/${index}`;
    const obj = asObject(node);
    if (!obj || typeof obj.id !== "string" || typeof obj.type !== "string") {
        fail(diagnostics, "NODE", "Each node needs id and type", path);
        return;
    }
    if (!ID.test(obj.id) || ["constructor", "prototype", "__proto__"].includes(obj.id))
        fail(diagnostics, "NODE_ID", `Invalid node ID ${obj.id}`, `${path}/id`);
    if (obj.onEnter !== undefined)
        validateActions(obj.onEnter, `${path}/onEnter`, diagnostics, registry);
    for (const key of ["background", "music", "ambience", "resultVariable", "text"])
        if (obj[key] !== undefined && typeof obj[key] !== "string")
            fail(diagnostics, "NODE_FIELD", `${key} must be text`, `${path}/${key}`);
    const requireRef = (value, refPath) => { if (typeof value !== "string" || !value)
        fail(diagnostics, "NODE_REF", "Expected node ID", refPath); };
    switch (obj.type) {
        case "dialogue":
        case "narration":
            if (!Array.isArray(obj.lines) || obj.lines.length === 0)
                fail(diagnostics, "DIALOGUE_LINES", "Dialogue needs at least one line", `${path}/lines`);
            else
                obj.lines.forEach((line, i) => {
                    const l = asObject(line);
                    if (l)
                        for (const key of ["speaker", "expression", "voice"])
                            if (l[key] !== undefined && typeof l[key] !== "string")
                                fail(diagnostics, "DIALOGUE_LINE", `${key} must be text`, `${path}/lines/${i}/${key}`);
                    if (!l || typeof l.text !== "string")
                        fail(diagnostics, "DIALOGUE_LINE", "Line needs text", `${path}/lines/${i}`);
                });
            requireRef(obj.next, `${path}/next`);
            return;
        case "choice":
            if (obj.prompt !== undefined && typeof obj.prompt !== "string")
                fail(diagnostics, "CHOICE_PROMPT", "prompt must be text", `${path}/prompt`);
            if (!Array.isArray(obj.options) || obj.options.length === 0)
                fail(diagnostics, "CHOICE_OPTIONS", "Choice needs at least one option", `${path}/options`);
            else
                obj.options.forEach((option, i) => {
                    const p = `${path}/options/${i}`;
                    const o = asObject(option);
                    if (!o || typeof o.id !== "string" || !o.id || typeof o.text !== "string") {
                        fail(diagnostics, "CHOICE_OPTION", "Option needs id and text", p);
                        return;
                    }
                    requireRef(o.next, `${p}/next`);
                    if (o.when !== undefined)
                        validateCondition(o.when, `${p}/when`, diagnostics, registry);
                    if (o.disabledWhen !== undefined)
                        validateCondition(o.disabledWhen, `${p}/disabledWhen`, diagnostics, registry);
                    if (o.actions !== undefined)
                        validateActions(o.actions, `${p}/actions`, diagnostics, registry);
                });
            if (Array.isArray(obj.options)) {
                const seen = new Set();
                obj.options.forEach((option, i) => { const id = asObject(option)?.id; if (typeof id === "string") {
                    if (seen.has(id))
                        fail(diagnostics, "OPTION_DUPLICATE", `Duplicate option ID ${id}`, `${path}/options/${i}/id`);
                    seen.add(id);
                } });
            }
            if (obj.fallback !== undefined)
                requireRef(obj.fallback, `${path}/fallback`);
            return;
        case "branch":
            if (!Array.isArray(obj.branches) || obj.branches.length === 0)
                fail(diagnostics, "BRANCHES", "Branch needs at least one branch", `${path}/branches`);
            else
                obj.branches.forEach((branch, i) => {
                    const p = `${path}/branches/${i}`;
                    const b = asObject(branch);
                    if (!b) {
                        fail(diagnostics, "BRANCH", "Expected branch object", p);
                        return;
                    }
                    validateCondition(b.when, `${p}/when`, diagnostics, registry);
                    requireRef(b.next, `${p}/next`);
                });
            requireRef(obj.fallback, `${path}/fallback`);
            return;
        case "action":
            validateActions(obj.actions, `${path}/actions`, diagnostics, registry);
            requireRef(obj.next, `${path}/next`);
            return;
        case "scene":
            if (typeof obj.scene !== "string" || !obj.scene)
                fail(diagnostics, "SCENE", "scene must be a non-empty ID", `${path}/scene`);
            requireRef(obj.next, `${path}/next`);
            return;
        case "module":
            if (typeof obj.module !== "string" || !registry.modules.has(obj.module))
                fail(diagnostics, "MODULE_UNKNOWN", `Module is not registered: ${String(obj.module)}`, `${path}/module`);
            if (!asObject(obj.outcomes) || Object.keys(obj.outcomes).length === 0)
                fail(diagnostics, "MODULE_OUTCOMES", "Module node needs outcome destinations", `${path}/outcomes`);
            else
                for (const [outcome, target] of Object.entries(obj.outcomes))
                    requireRef(target, `${path}/outcomes/${outcome}`);
            return;
        case "end":
            if (typeof obj.ending !== "string" || !obj.ending)
                fail(diagnostics, "ENDING", "ending must be a non-empty ID", `${path}/ending`);
            return;
        default: {
            const extension = registry.nodes.get(obj.type);
            if (!extension) {
                fail(diagnostics, "NODE_TYPE", `Unregistered node type ${obj.type}`, `${path}/type`);
                return;
            }
            if (extension.validate)
                for (const error of extension.validate(node))
                    fail(diagnostics, "EXTENSION_DATA", error, path);
        }
    }
}
export function validateStory(input, modules = []) {
    const diagnostics = [];
    let registry;
    try {
        registry = Array.isArray(modules) ? createModuleRegistry(modules) : modules;
    }
    catch (error) {
        return { diagnostics: [{ code: error instanceof EngineError ? error.code : "MODULE", message: error instanceof Error ? error.message : String(error), path: "/modules", severity: "error" }], valid: false };
    }
    const story = asObject(input);
    if (!story)
        return { diagnostics: [{ code: "STORY", message: "Expected a JSON object", path: "$", severity: "error" }], valid: false };
    try {
        assertJson(input);
    }
    catch (error) {
        fail(diagnostics, error instanceof EngineError ? error.code : "JSON", error instanceof Error ? error.message : String(error), error instanceof EngineError ? error.path ?? "$" : "$");
        return { diagnostics, valid: false };
    }
    if (story.schemaVersion !== "1")
        fail(diagnostics, "SCHEMA_VERSION", "schemaVersion must be \"1\"", "/schemaVersion");
    for (const key of ["id", "version", "title", "start"])
        if (typeof story[key] !== "string" || !story[key].trim())
            fail(diagnostics, "REQUIRED", `${key} must be a non-empty string`, `/${key}`);
    if (!Array.isArray(story.nodes) || story.nodes.length === 0)
        fail(diagnostics, "NODES", "Story needs a non-empty nodes array", "/nodes");
    for (const key of ["variables", "assets", "characters"])
        if (story[key] !== undefined && !asObject(story[key]))
            fail(diagnostics, "COLLECTION", `${key} must be an object`, `/${key}`);
    const variables = asObject(story.variables) ?? {};
    for (const [name, value] of Object.entries(variables)) {
        const def = asObject(value);
        if (!def || !["string", "number", "boolean"].includes(String(def.type)))
            fail(diagnostics, "VARIABLE", `Invalid variable definition: ${name}`, `/variables/${name}`);
        else if ((def.type === "string" && typeof def.default !== "string") || (def.type === "number" && (typeof def.default !== "number" || !Number.isFinite(def.default))) || (def.type === "boolean" && typeof def.default !== "boolean"))
            fail(diagnostics, "VARIABLE_DEFAULT", `Default does not match type for ${name}`, `/variables/${name}/default`);
    }
    const nodes = Array.isArray(story.nodes) ? story.nodes : [];
    const ids = new Set();
    nodes.forEach((node, i) => {
        const obj = asObject(node);
        if (typeof obj?.id === "string") {
            if (ids.has(obj.id))
                fail(diagnostics, "NODE_DUPLICATE", `Duplicate node ID ${obj.id}`, `/nodes/${i}/id`);
            ids.add(obj.id);
        }
        validateNode(node, i, diagnostics, registry);
    });
    const refs = [];
    nodes.forEach((node, i) => {
        const o = asObject(node);
        if (!o)
            return;
        const add = (id, path) => { if (typeof id === "string")
            refs.push({ id, path }); };
        if (["dialogue", "narration", "action", "scene"].includes(String(o.type)) || String(o.type).includes(":"))
            add(o.next, `/nodes/${i}/next`);
        if (o.type === "choice" && Array.isArray(o.options))
            o.options.forEach((opt, j) => add(asObject(opt)?.next, `/nodes/${i}/options/${j}/next`));
        if (o.type === "choice")
            add(o.fallback, `/nodes/${i}/fallback`);
        if (o.type === "branch" && Array.isArray(o.branches))
            o.branches.forEach((b, j) => add(asObject(b)?.next, `/nodes/${i}/branches/${j}/next`));
        if (o.type === "branch")
            add(o.fallback, `/nodes/${i}/fallback`);
        if (o.type === "module")
            for (const [outcome, next] of Object.entries(asObject(o.outcomes) ?? {}))
                add(next, `/nodes/${i}/outcomes/${outcome}`);
    });
    for (const ref of refs)
        if (!ids.has(ref.id))
            fail(diagnostics, "NODE_MISSING", `Node reference not found: ${ref.id}`, ref.path);
    if (typeof story.start === "string" && !ids.has(story.start))
        fail(diagnostics, "START_MISSING", `Start node not found: ${story.start}`, "/start");
    // Check references inside data expressions/actions, beyond graph destinations.
    const checkReferences = (value, path) => {
        if (Array.isArray(value)) {
            value.forEach((child, i) => checkReferences(child, `${path}/${i}`));
            return;
        }
        const obj = asObject(value);
        if (!obj)
            return;
        // Extension payloads belong to their module validator.
        if ((typeof obj.type === "string" && obj.type.includes(":")) || (typeof obj.op === "string" && obj.op.includes(":")))
            return;
        const variable = typeof obj.var === "string" ? obj.var : (obj.type === "set" || obj.type === "add") ? obj.variable : obj.type === "module" ? obj.resultVariable : undefined;
        if (typeof variable === "string" && !has(variables, variable))
            fail(diagnostics, "VARIABLE_MISSING", `Variable is not declared: ${variable}`, path);
        if (obj.type === "add" && typeof variable === "string" && asObject(variables[variable])?.type !== "number")
            fail(diagnostics, "VARIABLE_TYPE", "add requires a number variable", path);
        if (obj.type === "set" && typeof variable === "string" && ["string", "number", "boolean"].includes(typeof obj.value) && asObject(variables[variable])?.type !== typeof obj.value)
            fail(diagnostics, "VARIABLE_TYPE", "set value does not match variable type", `${path}/value`);
        if (obj.op === "visited" && typeof obj.node === "string" && !ids.has(obj.node))
            fail(diagnostics, "NODE_MISSING", `Visited node not found: ${obj.node}`, `${path}/node`);
        for (const [key, child] of Object.entries(obj))
            if (!["input", "data", "payload"].includes(key))
                checkReferences(child, `${path}/${key}`);
    };
    nodes.forEach((node, i) => checkReferences(node, `/nodes/${i}`));
    const reachable = new Set();
    const queue = typeof story.start === "string" ? [story.start] : [];
    const byId = new Map(nodes.map(n => [String(asObject(n)?.id ?? ""), asObject(n)]));
    const adjacency = new Map();
    nodes.forEach((node, i) => { const id = asObject(node)?.id; if (typeof id === "string")
        adjacency.set(id, refs.filter(ref => ref.path.startsWith(`/nodes/${i}/`)).map(ref => ref.id)); });
    while (queue.length) {
        const id = queue.pop();
        if (reachable.has(id))
            continue;
        reachable.add(id);
        const node = byId.get(id);
        if (!node)
            continue;
        const nextIds = adjacency.get(id) ?? [];
        for (const next of nextIds)
            queue.push(next);
    }
    nodes.forEach((node, i) => { const id = asObject(node)?.id; if (typeof id === "string" && !reachable.has(id))
        warn(diagnostics, "NODE_UNREACHABLE", `Node is unreachable from start: ${id}`, `/nodes/${i}/id`); });
    const assets = asObject(story.assets) ?? {};
    for (const [name, asset] of Object.entries(assets)) {
        const item = asObject(asset);
        if (!item || typeof item.src !== "string" || !["image", "audio", "other"].includes(String(item.type)))
            fail(diagnostics, "ASSET", `Invalid asset ${name}`, `/assets/${name}`);
    }
    for (const [id, character] of Object.entries(asObject(story.characters) ?? {})) {
        const value = asObject(character);
        if (!value || typeof value.name !== "string" || (value.portrait !== undefined && typeof value.portrait !== "string") || (value.expressions !== undefined && (!asObject(value.expressions) || Object.values(asObject(value.expressions)).some(asset => typeof asset !== "string"))))
            fail(diagnostics, "CHARACTER", `Invalid character ${id}`, `/characters/${id}`);
    }
    return { diagnostics, valid: !diagnostics.some(d => d.severity === "error") };
}
export function compileStory(story, modules = []) {
    const registry = createModuleRegistry(modules);
    const result = validateStory(story, registry);
    const errors = result.diagnostics.filter(d => d.severity === "error");
    if (errors.length)
        throw new EngineError("STORY_INVALID", errors.map(d => `${d.path}: ${d.message}`).join("\n"));
    const copy = cloneJson(story);
    const freeze = (value) => { if (value && typeof value === "object") {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
    } };
    freeze(copy);
    return { story: copy, nodes: new Map(copy.nodes.map(node => [node.id, node])), registry };
}
export function formatDiagnostics(result, format = "text") {
    if (format === "json")
        return JSON.stringify(result, null, 2);
    return result.diagnostics.map(d => `${d.severity.toUpperCase()} ${d.code} ${d.path}: ${d.message}`).join("\n") || "No issues found.";
}
export function validateExpressionForContent(expression) {
    return expression !== undefined;
}
//# sourceMappingURL=index.js.map