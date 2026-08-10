# Codex Pocket Android App

这是独立的 Capacitor Android 工程，不修改根目录的网页和 Codex 服务端。

生产 App 默认打开 `https://codex.dogbot.cc.cd`，电脑端 Codex Pocket 和 Cloudflare Tunnel 需要在线。配对页提供“扫一扫连接”，扫描电脑端生成的 HTTPS 配对二维码后会自动打开链接并完成授权；也可以继续手动输入配对码。

在 Android App 的“设置”页可以修改服务器地址。地址只接受 HTTPS 域名，不接受本机/IP、路径、查询参数或账号信息；保存后 App 会重启并连接新地址。服务器必须同时提供 Codex Pocket 网页、API 和 WebSocket。

## 构建

```bash
npm install
npm run sync
JAVA_HOME=/Library/Java/JavaVirtualMachines/jdk-21.jdk/Contents/Home npm run build:debug
```

Debug APK 位于 `android/app/build/outputs/apk/debug/app-debug.apk`。

当前原生层已处理深色系统状态栏、导航栏，以及 Android 返回键：有网页历史时返回上一页，没有历史时退出 App。Android App 还接入了本地通知和二维码扫描插件；在设置页点击“开启通知”后，任务完成、失败或等待批准时会使用系统通知。扫码功能需要 Android 6.0（API 26）或更高版本，并会在首次使用时请求相机权限。
