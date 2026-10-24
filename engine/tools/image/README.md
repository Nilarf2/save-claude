# 公共美术工具

只提供通用客户端与离线处理。项目专属提示词、原作参考、角色基准、服务提供方、模型选择和凭据都留在游戏项目。工具不会查找 `.env`、用户目录、工作区约定路径或自动下载抠图模型。

## 离线处理

Python 3.11+，在项目虚拟环境安装 `requirements.txt`。

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r tools/image/requirements.txt
.venv/bin/python tools/image/prepare-sprite.py --src raw/portrait.png --out build/portrait.webp --width 1024 --height 1400 --padding 32 --fail-on-edge
```

默认 `--mode alpha` 保留已有透明，拒绝完全不透明的输入。纯色背景才使用 `--mode flood --key '#ff00ff' --tolerance 38`；不填 `--key` 时取边缘颜色中位数。只移除与边框连通且接近背景色的像素，封闭衣物里的同色区不会被整块删掉；这无法保证精细发丝、反光道具或所有服色无误，必须人工看暗底/亮底。

处理顺序：抠图/保留 alpha → 检查原始主体上/左/右是否贴边 → 裁透明空白 → 同时按宽高等比 contain → 透明画布。不会横向挤压，不会只按高度放大后裁宽。半透明通过 `alpha_composite` 保留，PNG/WebP 输出真实 alpha，WebP 使用无损保存。`--fail-on-edge` 在输出后以状态码 2 报告风险，方便审核流水线收集；原图已经被切掉的部分必须重绘，透明留边不算修复。半身底部贴边只显示提示，不触发该失败。

半身图需要让下摆接入对白框下方时，可加 `--bottom-padding 0`，上方和左右仍使用 `--padding`。这只调整透明留边，不裁掉主体；全身图通常保留默认的四周留边。

## 显式生图/参考图请求

```sh
python3 tools/image/generate-image.py --endpoint https://provider.example/v1/images/edits --model PROJECT_MODEL --prompt-file path/to/prompt.txt --ref path/to/reference.png --out build/new-portrait.png
```

默认仅本地预览请求大小，**不联网、不读取密钥、不生成图片**。需要真实生成时由操作者配置 `IMAGE_API_KEY` 进程环境变量（可用 `--key-env` 指定变量名），核对提供方和费用后显式增加 `--execute`。不能覆盖已有文件；不自动重试，超时须先查服务端状态，避免重复收费。

协议是一个明确的适配器约定，不保证兼容每家服务：无参考图时 POST JSON `{model,prompt,n:1,size,background?}`；有参考图时 POST multipart，单图 `image`，多图重复 `image[]`；响应需 `data[0].b64_json` 或 `data[0].url`，图片格式必须匹配 `--out`。不内置提供方/模型别名，不跟随重定向，不输出响应正文、密钥、签名 URL 或私有提示词。图片 URL 仅接受 HTTPS 默认端口 443，无用户名/密码/片段；解析到的所有地址必须为公网 IP，并固定到已验证的地址建立 TLS 连接。下载使用独立连接，不携带 API Authorization、Cookie，也不使用环境代理；下载上限 50 MiB，连接/读取超时 30 秒，正文传输受总时限检查。输出仍按文件签名核对扩展名。若服务只返回任务 ID 或不同字段，在游戏项目编写专属 adapter，再交回离线处理与审核工具。

通用提示词位于 `templates/prompts/`。先批准一张完整身份/服饰基准，再从同一基准生成表情和动作；不要把多个已漂移的版本互相作为基准。批量处理前先做单张审核。

## 补绘被裁断的轮廓

先检查原图。扩大透明画布或 CSS contain 只能避免再次裁切，不能恢复已经缺失的发丝、头纱或道具。可将完整画面作为编辑目标，并以 `--mask mask.png` 提交局部编辑蒙版；是否支持蒙版、尺寸及透明度的保留/重绘含义，以已选提供方的正式接口为准。保留脸、服饰、表情和道具，仅补缺失轮廓，先审一张母版，再处理同组变体。新图仍须在暗底、亮底和实际对话画面分别检查。不要自动覆盖正式素材。
