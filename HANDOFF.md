# 维护说明

本项目是《拯救 Claude 大小姐》游戏，不是通用引擎的主仓库。Narrative 引擎维护与版本更新应在 [General Engine](https://github.com/Nilarf2/general-engine) 进行；本仓库通过 `tools/sync-general-engine.mjs` 从显式的干净检出生成受控 tarball，保留 `vendor/general-engine/PROVENANCE.json`、包内许可证和锁定 hash。

迁移后的 API 边界和更新命令见 [General Engine Consumer](docs/ENGINE-MIGRATION.md)。

## 当前内容约定

- 游戏内容版本为 1.1.0，69 章、18 个结局；从 A00 正常开场，HUB 只保留作者预览用途。
- 全部条件依据当前会话的累计分数、标签和访问记录判断；没有跨周目强制条件。声明范围用于作者检查，运行时不会把所有分数截断为 0–100。
- 剧本来源为 `story/03-story.md`，舞台来源为 `story/stage-plan.json`，角色登记为 `web/character-portraits.json`。不要仅修改生成的 `web/story.json`。
- Codex 是 GPT 的历史别名，显示与舞台只使用同一个 GPT 角色。
- 剧情存档按内容版本隔离，当前使用 1.1.0。首次载入清理本游戏无版本前缀及其他版本的自动/六个手动剧情档，不迁移旧档；当前版本存档刷新后保留。清理必须精准匹配剧情档键，不使用 localStorage.clear，不删除音频偏好或其他应用数据。

## 工作流程

1. 阅读当前源文件及 [剧本格式](story/FORMAT-PROMPT.md)。修改剧情后同时核对动作、道具与舞台计划，保持已有结局意图。
2. 在仓库根执行 `npm ci --ignore-scripts`、`npm run build`、`npm run check`。只改文档不必重编剧情；只改素材时做对应画面和资源的定向检查。
3. 需要作者地图时运行 `npm run build:map`；地图不写入玩家存档或剧本。
4. 使用独立浏览器上下文检查实际变化。界面测试在 `tests/ui/player-audit.mjs`，需可用 Playwright 与 Chromium，可通过环境变量指定路径；不要把测试环境绝对路径作为项目依赖。
5. 按 README 的准备包流程检查输入并生成新目录。确认包内入口、字体、音频、剧情与 Narrative runtime 能读取，再做发布审阅。

更新引擎前先在其独立检出目录执行 `npm ci` 和 `npm run build`；用 `tools/sync-general-engine.mjs --source /absolute/path/to/general-engine` 同步后重新检查游戏。脚本拒绝 dirty 检出；tarball 之外不把引擎源码复制进本项目。

## 素材维护

当前使用已选定的群像封面 `web/assets/cover/title.webp`，发布媒体在 `marketing/release/`，不要恢复历史候选。立绘生产字段由正式登记决定；图像尺寸、补画批次和外观验收以实际文件与本次审阅为准，不沿用旧制作日志的完成宣称。

新增文字后须核对本地字体子集是否覆盖字符；重建字体时保留上游版权、OFL 及修改后的独立字体名。更换图像或音频前更新 [素材清点](assets/ASSET-SOURCES.json) 并核实授权，不把拥有文件或生成记录视为第三方授权。

## 验证边界

静态回归、路线回归、浏览器操作和视觉审阅分别记录。脚本通过不等于全设备兼容、每张画面无瑕疵或第三方权利已获许可；旧制作记录不作为当前版本的测试结果。平台上传和正式发布需要另行审阅，准备包本身不会发布。
