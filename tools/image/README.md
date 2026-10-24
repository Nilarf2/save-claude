# 游戏美术流程

通用生图、蒙版编辑、透明处理和审核工具来自 `engine/tools/image/`；它们的源码在独立引擎仓库维护。服务地址、模型与凭据由操作者自行配置，仓库没有读取本机私有配置的脚本。

游戏内容分别维护在：

- `assets/char-redrawn/prompts/`：正式角色与表情、动作、补边提示词。
- `assets/background-prompts/`：20 个场景的提示词。
- `marketing/release/cover-prompt.txt`：当前封面提示词。
- `web/character-portraits.json`：角色、表情和动作对应的正式文件。
- `story/stage-plan.json`：对白中的左右站位、焦点和动作。

先审核一张角色基准，再生成变体。若原图把头发、头纱或道具切断，先补绘缺失轮廓；扩大画布、模糊边缘或 CSS 缩放都不算补绘。不要因蒙版保护了中心区域就跳过脸、手、衣饰的一致性检查。

已批准的透明半身候选图可用本游戏的薄封装处理（Python 环境需安装引擎的 Pillow 依赖）：

```sh
python tools/image/process-portrait.py --src path/to/approved-candidate.png --out build/new-portrait.webp
```

此步骤去除 alpha 不大于 8 的几乎不可见导出杂点，再调用通用工具等比放进 1536 × 1536 画布；上、左、右留 48 像素，半身下摆对齐底部，不横向挤压或裁掉头发。最后按质量 91 编码 WebP，保留透明通道，降低手机首次加载量。返回码 2 表示原图仍有贴边风险，需要人工判断。已有输出不会被覆盖。

在深色、浅色和棋盘格下审阅后，才替换清单指向的正式 WebP。随后运行 `python tools/release/build-portrait-review.py` 更新 `web/portraits.html`，并在游戏的桌面、手机横屏和竖屏中检查。完整工作流见 `engine/docs/WORKFLOW.zh-CN.md`；素材权利范围见根目录 `ASSET-LICENSE.md`。
