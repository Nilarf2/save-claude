# Notices and attribution

General Engine source and original example content are copyright © 2026 Nilarf2, released under the [MIT license](LICENSE). The repository includes code inherited from the earlier Harbor engine branch; that provenance is retained below.

## Upstream code and content

`src/assets/AssetManager.ts`, `src/assets/Actor.ts`, and `src/assets/disposeObject.ts` were adapted and extended from [Nilarf2/dragon-raja-grand-escape](https://github.com/Nilarf2/dragon-raja-grand-escape) at commit `658c1b4fb4f6f3fa41ce6b246c7700fc5f409894`. Original code copyright © 2026 Nilarf2, MIT. `public/models/mannequin.glb` is that project's original procedural MIT test model. No novel text, real-world map database, GSI elevation or other location content is included.

[dgreenheck/tidewater](https://github.com/dgreenheck/tidewater) was studied for architectural and visual-technique comparisons. No Tidewater source, shader or third-party art was copied into this implementation. See [RESEARCH.md](docs/RESEARCH.md) for other researched projects; a reference does not imply an incorporated dependency.

## Runtime packages

- **Three.js 0.186.1**, MIT, copyright the Three.js authors. Full notice: `public/licenses/three.txt`.
- **three-gpu-pathtracer 0.0.27**, MIT, copyright © 2021 Garrett Johnson. The quality renderer reuses its native WebGPU path tracer, material/camera support, and integration APIs. Full notice: `public/licenses/three-gpu-pathtracer.txt`.
- **three-mesh-bvh 0.9.15**, MIT, copyright © 2018 Garrett Johnson. Acceleration-structure dependency of the quality renderer. Full notice: `public/licenses/three-mesh-bvh.txt`.
- **xatlas-web 0.1.0**, MIT. Its distributed license credits © 2018–2020 Jonathan Young; the npm WebAssembly wrapper is maintained by Mozilla Reality. Required upstream package dependency; General Engine does not claim an implemented UV-authoring or light-baking workflow. Full distributed notice: `public/licenses/xatlas-web.txt`.
- **Rapier JavaScript compat 0.21.0**, Apache-2.0, Dimforge and contributors. Full license: `public/licenses/rapier.txt`. Optional runtime physics dependency; its compat JavaScript includes the WebAssembly payload.
- **Meshoptimizer decoder**, MIT, copyright Arseny Kapoulkine. Distributed through Three.js's addon decoder. Full notice: `public/licenses/meshoptimizer.txt`.
- **TypeScript definitions** (`@types/three`, MIT, DefinitelyTyped contributors; `@webgpu/types`, BSD-3-Clause, the W3C GPU for the Web Community Group): development/editor contracts distributed as package dependencies so downstream projects retain their public types. Their notices ship with the respective npm packages.

Bundled website exports include the `licenses/` directory. The independent game generator copies these notices into the generated application's `public/licenses/`, so they also accompany its static build. Keep them when repackaging or deploying a game.

The generic StoryRunner and SpatialIndex modules were generalized from Nilarf2's MIT-licensed Dragon Raja project (© 2026 Nilarf2). Application story text, location maps and game-specific collision rules are not included in those modules.

通用 StoryRunner 与 SpatialIndex 模块提取自 Nilarf2 的 MIT Dragon Raja 项目（© 2026 Nilarf2）；模块不包含小说正文、地点地图或游戏专用碰撞规则。

The data-driven narrative content, deterministic session, save-migration and host-adapter contracts in `src/narrative/workflow-*.ts` are adapted from Nilarf2's MIT-licensed [text-adventure-engine](https://github.com/Nilarf2/text-adventure-engine), reviewed at commit `131a045126ef6b9ad2cf761eaa8d6d5e0b11b942`. The implementation in this repository is integrated into General Engine's package and composition boundaries. No story, character, image, audio, map or other game content is included. The MIT notice in this repository applies to this adapted code.

## Offline development tools

- **glTF Transform core/extensions 4.5.1**, MIT, copyright © 2024 Don McCurdy. Used by the offline GLB pipeline. Full notice: `public/licenses/gltf-transform.txt`.
- **meshoptimizer 1.3.0**, MIT, copyright © 2016–2026 Arseny Kapoulkine. CPU/WebAssembly encoding and decoding for the offline GLB pipeline. Full notice: `public/licenses/meshoptimizer.txt`.
- **Khronos glTF Validator 2.0.0-dev.3.10**, Apache-2.0, The Khronos Group Inc. The npm distribution includes additional Dart and third-party notices. Preserved in `public/licenses/gltf-validator.txt` and `public/licenses/gltf-validator-notices.txt`.

These tools are development dependencies, not game content. Vite, TypeScript, tsx, Playwright and other tooling retain their distributed package licenses. Research references such as MuTracer, Recast Navigation, KTX-Software and Basis Universal are not bundled dependencies. No researched gallery assets are included.

## Collaboration

Nilarf2 directed the project. Codex (OpenAI) contributed as an AI programming collaborator. This attribution describes assistance; it does not claim sponsorship or endorsement by OpenAI or the authors of researched projects.

## Open Image Denoise / 图像降噪

`oidn-web` 0.5.0 is distributed under MIT; see `public/licenses/oidn-web-LICENSE.txt` and [its pinned source](https://github.com/pissang/oidn-web/tree/057e5a6d7cf5a8e7f7373ef054bd50627e909715). The separately distributed `rt_hdr_calb_cnrm_large.tza` weights originate from RenderKit/oidn-weights commit `28883d1769d5930e13cf7f1676dd852bd81ed9e7` and are licensed under Apache-2.0; see `public/licenses/OIDN-weights-LICENSE.txt` and `public/oidn/manifest.json`. The npm package's MIT license does not relicense those weights.

`oidn-web` 运行库采用 MIT；随包静态精修权重来自固定版本 RenderKit/oidn-weights，单独采用 Apache-2.0，不能以运行库许可证替代。应用复制权重时必须一并保留上述许可证与来源清单。
