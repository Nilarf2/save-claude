# 可复用审核工具

工具不含游戏正文、角色名称、参考图、默认项目路径或凭据。输入留在项目中，输出建议写入新的 `build/` 子目录。页面只用于审核，不保存游戏或回写源剧本。

```sh
node tools/authoring/compile-markdown.mjs --config examples/minimal-markdown/compiler.json
node tools/authoring/build-story-map.mjs --story examples/minimal/story.json --out build/story-map --revision working-copy
# 已有 check-route 输出时可随地图一起导入
node tools/authoring/build-story-map.mjs --story examples/minimal/story.json --out build/story-map --trace build/route.json
python3 tools/authoring/build-portrait-review.py --manifest path/to/portraits.json --asset-root path/to/web --out build/portrait-review
node tools/authoring/check-route.mjs --story examples/minimal/story.json --route examples/minimal/route-count.json --out build/route.json
```

Markdown 的命令行参数、语法、游戏配置与纯函数接口见[完整示例](../../examples/minimal-markdown/README.md)。编译器不内置某个游戏的标签别名或角色身份，配置中显式给出；编译结果须再经内容校验和真实路线检查。

剧情地图的 `index.html` 可以直接打开；本地 `story-map-data.js` 提供离线数据，`story-map.json` 是便于检查的同一份快照。页面支持搜索、章节总览、全部节点、一跳邻居、选项/条件/状态变化和完整节点数据。`story-map/` 现在有四个页面源文件（包括 Node/离线页面共用的 `review-data.js`），必须一起同步。章节默认取节点 ID 的冒号前缀；布局不假定某个游戏的章节字母。生成器接受带扩展字段的剧情，但只验证节点及连线结构，不代替 `validateStory` 或游戏自定义模块校验。模块的动态返回目标若未写在 `next/outcomes` 中，地图无法推断。

可通过 `--meta source-map.json` 加入源文件定位，格式如下。路径是用于显示的项目相对路径，不会读取源文档，也不会泄露本机绝对路径。地图中的章节/行号只是编译器提供的定位信息，修改源后必须重新生成。

```json
{"sourceDocument":"story/main.md","chapterTitles":{"intro":"开场"},"chapterLines":{"intro":12}}
```

立绘审核清单由游戏维护。`portrait/poses/expressions` 的值为相对于 `--asset-root` 的本地素材路径；不支持 URL、不越界读图，不要求特定图片目录名。生成器会复制被引用的图片到独立审核目录，直接打开页面即可对照暗底、亮底与棋盘格。标题与角色名会转义。

```json
{"title":"角色审核","characters":{"guide":{"name":"示例角色","portrait":"assets/guide.png","poses":{"holding":"assets/guide-holding.webp"},"expressions":{"smile":"assets/guide-smile.webp"}}}}
```

路线文件包含 `seed`、按玩家停顿节点记录的 `steps`、预期 `ending`，可加结局变量 `variables` 与必备 `tags`。参考 `examples/minimal/route-*.json`。工具只通过真实 `start/dispatch` 推进，不修改状态、强设变量或直接跳到结局。输出含每个停顿状态及最终快照，属于项目私有审核证据；若包含尚未公开剧情，不放进公开发行包。

游戏有扩展节点/动作/条件时，显式 `--modules ./game-modules.mjs`，文件默认导出 `AdventureModule[]`。该文件会执行，只加载本项目批准的本地适配器；引擎不会代为联网或调用生图服务。模块请求需要路线内写正确的 `module.result` 和请求 ID；异步宿主逻辑、舞台渲染及资源加载仍须游戏实机验证。


## 静态结构提示与真实路线证据

地图左侧列出已声明边可达数、非起点零入边、静态未可达、非结局零出边、没有已知结局路径的节点，并可点击定位。带风险的节点用虚线框提示。正常 `end` 没有出边不报警；断开但自成环的节点仍能被找出。

这只是结构分析：条件真假、变量、随机值和选项禁用都不求值。自定义节点可能返回未声明目标，宿主模块是否完成也不是地图能保证的；相应情况显示“无法静态判断”，不武断认定为错误。已声明边连通不能证明玩家路线实际可玩。

先使用前面的 `check-route.mjs` 产出证据，再在页面选择“导入路线 JSON”，或生成时加 `--trace check-route-output.json`。只接受该工具的完整输出结构：顶层与 snapshot 的故事 ID/内容版本须和地图一致，结尾快照必须在格式上对应当前故事的 `end`，访问计数、停顿节点和类型须匹配。文件不超过 10 MiB；不接受原始 route 输入文件冒充执行证据。错误导入会保留原有审核记录，可用“清除证据”取消高亮。

高亮**仅来自最终 `snapshot.state.visits` 的正计数**，不为 trace 补造自动节点/连线。上一/下一停顿展示 `trace` 的视图 JSON，最终状态单独展示。现有 check-route 输出未记录逐步输入命令和每次自动跳转顺序，因此页面明确写“输入命令未记录”，不从相邻停顿猜选项或精确边。模块停顿里已经记录的 `pending.input` 会作为 JSON 数据显示。

地图不会 dispatch、读写玩家存档、播放音频或执行模块；它只是浏览导入记录，仅做格式/版本核对，不是执行重验或防伪证明，也不能证明文件未被修改。普通 JSON 字典键保留为数据（包括 `constructor`、`prototype`、`__proto__`），不按名称笼统拒绝；节点引用、状态类型仍按具体字段检查。源/内容版本更新后重跑路线、重建地图。路线 JSON 可能包含未公开剧情及存档状态，默认保留在私有制作产物中。

本轮上游设计参考及许可见 [REFERENCES.zh-CN.md](../../docs/REFERENCES.zh-CN.md)，没有复制其实现或加入依赖。
