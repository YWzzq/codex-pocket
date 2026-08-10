package cc.cd.dogbot.codexpocket;

import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.CapConfig;
import com.getcapacitor.BridgeActivity;

import org.json.JSONObject;

public class MainActivity extends BridgeActivity {

    private static final int SURFACE_COLOR = Color.rgb(18, 21, 19);

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(ServerConfigPlugin.class);
        super.onCreate(savedInstanceState);
        configureSystemBars();
        configureBackNavigation();
        configureWebView();
    }

    @Override
    protected void load() {
        CapConfig base = CapConfig.loadDefault(this);
        String endpoint = ServerConfigPlugin.getSavedUrl(this);
        if (endpoint == null) endpoint = base.getServerUrl();
        if (endpoint == null) endpoint = ServerConfigPlugin.getDefaultUrl() + "/";

        CapConfig.Builder builder = new CapConfig.Builder(this)
            .setHTML5mode(base.isHTML5Mode())
            .setServerUrl(endpoint)
            .setErrorPath(base.getErrorPath())
            .setHostname(base.getHostname())
            .setStartPath(base.getStartPath())
            .setAndroidScheme(base.getAndroidScheme())
            .setAllowNavigation(new String[] { endpoint })
            .setOverriddenUserAgentString(base.getOverriddenUserAgentString())
            .setAppendedUserAgentString(base.getAppendedUserAgentString())
            .setBackgroundColor(base.getBackgroundColor())
            .setAllowMixedContent(base.isMixedContentAllowed())
            .setCaptureInput(base.isInputCaptured())
            .setUseLegacyBridge(base.isUsingLegacyBridge())
            .setResolveServiceWorkerRequests(base.isResolveServiceWorkerRequests())
            .setWebContentsDebuggingEnabled(base.isWebContentsDebuggingEnabled())
            .setZoomableWebView(base.isZoomableWebView())
            .setLoggingEnabled(base.isLoggingEnabled())
            .setInitialFocus(base.isInitialFocus());
        JSONObject plugins = base.getObject("plugins");
        if (plugins != null) builder.setPluginsConfiguration(plugins);
        config = builder.create();
        super.load();
    }

    private void configureSystemBars() {
        Window window = getWindow();
        window.setStatusBarColor(SURFACE_COLOR);
        window.setNavigationBarColor(SURFACE_COLOR);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.setNavigationBarContrastEnforced(false);
        }

        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, window.getDecorView());
        if (controller != null) {
            controller.setAppearanceLightStatusBars(false);
            controller.setAppearanceLightNavigationBars(false);
        }
    }

    private void configureBackNavigation() {
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (getBridge() != null && getBridge().getWebView().canGoBack()) {
                    getBridge().getWebView().goBack();
                    return;
                }

                setEnabled(false);
                getOnBackPressedDispatcher().onBackPressed();
            }
        });
    }

    private void configureWebView() {
        if (getBridge() == null) return;
        WebView webView = getBridge().getWebView();
        webView.setBackgroundColor(SURFACE_COLOR);
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
    }
}
