# AI Agent Development Guide

## Where to work

- Add built-in story data fields and validation in `packages/module-api` and `packages/content` together.
- Keep deterministic state transitions inside `packages/core`.
- Put browser-only behavior in `packages/web-adapter`.
- Put save persistence and snapshot checks in `packages/save`.
- Keep commands and diagnostics in `packages/cli`.

## Adding a game module

1. Create a package that depends on `@text-adventure/module-api`.
2. Give the module a stable lowercase ID and a semantic version.
3. Register namespaced commands, actions, conditions, nodes, or capabilities, such as `combat:encounter`.
4. Keep module state JSON-serializable and define a state migration when its shape changes.
5. Return module results with the request ID currently awaiting in the session.
6. Add a narrow smoke scenario that exercises the module through the public session API.

## Adding a story field

Update the public TypeScript type, JSON Schema, content validation, compiler/runtime handling if it affects execution, and the docs/template if authors must fill it in. Diagnostics should report the file location and JSON path where possible. Unknown fields should not be silently interpreted by the runtime.

## Determinism and transaction rules

- Do not read ambient time or use `Math.random()` in core code.
- Use the session PRNG for any random decision.
- Stage state changes, events, and effects until the command succeeds.
- Do not perform network, audio, or storage work inside a command handler.
- Preserve order when applying actions, emitting events, and returning effects.
- Do not expose mutable internal state.

## Validation

Run `npm run typecheck`, `npm run build`, `npm test`, the compact `npm run check:flow`, and `npm run check:example`. For changes to Python tools, run `python3 tests/test_tools.py` in an environment with `tools/image/requirements.txt` installed. Keep checks focused on behavior changed by the patch. Hashes, MD5, SHA, load tests, and broad browser suites are not part of this project's validation workflow.

## Reusable authoring and art boundaries

Read `docs/WORKFLOW.zh-CN.md` before changing a game's production flow. Generic CLIs live in `tools/authoring` and `tools/image`; keep all inputs and output paths explicit. Never add a project name, private reference, provider key, implicit `.env` discovery, paid request retry or automatic model download. Generation is opt-in; tests are offline.

Game-specific compilers, staging modules, manifests, assets and actual prompts stay in the game. Edit its authoritative source and regenerate derived JSON/maps/review pages. Never claim that static graph reachability proves a route can be played, or that padding repairs clipped hair/hands/props. A runtime vendor copy must contain all five packages from one recorded engine revision.
