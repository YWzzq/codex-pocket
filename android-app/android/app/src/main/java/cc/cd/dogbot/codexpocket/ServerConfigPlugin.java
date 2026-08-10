package cc.cd.dogbot.codexpocket;

import android.app.Activity;
import android.content.Context;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.PluginMethod;

import java.util.Locale;

@CapacitorPlugin(name = "ServerConfig")
public class ServerConfigPlugin extends Plugin {

    private static final String PREFS_NAME = "codex-pocket-server";
    private static final String URL_KEY = "url";
    private static final String PENDING_START_PATH_KEY = "pending-start-path";
    private static final String DEFAULT_URL = "https://codex.dogbot.cc.cd";

    static String getDefaultUrl() {
        return DEFAULT_URL;
    }

    static String getSavedUrl(Context context) {
        return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).getString(URL_KEY, null);
    }

    static String consumePendingStartPath(Context context) {
        android.content.SharedPreferences preferences = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        String path = preferences.getString(PENDING_START_PATH_KEY, null);
        if (path != null) preferences.edit().remove(PENDING_START_PATH_KEY).apply();
        return path;
    }

    static String normalizeUrl(String raw) {
        if (raw == null) throw new IllegalArgumentException("请输入服务器地址");
        String value = raw.trim();
        Uri uri = Uri.parse(value);
        String host = uri.getHost();
        if (!"https".equalsIgnoreCase(uri.getScheme())) throw new IllegalArgumentException("服务器地址必须使用 HTTPS");
        if (host == null || host.isBlank()) throw new IllegalArgumentException("服务器地址无效");
        if (uri.getPort() != -1 && uri.getPort() != 443) throw new IllegalArgumentException("只允许 HTTPS 默认端口");
        if (uri.getPath() != null && !uri.getPath().isEmpty() && !"/".equals(uri.getPath())) {
            throw new IllegalArgumentException("服务器地址不能包含路径");
        }
        if (uri.getQuery() != null || uri.getFragment() != null || value.contains("@")) {
            throw new IllegalArgumentException("服务器地址不能包含参数或账号信息");
        }
        String lowerHost = host.toLowerCase(Locale.ROOT);
        if ("localhost".equals(lowerHost) || lowerHost.endsWith(".local") || isIpv4Address(lowerHost) || lowerHost.contains(":")) {
            throw new IllegalArgumentException("不能连接本机或局域网地址，请使用 HTTPS 域名");
        }
        return "https://" + lowerHost + "/";
    }

    private static boolean isIpv4Address(String value) {
        return value.matches("[0-9.]+") && value.matches("(?:[0-9]{1,3}\\.){3}[0-9]{1,3}");
    }

    @PluginMethod
    public void get(PluginCall call) {
        String url = getSavedUrl(getContext());
        if (url == null) url = DEFAULT_URL + "/";
        JSObject result = new JSObject();
        result.put("url", url);
        call.resolve(result);
    }

    @PluginMethod
    public void set(PluginCall call) {
        final String normalized;
        final String pendingStartPath;
        try {
            normalized = normalizeUrl(call.getString("url"));
            pendingStartPath = normalizePairPath(normalized, call.getString("pairUrl"));
        } catch (IllegalArgumentException error) {
            call.reject(error.getMessage());
            return;
        }

        android.content.SharedPreferences.Editor editor = getContext()
            .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString(URL_KEY, normalized);
        if (pendingStartPath != null) editor.putString(PENDING_START_PATH_KEY, pendingStartPath);
        editor.apply();

        JSObject result = new JSObject();
        result.put("url", normalized);
        result.put("restarting", true);
        call.resolve(result);

        Activity activity = getActivity();
        if (activity != null) {
            new Handler(Looper.getMainLooper()).postDelayed(activity::recreate, 180);
        }
    }

    private static String normalizePairPath(String serverUrl, String rawPairUrl) {
        if (rawPairUrl == null || rawPairUrl.isBlank()) return null;
        Uri server = Uri.parse(serverUrl);
        Uri pair = Uri.parse(rawPairUrl.trim());
        String pairToken = pair.getQueryParameter("pair");
        if (!"https".equalsIgnoreCase(pair.getScheme()) || pair.getHost() == null
            || !server.getHost().equalsIgnoreCase(pair.getHost())
            || (pair.getPort() != -1 && pair.getPort() != 443)
            || pair.getUserInfo() != null || pair.getFragment() != null
            || (pair.getPath() != null && !pair.getPath().isEmpty() && !"/".equals(pair.getPath()))
            || pairToken == null || pairToken.isBlank()) {
            throw new IllegalArgumentException("二维码不是有效的 HTTPS 配对链接");
        }
        String query = pair.getEncodedQuery();
        return query == null || query.isEmpty() ? "" : "?" + query;
    }

    @PluginMethod
    public void reset(PluginCall call) {
        getContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit()
            .remove(URL_KEY)
            .remove(PENDING_START_PATH_KEY)
            .apply();
        call.resolve();
        Activity activity = getActivity();
        if (activity != null) {
            new Handler(Looper.getMainLooper()).postDelayed(activity::recreate, 180);
        }
    }
}
