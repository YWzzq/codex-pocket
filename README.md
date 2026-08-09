# Codex Pocket

Codex Pocket 是一个手机优先的本地 Codex 控制台。手机只负责创建任务、查看进度、继续追问、停止任务和处理审批；实际工作仍由 Mac 上的 Codex、项目文件、登录状态和工具完成。

它不是桌面 Codex 界面的远程镜像。架构如下：

```text
手机浏览器
  -> Tailscale 私有 HTTPS
  -> 本机 Broker（127.0.0.1:8787）
  -> codex app-server（stdio）
  -> 本机 Codex 与项目文件
```

## 当前能力

- 一次性二维码或配对码登录
- 只允许选择预先配置的项目目录
- 创建任务并接收 Codex 流式回复
- 查看命令输出和任务活动
- 在同一任务中继续发送指令
- 停止运行中的任务
- 在手机上批准或拒绝需要确认的操作
- 仅展示由 Codex Pocket 创建的任务
- 在 Mac 本地页面管理已配对的手机和浏览器连接

## 前置条件

- macOS 上已经安装并登录 Codex
- Node.js 22 或更高版本
- 手机和 Mac 登录同一个 Tailscale 网络（远程访问时需要）

确认环境：

```bash
node --version
codex --version
```

如果终端找不到 `codex`，可以在 `.env` 或启动命令中设置：

```bash
CODEX_BIN=/Applications/ChatGPT.app/Contents/Resources/codex
```

## 本机启动

```bash
cd "/absolute/path/to/codex-pocket"
npm install
```

配置允许手机操作的项目目录。多个目录在 macOS 上用冒号分隔：

```bash
export CODEX_POCKET_ROOTS="/absolute/path/to/project-one:/absolute/path/to/project-two"
npm start
```

在 Mac 浏览器打开 [http://127.0.0.1:8787](http://127.0.0.1:8787)。页面会显示五分钟有效的一次性配对二维码和配对码。

也可以复制示例配置：

```bash
cp .env.example .env
```

当前版本不自动读取 `.env`，使用 `.env` 时先加载它：

```bash
set -a
source .env
set +a
npm start
```

## 手机远程访问：Cloudflare Tunnel（当前方案）

校园网环境优先使用 Cloudflare Tunnel。Mac 通过出站 HTTPS 连接 Cloudflare，手机不需要安装 VPN，也不需要校园网提供公网入口。

前提是你的域名已经托管在 Cloudflare，并且域名状态显示为 `Active`。本机已经安装并配置了 `cloudflared`，配置文件默认位于 `~/.cloudflared/config.yml`，内容只把你的子域名转发到 `127.0.0.1:8787`。

首次配置或更换账号时：

```bash
cloudflared tunnel login
cloudflared tunnel create codex-pocket
cloudflared tunnel route dns codex-pocket codex.dogbot.cc.cd
cloudflared tunnel ingress validate
```

启动 Codex Pocket 时必须使用公网 HTTPS 地址：

```bash
export PUBLIC_URL="https://codex.dogbot.cc.cd"
export CODEX_POCKET_ROOTS="/absolute/path/to/project-one:/absolute/path/to/project-two"
npm start
```

Tunnel 作为当前用户的 LaunchAgent 运行：

```bash
launchctl print gui/$(id -u)/com.codex-pocket.cloudflared
tail -f ~/.cloudflared/codex-pocket.log
```

验证手机入口：

```bash
curl https://codex.dogbot.cc.cd/api/health
```

建议在 Cloudflare Zero Trust 中为 `codex.dogbot.cc.cd` 增加 Access 应用，只允许你的邮箱通过一次性验证码登录。Access 配置完成后，手机打开 `https://codex.dogbot.cc.cd`，再输入 Mac 页面显示的一次性配对码。

## 连接管理

在 Mac 本地页面顶部点击“连接管理”，可以查看每个已配对浏览器的设备类型、创建时间和最近活动时间。电脑端可以单独断开某个手机，也可以“断开其他全部”；当前管理页面所在的 Mac 会话默认不会被误断开。

连接管理接口只接受来自回环地址的请求，手机和公网入口不能调用它。断开连接会删除会话并关闭对应的实时 WebSocket，手机会立即回到配对页面。服务重启时内存中的会话也会全部失效，需要重新配对。

## 手机远程访问：Tailscale（备选）

不要把 `8787` 端口或 `codex app-server` 直接暴露到公网，也不要使用 Tailscale Funnel。推荐用 Tailscale Serve 提供仅 tailnet 内可访问的 HTTPS 入口。

1. 在 Mac 和手机上安装 Tailscale，并登录同一个账号或 tailnet。
2. 在 Mac 上启动 Tailscale：

```bash
brew install tailscale
sudo brew services start tailscale
sudo tailscale up
```

3. 查看 Mac 的 Tailscale DNS 名称：

```bash
tailscale status
```

4. 使用该名称设置公开地址并启动 Broker。下面的地址只是示例：

```bash
export PUBLIC_URL="https://your-mac.your-tailnet.ts.net"
export CODEX_POCKET_ROOTS="/absolute/path/to/project-one:/absolute/path/to/project-two"
npm start
```

5. 新开一个终端，把私有 HTTPS 转发到本机 Broker：

```bash
tailscale serve --bg --https=443 http://127.0.0.1:8787
tailscale serve status
```

6. 回到 Mac 上的 `http://127.0.0.1:8787`，用手机扫描新的二维码。二维码必须包含上面配置的 `https://...ts.net` 地址。

手机丢失或不再使用时，在手机页面点击断开，并在 Tailscale 管理后台撤销该设备。

## 配置项

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Broker 监听地址；程序会拒绝非回环地址 |
| `PORT` | `8787` | Broker 本机端口 |
| `PUBLIC_URL` | 本机地址 | 手机扫描二维码后访问的 HTTPS 地址 |
| `CODEX_POCKET_ROOTS` | 当前目录 | 手机可选择的绝对项目目录列表 |
| `CODEX_BIN` | `codex` | Codex 可执行文件路径 |

修改配置后需要重启服务。重启会撤销当前浏览器会话，需要重新配对；任务记录仍保存在 `.codex-pocket/threads.json`。

## 安全边界

- Broker 强制监听回环地址，手机不能直接连接 app-server。
- 浏览器不能发送原始 JSON-RPC，也不能改变 sandbox、审批策略或工作目录。
- 每个任务固定使用 `workspaceWrite`，可写目录仅为所选项目，默认禁用网络。
- 会话使用 `HttpOnly`、`SameSite=Strict` cookie；配对邀请五分钟过期且成功后立即失效。
- WebSocket 与修改类 HTTP 请求都会校验会话和 `Origin`。
- 第一版不提供永久批准，只允许单次批准、拒绝或停止任务。

官方协议参考：[Codex App Server](https://learn.chatgpt.com/docs/app-server)。官方现成方案参考：[Codex Remote](https://learn.chatgpt.com/docs/remote)。

## 检查与排错

运行静态检查：

```bash
npm run check
npm audit
```

健康检查：

```bash
curl http://127.0.0.1:8787/api/health
```

常见问题：

- 页面显示 Codex 未连接：确认 `codex --version` 可运行，或设置正确的 `CODEX_BIN`。
- 手机打不开页面：确认手机已连接同一 tailnet，并检查 `tailscale serve status`。
- 二维码仍是 `127.0.0.1`：启动前没有设置正确的 `PUBLIC_URL`。
- 项目没有出现：确认路径是绝对目录、确实存在，并在启动前设置 `CODEX_POCKET_ROOTS`。
- 重启后要求重新配对：这是预期行为，当前会话只保存在 Broker 内存中。
