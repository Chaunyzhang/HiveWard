# HiveWard 正式版发布

版本号以根 `package.json` 为准，`hiveward/package.json` 保持一致。首版为 `1.0.0`，GitHub Release tag 使用 `v1.0.0`，仓库固定为 `Chaunyzhang/HiveWard`。Release 不勾选 prerelease，不使用 HiveWard 的历史 tag、渠道仓库或发布文件。

## Mac arm64

正式发版运行 `pnpm build:mac:release`，会先编译网页和桌面代码。只有两者已在当前源码上完成编译时，才单独运行 `pnpm build:mac:hiveward` 生成签名包和上传文件。不要只运行旧的 `electron-builder --dir` 命令。

脚本先用 electron-builder 生成目录包（`--publish never`），再执行本地签名脚本（同步签名改写的部署模板哈希后才封装外层 App），最后从已签名的 App 生成 ZIP 和 SHA-512 清单。不要在生成 ZIP 后再改 App 或重签 App。

上传到同一个正式 Release：

- `dist/HiveWard-1.0.0-mac-arm64.zip`
- `dist/latest-mac.yml`

命名规则为 `HiveWard-<版本>-mac-<架构>.zip`。可额外提供 DMG 给首次安装，但更新使用 ZIP。添加 x64 时需要合并同一份 `latest-mac.yml` 的 `files`，包含各架构 ZIP 的正确 SHA-512 和大小。

Mac 当前使用 ad-hoc 签名，不依赖 Squirrel.Mac 安装更新。HiveWard 下载并校验清单后，在老板确认重启时执行独立替换脚本。App 须放在 `/Applications/HiveWard.app`，当前用户需要有替换权限；失败应保留旧包与安装日志。实际安装验收须在专用机器或独立测试环境完成。

## Windows x64

构建命令保留 `--publish never`，使用无签名 NSIS 安装器。上传 builder 生成的：

- `HiveWard-1.0.0-windows-x64-setup.exe`
- `latest.yml`
- 对应安装器的 `.blockmap`（如果生成）

Windows ZIP 可供手工下载，自动更新使用 NSIS 安装器。无签名安装器可能触发 SmartScreen 或系统安全提示；不再依赖 SignPath 发布者身份。

## 上传前

同一个 Release 的 tag、应用版本、清单版本和文件名必须一致。先上传全部文件再发布正式 Release，更新说明使用 Release 正文。不要仅上传 App 目录或只有 ZIP 而没有更新清单。本仓脚本不自动上传、不打标签、不发布 Release。
