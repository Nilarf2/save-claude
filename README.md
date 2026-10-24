# 拯救 Claude 大小姐

中文文字冒险游戏（AVG）。在黑金哥特风格的教堂与幻方大院之间，跟随 Claude 和 DeepSeek 的选择，寻找「迷一次路」的可能。

当前内容版本 **1.1.0**，包含 **69 章、18 个结局**。普通新局从 **A00** 开始；选择、道具和关系在本轮旅程中累积，侧线可以回到正文，没有必须跨周目全通的条件。人性、合规、羁绊、污染是累计分数，不会统一封顶到 100。

在线游玩：[VibeHub](https://gamesvibe.app/play/dmasjcjx8zhg8rIwpmJGL)。BilibiliToy 的当前提交尚未通过内容审核，暂不提供正式游玩链接。

本仓库是这款游戏的内容、界面与交付工具。通用确定性状态机来自独立项目 [Text Adventure Engine](https://github.com/Nilarf2/text-adventure-engine)；游戏内 `engine/` 是有来源记录的运行快照，不是另一套独立开发的引擎。

## 运行游戏

需要 Python 3 和现代浏览器；游玩不需要 npm、API 密钥或图像生成服务。在仓库根目录运行：

```sh
python3 -m http.server 8123 --bind 127.0.0.1
```

打开 <http://127.0.0.1:8123/web/index.html>。Windows 可把 `python3` 换为 `py -3`。不要直接双击 HTML：浏览器会限制 `file://` 的模块与剧情读取。

已准备的离线运行包带有 `run.py` 和启动脚本，完整解压后运行 `python3 run.py`；Windows 也可双击包内启动脚本。游戏本体无需联网生成素材。

## 操作与存档

- 点击对白框或按空格/回车继续；点击选项或按 A/B/C/D 选择。
- 菜单提供日志、六个手动档位、读档、自动播放与音乐/音效设置；结局页也能读档或回标题。
- 在当前版本内，新开游戏会确认是否替换现有自动档，手动档保留；损坏档位会温和提示，不影响其他当前版进度。
- 存档属于当前浏览器和网址，换设备、浏览器或端口不会自动同步。
- **首次载入 1.1.0 时会清理本游戏旧版的自动与手动剧情存档，从新版本开局，不迁移旧档。** 当前版存档在刷新后保留；音频偏好及其他应用的数据不清理。

舞台每行明确在场人物与左右位置，当前说话者明亮、另一人暗化；立绘不使用模糊。背景和目标立绘准备后才开始打字，慢网会显示画面加载提示；等待超过 12 秒后可继续阅读，图片下载完成后仍会补上，换场后不会误贴旧图。手机横竖屏的对白、选项和菜单可滚动。

## 从源码准备交付包

开发检查需要 Node.js 20.19+、npm 和 Python 3.11+。已有引擎运行快照可直接使用：

```sh
npm ci --ignore-scripts
npm run build
npm run check
npm run build:map
```

`build` 将 `story/03-story.md`、舞台计划和立绘登记编译为 `web/story.json`；`check` 检查引擎来源、源码与快照一致性、舞台及固定路线/结局回归。地图为只读作者工具。

准备发布输入后，先检查再写入新的输出目录：

```sh
python3 tools/release/build-portrait-review.py
python3 tools/release/build-release.py --out-dir ../save-claude-release/1.1.0 --version 1.1.0 --check-only
python3 tools/release/build-release.py --out-dir ../save-claude-release/1.1.0 --version 1.1.0
```

输出目录已存在时命令会拒绝覆盖。准备包仅写本地产物，不代表上传或正式发布。运行包从明确清单收集剧情、实际引用素材、封面、字体和引擎模块，不需要携带制作参考或凭据。

发布包将引擎脚本放在 `runtime/`，避免平台上传工具跳过嵌套的 `dist/` 目录。上传成功后还必须检查实际托管页面；构建成功不代表线上文件齐全。在已安装 Playwright 和 Chromium 的环境中，可对解压后的本地服务或线上游戏页面运行：

```sh
AUDIT_URL=https://example.com/game/index.html node tests/ui/startup-audit.mjs
```

该检查验证引擎脚本的 HTTP 状态和文件类型、实际开局，以及文件缺失时的提示和重试。`AUDIT_URL` 应指向游戏页面本身；平台外层页面需要另行打开试玩。现有浏览器安装可通过 `PLAYWRIGHT_MODULE` 和 `CHROMIUM_PATH` 指定。

更新引擎时，应先在独立引擎仓库安装并构建，再用 `node tools/sync-engine.mjs --source <引擎检出目录>` 同步，随后重新执行上述构建与检查。来源、提交和文件清单见 `engine/UPSTREAM.json`；正式交付应使用已提交的干净引擎版本。

## 文件与授权

| 位置 | 用途 |
|---|---|
| `story/03-story.md`、`story/stage-plan.json` | 正式剧本与显式舞台计划 |
| `web/` | 静态游戏、编译剧情与正式素材 |
| `web/character-portraits.json` | 运行时角色、别名、表情与动作登记 |
| `assets/ASSET-SOURCES.json` | 素材类别、文件与可核实来源 |
| `marketing/release/` | 当前选定封面及发布媒体 |
| `tools/authoring/` | 只读地图与路线检查 |
| `engine/UPSTREAM.json` | 独立引擎快照来源 |

项目代码适用根目录 [MIT License](LICENSE)。**剧情、立绘、背景、封面和音频不因此自动获得 MIT 授权，也不代表整个素材库可以自由商用。** 素材及字体的范围、来源与待确认权利见 [ASSET-LICENSE.md](ASSET-LICENSE.md)。维护说明见 [HANDOFF.md](HANDOFF.md)，当前设计见 [story/00-design.md](story/00-design.md)。
