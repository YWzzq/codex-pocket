# Codex Pocket Android App

这是独立的 Capacitor Android 工程，不修改根目录的网页和 Codex 服务端。

生产 App 默认打开 `https://codex.dogbot.cc.cd`，电脑端 Codex Pocket 和 Cloudflare Tunnel 需要在线。后续可以在这个目录逐步加入原生通知、文件选择和 Android 页面，而不影响现有网页版本。

## 构建

```bash
npm install
npm run sync
JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home npm run build:debug
```

Debug APK 位于 `android/app/build/outputs/apk/debug/app-debug.apk`。

当前原生层已处理深色系统状态栏、导航栏，以及 Android 返回键：有网页历史时返回上一页，没有历史时退出 App。Android App 还接入了本地通知插件；在设置页点击“开启通知”后，任务完成、失败或等待批准时会使用系统通知。
