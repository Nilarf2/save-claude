# 本地发布产物

`build-release.py` 只准备 offline、Toy 和 VibeHub 的本地静态目录与 ZIP，不上传、不改变审核状态。先执行仓库 README 中的构建与检查，确保浏览器引擎 bundle 与锁定 General Engine Narrative tarball 一致，再使用新的输出目录：

```sh
python3 tools/release/build-release.py --out-dir ../release/1.1.0 --version 1.1.0 --check-only
python3 tools/release/build-release.py --out-dir ../release/1.1.0 --version 1.1.0
python3 -m unittest discover -s tests/release -v
```

输出目录已存在时拒绝覆盖。`--check-only` 核对输入及指纹准备，不写包；完整构建还会核对产物中的入口引用。三个包都保留引擎来源与许可证。

## 指纹与资源映射

运行时 JS、CSS、剧情与角色 JSON、图片、音频、字体按最终字节的 SHA-256 前 16 位命名，例如 `engine-runtime.0123456789abcdef.js`。发布版本、日期和平台名不参与指纹；相同内容跨发布版本保持同名。

引擎使用外部 ESM bundle，不依赖内联 import map。构建按“引擎 → 游戏 → 启动器”顺序改写依赖并计算指纹；入口 HTML、CSS 字体引用和离线 `portraits.html` 的图片引用也会同步改写。运行代码放在普通文件路径，避免上传器跳过嵌套 `dist/` 造成缺模块。

剧情和角色 JSON 内保留作者使用的逻辑资源路径。发布器向入口注入惰性的 `release-assets` JSON 数据块；游戏的统一 resolver 将背景、立绘、BGM、动态音效及剧情读取转换为内容文件名。源码开发入口没有映射时沿用原路径。不要只改发布目录或绕过 resolver 拼接新的资源 URL。

OFL、字体说明和其他许可证保持可读文件名及原文；素材授权不会因指纹改名而改变。发布媒体、说明文档和启动脚本属于交付附件，不属于运行资源指纹范围。

## 核对清单

每个平台目录中的 `release-manifest.json` 以逻辑名列出实际路径、字节数、完整 SHA-256 和是否改名，覆盖包内除清单自身以外的文件。它不包含构建机绝对路径。`release.json` 指向此清单；根目录 `package-result.json` 仍标记 `prepared_not_published`。

定向回归验证跨发布版本稳定命名、单文件变化的依赖范围、不变大图保留原指纹、清单覆盖、HTML/JS/CSS 和映射目标存在、离线立绘引用及许可证保留。静态检查不会穷举所有动态剧情路径，生成包仍须通过实际浏览器开局、音频与立绘验收。

上传成功不等于可玩。应打开实际托管入口，核对模块 HTTP 状态、JavaScript MIME 与响应内容，检查无 import-map CSP 错误；在冷缓存和慢网下开局，确认失败提示、重试及迟到图片恢复。字体、背景、立绘、BGM、动态音效和离线立绘页分别抽查。

内容指纹只保证文件名与内容稳定，不保证平台响应头、浏览器存储或跨平台的永久缓存。平台支持跨版本复用时，未改动的大资源可以复用；应记录真实 URL、缓存响应头及复访请求来确认。技术上线与内容审核分别记录，准备或更新预览不代表通过内容审核。
