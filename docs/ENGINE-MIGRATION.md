# General Engine Consumer

本游戏从旧的 Text Adventure Engine 受控快照迁移为 [General Engine](https://github.com/Nilarf2/general-engine) 的 Narrative 消费者。

- 运行时入口：`@general-engine/engine/narrative`
- 包文件：`vendor/general-engine-narrative.tgz`
- 来源、commit、版本和 SHA-256：`vendor/general-engine/PROVENANCE.json`
- MIT 许可证和上游适配声明：`vendor/general-engine/`

游戏保留自己的 screenplay 编译器、舞台/立绘表现层、浏览器 UI、发布脚本和 `saveclaude:<content-version>:` 存档命名空间。Narrative session 负责 JSON 剧情图、确定性 dispatch 和快照验证；`web/game.js` 仅通过 `createNarrativeWebAdapter` 接收场景/音频效果，再交给现有表现代码。

## 更新包

在 General Engine 独立检出目录完成干净提交、`npm ci` 和 `npm run build:engine` 后运行：

```sh
node tools/sync-general-engine.mjs --source /absolute/path/to/general-engine
npm ci --ignore-scripts
npm run build
npm run check
```

同步脚本只写入 Narrative 公共入口的 tarball、provenance 和锁文件；不会把源检出绝对路径或整个通用引擎复制进本仓库。迁移兼容测试允许现有 1.1.0 快照中的旧引擎头 `0.1.0` 转换为 Narrative `1.0.0`，仍由 General Engine 校验内容版本、节点游标、变量、标签、访问计数和随机状态。
