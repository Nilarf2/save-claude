# Architecture

## Data flow

```text
JSON story -> validateStory -> compileStory -> GameSession
                                           | commands
                                           v
                                    state transition
                                           |
                             state + events + effects
                                           |
                          UI / audio / storage adapters
```

The compiler validates the authoring data and creates an ID index. The core owns mutable session state privately. Each command runs against a draft state; only successful commands publish a new revision and their buffered events/effects. Subscriber errors are reported to the configured error callback and do not roll back committed state. Subscribers cannot dispatch reentrantly.

## Runtime boundaries

- `core` only performs deterministic calculations. It does not access browser APIs, files, network, system time, or `Math.random()`.
- The host owns presentation and effect delivery. Core effects describe requested work; the host decides how to render or play it.
- Music and ambience are persistent desired state stored in snapshots. SFX are one-shot effects and are not replayed by restore.
- Module requests are persisted with monotonic IDs. The host may reattach pending work after restore; only the matching request ID can resume the session.
- Runtime views, snapshots, events, and effects are copied before exposure so callers cannot mutate internal session state through returned objects.

## Story nodes

`dialogue` and `narration` reveal lines one at a time. `choice` exposes available options. `branch` picks the first matching condition or fallback. `action` runs a list of actions. `scene` sets scene and audio state. `module` creates a pending module request and waits for a result. `end` marks an ending.

Conditions are data expressions rather than JavaScript. Built-in operators include comparisons, boolean composition, tags, visited counts, and seeded random expressions. Choice views use a stable preview value derived from the saved PRNG state; inspecting a view never advances the PRNG. Automatic branches and actions consume the PRNG in execution order.

## Module contract

Modules declare an ID, version, dependencies, state version, optional initial state and migration, then register namespaced nodes, actions, conditions, commands, and capabilities. Names must start with the owning module ID (for example `combat:encounter`). Registration order follows dependency order and conflicts fail during registry construction.

Module state must be JSON data. Keep external services behind host-owned capabilities and emit runtime effects for stateful work that must be transactional. Side effects performed directly by plugin code cannot be rolled back by the engine.

## Save contract

Snapshots include engine/schema/content and module versions, current node/line cursor, variables, tags, visit counts, PRNG state, request counter, module slices, pending request, current scene, persistent audio state, and ending/checkpoint metadata. Restoring never reruns a node's `onEnter` actions. Module version changes require a module migration; incompatible game/schema versions fail before replacing active state.

## Validation and restore details

The content compiler clones and freezes JSON story data and detaches module metadata from the caller. Compiled maps are exposed as TypeScript `ReadonlyMap`; hosts must not cast away that contract to mutate their registries or indexes.

Core depends on save's shared `validateSnapshot` and `validateSnapshotForStory` checks (save depends only on module-api, so no cycle). Invalid cursors, PRNG/counters, variable types and pending request identities fail before changing the active session. `prepareSnapshot` handles explicit content/module migrations and normalizes compatible engine versions; direct restore requires the current engine version.

Restore replaces optional fields, emits stops for absent persistent audio channels, and never replays SFX or onEnter. Hosts must reconstruct visual state, including clearing absent scenes/actors, from returned state and persisted game-owned stage module slices. Group character staging is intentionally a host/module concern.

A choice with no selectable options takes its `fallback`. Without a fallback it throws transactionally. View construction and event/effect copying happen before commit, and exceptions in listener error reporting cannot invalidate a committed command. Numeric writes enforce declared types and finite values.
