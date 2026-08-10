# Codex Pocket

Codex Pocket 是一个手机优先的本地 Codex 控制台：

```text
手机浏览器 / App
  -> HTTPS（Cloudflare Tunnel）
  -> 电脑上的 Codex Pocket（127.0.0.1:8787）
  -> Codex app-server
  -> 本机 Codex 与项目文件
```

手机只负责发起任务、查看进度、继续对话、停止任务和处理审批；实际代码工作始终在电脑端完成。

## 功能

- 创建、继续、停止 Codex 任务，实时查看输出
- 按项目查看历史对话和任务状态
- 选择模型、推理强度和速度档位
- 手机审批命令，电脑端管理设备授权和允许的项目
- macOS、Windows 启动脚本，以及 Android App 工程

## 环境要求

- macOS 或 Windows
- 已安装并登录 Codex
- Node.js 22+
- 远程访问时需要 Cloudflare Tunnel 或其他 HTTPS 网关

检查：

```bash
node --version
codex --version
```

## 快速开始

```bash
git clone https://github.com/YWzzq/codex-pocket.git
cd codex-pocket
npm install
npm start
```

然后在电脑浏览器打开：

- 工作区：<http://127.0.0.1:8787>
- 部署向导：<http://127.0.0.1:8787/setup>

部署向导会依次完成环境检查、填写公网地址和 Codex 路径、选择项目、检查 Tunnel、生成手机配对二维码。配置写入本机 .env，不会上传。

### 配置项目

也可以手动复制配置模板：

```bash
cp .env.example .env
```

最常用配置：

```dotenv
HOST=127.0.0.1
PORT=8787
PUBLIC_URL=https://your-domain.example
CODEX_POCKET_ROOTS=/absolute/path/project-one:/absolute/path/project-two
CODEX_BIN=codex
```

`CODEX_BIN` 找不到时，填写 Codex 可执行文件的完整路径。修改配置后需要重启服务。

## macOS

临时开发运行：

```bash
npm run dev
```

注册为登录后自动启动的 LaunchAgent：

```bash
npm run macos:start
npm run macos:status
npm run macos:stop
npm run macos:uninstall
```

向导中的“自动配置 Mac 后台服务”也可以生成 LaunchAgent 配置。启动后台服务前，先停止当前终端里的 `npm run dev` 或 `npm start`。

## Windows

PowerShell 启动：

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
.\start-windows.ps1
```

也可以双击 `start-windows.bat`。脚本会读取 `.env`、检查 Node.js/Codex，并在首次运行时安装依赖。

在 `/setup` 中选择或自动识别 Windows，点击“自动配置 Windows 后台任务”，然后关闭当前 PowerShell 窗口：

```powershell
.\scripts\windows-service.ps1 start
```

管理任务：

```powershell
.\scripts\windows-service.ps1 status
.\scripts\windows-service.ps1 stop
.\scripts\windows-service.ps1 uninstall
```

## 手机远程访问

推荐使用 Cloudflare Tunnel，校园网不需要开放入站端口。

前提：域名已托管到 Cloudflare，且 `cloudflared` 已安装。首次配置：

```bash
cloudflared tunnel login
cloudflared tunnel create codex-pocket
cloudflared tunnel route dns codex-pocket your-subdomain.example
cloudflared tunnel ingress validate
```

Tunnel 的转发目标应为：

```text
http://127.0.0.1:8787
```

启动服务时，`PUBLIC_URL` 必须是手机能访问的 HTTPS 地址。电脑端打开 `/setup`，生成二维码后用手机扫描并完成一次性配对。配对成功后，手机获得长期设备授权；电脑服务和 Tunnel 在线时不需要重复配对。

建议在 Cloudflare Zero Trust 中为子域名增加 Access，只允许自己的邮箱登录。

Tailscale 可作为备选，但手机和电脑需要登录同一个 tailnet，并使用 Tailscale Serve。

## Android App

`android-app/` 是隔离的 Capacitor Android 工程，仍连接电脑上的 Codex Pocket，不在手机上运行 Codex。它支持扫码配对、可配置服务器地址、返回键和本地通知。

项目也保留了 TWA/Bubblewrap 构建文件；构建 Android 包需要 Java 17、Android SDK 和 Bubblewrap。

## 安全边界

- 服务始终只监听 `127.0.0.1`，不直接暴露 Codex app-server
- 手机只能访问电脑端勾选的项目目录
- 配对码五分钟过期，设备可在电脑端撤销
- 设备文件只保存令牌哈希，修改请求校验会话和 `Origin`
- 生产远程访问应使用 HTTPS，并为 Cloudflare Access 设置登录保护

## 检查与排错

```bash
npm run check
npm audit
curl http://127.0.0.1:8787/api/health
```

- Codex 未连接：确认 `codex --version` 可用，或检查 `CODEX_BIN`
- 手机打不开：确认 HTTPS 地址、Tunnel 状态和 Cloudflare Access
- 二维码是 `127.0.0.1`：检查 `PUBLIC_URL`
- 项目未出现：确认 `CODEX_POCKET_ROOTS` 是存在的绝对路径
- 重启后无需重新配对：授权保存在 `.codex-pocket/devices.json`

修改代码后，开发模式会自动重载；LaunchAgent/Windows 后台任务需要重启对应服务。

## 许可证与参考

本项目用于个人使用。协议参考：[Codex App Server](https://learn.chatgpt.com/docs/app-server)。
