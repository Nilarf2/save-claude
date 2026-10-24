# 只读剧情地图与路线检查

在游戏仓库根运行 `npm run build:map`，或运行 `node tools/authoring/build-story-map.mjs <输出目录>` 指定位置。生成器从当前 `web/story.json` 提取节点、选择、条件、跳转与状态变化；地图支持搜索、按章定位与查看连线，不写回剧情或玩家存档。

当前内容从 A00 开始，69 章、18 个结局。HUB 不在正常开场路径；侧线与联合路线依据同一会话的累计状态，不需要跨周目全通。具体制作约定见 [ROUTE-WIRING.md](ROUTE-WIRING.md)。

修改源剧本后先 `npm run build`，再 `npm run check`；需要地图时重新生成。`check` 包括结局、道具行动与代表路线，测试覆盖以当前脚本为准。地图页面需要 HTTP 静态服务，不建议双击 HTML。
