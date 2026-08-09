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
- 在手机端选择可用模型、推理强度和速度档位
- 查看命令输出和任务活动
- 在同一任务中继续发送指令
- 停止运行中的任务
- 在手机上批准或拒绝需要确认的操作
- 加载允许项目中的 Codex 历史任务，并显示进行中、等待批准、已完成等状态
- 在 Mac 本地页面管理已授权的手机和浏览器设备

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

在 Mac 浏览器打开 [http://127.0.0.1:8787](http://127.0.0.1:8787)。本机浏览器会自动建立本机授权，不需要输入配对码；页面中的“手机配对”按钮用于生成手机的一次性二维码和配对码。首次手机配对成功后，手机会获得一个长期设备授权；之后只要电脑服务和公网入口在线，就不需要重复输入配对码。

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

在 Mac 本地页面顶部点击“连接管理”，可以查看每个已授权设备的设备类型、在线状态、创建时间和最近活动时间。电脑端可以单独撤销某个设备，也可以“撤销其他全部”；当前管理页面所在的 Mac 会话默认不会被误撤销。

连接管理接口只接受来自回环地址的请求，手机和公网入口不能调用它。撤销授权会使设备令牌失效、关闭对应的实时 WebSocket，手机会立即回到配对页面。授权记录保存在 `.codex-pocket/devices.json`，服务重启后仍然有效；文件只保存令牌哈希，并且权限限制为当前用户可读写。

历史任务会从本机 Codex app-server 的 `thread/list` 同步，只保留 `CODEX_POCKET_ROOTS` 允许目录及其子目录中的线程。打开手机工作区或刷新页面时会重新同步；点击历史任务后可以读取完整对话，并继续发送消息。任务状态会通过 app-server 事件实时更新。

在 Mac 工作区顶部点击“项目管理”，候选项目来自 Codex app-server 的历史线程，会按项目工作目录聚合并显示历史对话数量。勾选或取消项目后保存，配置会写入本机 `.env`，项目和历史任务会立即刷新；项目管理接口只接受回环地址，且只接受真实存在的 Codex 项目工作目录，至少保留一个项目。手机端不能修改允许项目。

## 模型设置

工作区中的“模型设置”会读取当前 Mac 上 Codex app-server 返回的可用模型。可以选择模型、推理强度和服务速度档位；设置只对新建任务生效，继续已有任务会沿用该任务创建时的设置。服务端会再次校验模型和选项，手机不能提交本机未提供的模型。

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

手机丢失或不再使用时，在 Mac 的“连接管理”中撤销对应设备授权；如果使用 Tailscale，也可以同时在 Tailscale 管理后台撤销该设备。

## 配置项

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Broker 监听地址；程序会拒绝非回环地址 |
| `PORT` | `8787` | Broker 本机端口 |
| `PUBLIC_URL` | 本机地址 | 手机扫描二维码后访问的 HTTPS 地址 |
| `CODEX_POCKET_ROOTS` | 当前目录 | 手机可选择的绝对项目目录列表 |
| `CODEX_BIN` | `codex` | Codex 可执行文件路径 |

修改配置后需要重启服务。已授权设备可以在重启后继续使用；任务记录仍保存在 `.codex-pocket/threads.json`。

## 安全边界

- Broker 强制监听回环地址，手机不能直接连接 app-server。
- 浏览器不能发送原始 JSON-RPC，也不能改变 sandbox、审批策略或工作目录。
- 每个任务固定使用 `workspaceWrite`，可写目录仅为所选项目，默认禁用网络。
- 设备令牌使用随机高熵值，只在 `.codex-pocket/devices.json` 中保存 SHA-256 哈希；浏览器使用 `HttpOnly`、`SameSite=Strict` cookie，HTTPS 下自动启用 `Secure`。
- 配对邀请五分钟过期且成功后立即失效；配对接口有限流，设备授权可以在 Mac 本地页面撤销。
- 只有回环地址上的 Mac 浏览器可以调用本机自动授权接口；公网手机仍必须通过一次性配对流程。
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
- 重启后仍可访问：设备授权持久化在 `.codex-pocket/devices.json`；如果删除该文件，所有长期授权都会失效并需要重新配对。
