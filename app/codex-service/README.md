# 有序图库 AI 中转服务

[下载当前安装包](https://github.com/dteer/lumaindex-extensions/releases/download/codex-v1.0.0/LumaIndex-Codex-Service.zip) · [SHA-256 校验文件](https://github.com/dteer/lumaindex-extensions/releases/download/codex-v1.0.0/LumaIndex-Codex-Service.zip.sha256)

仅适用于 macOS 14 或更新版本，Apple 芯片。独立运行，不包含 Codex，不保存或复制登录凭据。

1. 从 OpenAI 官方安装 Codex CLI：https://developers.openai.com/codex/cli ，在终端执行 `codex login` 完成登录。
2. 解压，把“图库 AI 中转服务.app”拖到“应用程序”。
3. 打开该程序，在菜单栏“图库 AI”中点击“启动服务”。
4. 在有序图库的 AI 设置中检查连接，再按需测试 AI。

服务仅监听本机 127.0.0.1:4500。端口被占用时不会终止其他程序。菜单中的运行状态只表示进程存活，账号与隔离检查以图库结果为准。

图库退出不会停止独立服务；不再使用时从菜单栏选择“停止服务”或“退出”。服务不设置开机启动。只停止自己启动的 Codex 进程，不退出 Codex 账号。

当前下载包如果未经过 Developer ID 签名和公证，macOS 可能阻止首次打开。确认从官方仓库获取后，在系统设置 → 隐私与安全性中按系统提示允许打开；不要关闭系统安全机制。正式公证状态以下载页面说明为准。

卸载：先从菜单栏退出，将应用移到废纸篓。可选删除 `~/Library/Application Support/LumaIndex-Codex` 专用工作目录；不要删除 `~/.codex`，它属于用户的 Codex 安装。

网络：中转服务启动时继承 macOS 手动 HTTP/HTTPS 代理，已有代理环境变量优先。修改系统代理后停止并重新启动服务即可。PAC 自动代理暂不解析；本机连接默认绕过代理。

## 当前发布状态

版本 1.0.0。当前包使用 ad-hoc 签名，尚未进行 Developer ID 公证。安装包不包含 Codex 或任何账号凭据。

## 版本与源码

[版本索引](versions/README.md)。此目录目前仅维护发行说明，尚未迁入服务源码。安装包通过 GitHub Release 分发。
