# 制作审核工具的设计参考

核实日期：2026-10-24。本轮阅读原仓库 README、LICENSE 与官方文档，用于比较审核工作流和数据边界；没有复制这些项目的代码/页面/素材，没有新增依赖，也没有运行或迁移到这些引擎。许可证摘要只描述所链接项目，素材和第三方依赖仍各自授权。

## 本轮实际参考

| 项目与官方资料 | 核实的许可 | 参考内容及本项目的取舍 |
| --- | --- | --- |
| [Kinexus / tin2tin](https://github.com/tin2tin/Kinexus)，[README Features](https://github.com/tin2tin/Kinexus/blob/main/README.md#features) | 本次未在 README/根目录找到明确许可证，GitHub 许可字段为空；不将公开可读视为 MIT 授权。 | 故事地图提供起点、死路、孤立节点等可见状态。我们只为只读地图增加静态结构提示，不复制编辑器或改变“源剧本→编译数据”的权威关系；我们的 `end` 是合法终点，不按死路处理。 |
| [Ren'Py](https://github.com/renpy/renpy)，官方 [image tag/attributes](https://www.renpy.org/doc/html/displaying_images.html#concept-image)、[show](https://www.renpy.org/doc/html/displaying_images.html#show-statement)、[scene](https://www.renpy.org/doc/html/displaying_images.html#scene-statement)、[lint](https://www.renpy.org/doc/html/developer_tools.html#lint) | 官方 [许可说明](https://www.renpy.org/doc/html/license.html)：大部分代码 MIT，另含 LGPL 来源及多种第三方许可，不能概括整个 SDK 只有 MIT。 | 参考显式身份、视觉属性和清场/退场边界，以及潜在错误提示的职责。当前继续使用游戏自己的舞台模块/资源清单，本轮不再建立第二套 tag 系统。 |
| [Route Engine](https://github.com/RouteVN/route-engine)，[History and Seen State](https://github.com/RouteVN/route-engine/blob/main/docs/Concepts.md#history-and-seen-state)、[Contexts](https://github.com/RouteVN/route-engine/blob/main/docs/Concepts.md#contexts) | [MIT](https://github.com/RouteVN/route-engine/blob/main/LICENSE) | 文档将对白历史、当前分支回滚和账号已读集合分开。我们的地图只浏览本次路线证据；不把全局“曾经访问”当作本次路径，不把证据回放当作玩家回滚，也不执行存档副作用。 |
| [Loreline](https://github.com/jeremyfa/loreline)，[Testing](https://github.com/jeremyfa/loreline/blob/main/README.md#testing)、[官方文档](https://loreline.app/en/docs/) | [MIT](https://github.com/jeremyfa/loreline/blob/main/LICENSE) | 文档以选择序列、预期输出和指定对白/选择位置保存恢复描述测试。我们保留少量真实路线与定点恢复验证，并浏览已有执行证据，不引入全事件组合 sweep 或替换现有编译器。 |

本轮实现限于两项：静态结构风险提示，以及完整 `check-route` 输出的只读导入/停顿浏览。静态分析忽略条件真假，动态扩展/模块的未知处明确标识；证据节点高亮只使用正数 visits，未记录的逐步输入和自动边顺序不推断。导入文件仍是数据，页面不执行其中的代码、台词标签或模块请求。

## 已核实但本轮没有移植功能

- [VoidNovel Engine](https://github.com/VoidmatrixHeathcliff/VoidNovelEngine)：[MIT](https://github.com/VoidmatrixHeathcliff/VoidNovelEngine/blob/main/LICENSE)。README 描述节点式创作，并明确文档整理与开发分支现状；没有把规划功能当作已经验证的交付能力。
- [SakiEngine](https://github.com/AimesSoft/SakiEngine)：[MIT](https://github.com/AimesSoft/SakiEngine/blob/main/LICENSE)。[脚本指南](https://github.com/AimesSoft/SakiEngine/blob/main/docs/script-guide.md) 说明姿势、表情和叠加差分；没有引入它的工具链或渲染实现。
- [EasyVN / Eshan276](https://github.com/Eshan276/easyvn)：[MIT](https://github.com/Eshan276/easyvn/blob/main/LICENSE)。与用户描述相符的是浏览器 TypeScript 引擎候选；同名启动器不能混作该项目。
- [ngal / nasyt233](https://github.com/nasyt233/ngal)：[Apache-2.0](https://github.com/nasyt233/ngal/blob/main/LICENSE)，是 Rust 终端 Galgame 引擎；没有采用其宿主命令执行能力。

## 待提供确切链接

REMOTE Engine、Greenlit：待用户提供官方仓库/站点，当前不声明其功能、许可证或与同名项目的关系。Kinexus 也存在同名副本；若用户具体指另一上游，待确切链接后再核对。
