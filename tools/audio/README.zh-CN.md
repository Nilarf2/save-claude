# 配音制作

`generate-voice-design.mjs` 从已编译的 `web/story.json` 读取角色对白，生成稳定的配音 manifest。角色的固定 Voice Design 描述保存在同目录的 `voice-design.json`，每句只增加剧本中的表情提示，避免同一角色逐句漂移。默认只处理有 `speaker` 的对白；旁白和动作可用 `--narration`、`--actions` 显式加入。

先生成计划，不会调用远程模型：

```sh
npm run voice:plan
```

生成实际 WAV 前明确使用。请用环境变量或参数配置 Tailscale SSH 主机、远端 Python 环境和模型目录；命令只在该远端本地模型上生成，不使用 VibeHub 额度：

```sh
export TTS_SSH_CONFIG=/path/to/ssh/config
export TTS_SSH_HOST=your-tts-host
export TTS_REMOTE_PYTHON='C:/path/to/venv/Scripts/python.exe'
export TTS_MODEL_PATH='C:/path/to/Qwen3-TTS-12Hz-1.7B-VoiceDesign'
npm run voice:generate -- --only Claude --per-speaker 2
```

输出默认放在 `web/assets/voice/`，可播放清单写入 `web/voice-assets.json`，任务 manifest 写入 `tmp/voice-design/manifest.json`。游戏设置中的“角色配音”默认开启，可关闭或调音量；按对白逐句播放，自动模式会等待当前语音播完。发布构建会校验并收录 WAV。

远端不可用时，计划仍会生成；失败项会写入 manifest，命令以非零状态结束。失败默认不自动重试，只有显式加入 `--retry-failures --retries N` 才会重试。

重新生成大批次前先试听少量主角台词，确认中文咬字、音色稳定性和情绪，再按角色或章节分批运行 `--only`、`--limit`。`--force` 才会覆盖已有 WAV。不要把访问令牌或本地请求日志写入仓库。

## 风格参考

- [调出带情绪节奏的 AI 配音](https://www.bilibili.com/video/BV1oRhAzcEP3/)
- [AI 短剧配音与剧情匹配](https://www.bilibili.com/video/BV1yxgH6cEwB/)
- [DeepSeek 少女感音色示例](https://www.bilibili.com/video/BV1c7eE6VEMD/)

目前只确认这些页面和标题，未取得字幕或实际试听结论；游戏音色提示按角色关系、台词和剧本表情设计，后续可人工试听并据此微调。
