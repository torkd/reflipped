package reflipped.shell.common;

import android.app.Activity;
import android.app.Dialog;
import android.graphics.Color;
import android.graphics.Bitmap;
import android.content.Intent;
import android.net.Uri;
import android.webkit.ValueCallback;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.view.KeyEvent;
import android.view.ViewGroup;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;

/**
 * Shows a web page over the game in a full-screen dialog with a close button (the Back key goes back
 * in the page, then closes). Stands in for the Kakao SDK's in-app web views (`KGSUPPORT_SHOW*`).
 * Only http(s) URLs are opened. File fields and download links work through {@link WebFiles}; the Close bar stays
 * clear of the status bar and the page above the keyboard ({@link ShellDialogs#keepClearOfSystemBars}).
 */
public final class WebViewDialog {
    private static Dialog current;

    private WebViewDialog() {
    }

    public static void show(final Activity activity, final String url) {
        show(activity, url, false, true);
    }

    /** Static Reflipped pages: no script/file access, same-origin browsing, normal TLS verification. */
    public static void showServerPage(final Activity activity, final String url) {
        if (!GameWebUrls.sameOrigin(ShellConfig.server(activity), url)) return;
        show(activity, url, true, false);
    }

    /** Independently authenticated admin listener. No game/portal credential is attached to this navigation. */
    public static void showAdminPage(final Activity activity, final String url) {
        if (ServerIdentity.resourceAddress(url) == null) return;
        show(activity, url, true, true);
    }

    /** Lets the server tell the app's web views from a browser, to give its pages the app's look (styling only). */
    static void markApp(WebView web) {
        WebSettings settings = web.getSettings();
        settings.setUserAgentString(settings.getUserAgentString() + " ReflippedApp");
    }

    private static void show(final Activity activity, final String url, final boolean serverPage, final boolean scripts) {
        if (url == null || (serverPage ? !GameWebUrls.sameOrigin(url, url)
                : !(url.startsWith("http://") || url.startsWith("https://")))) return;
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                dismiss();
                final Dialog dialog = new Dialog(activity, android.R.style.Theme_DeviceDefault_NoActionBar);
                final WebView web = new WebView(activity);
                markApp(web);
                web.getSettings().setJavaScriptEnabled(scripts);
                // Without a chrome client a WebView drops JavaScript dialogs and confirm() answers false, so the admin
                // site's "Delete this player?"-style confirmations would silently cancel every such action. It also
                // opens the file picker for file fields (the admin site's "Upload save").
                web.setWebChromeClient(new WebChromeClient() {
                    @Override
                    public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                        return WebFiles.choose(activity, callback, params);
                    }
                });
                // "Download save" links on the admin site and the portal
                web.setDownloadListener((target, agent, disposition, type, length) ->
                        WebFiles.download(activity, url, target, agent, disposition, type));
                web.setBackgroundColor(Color.WHITE);
                if (serverPage) {
                    web.getSettings().setAllowFileAccess(false);
                    web.getSettings().setAllowContentAccess(false);
                    web.getSettings().setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
                    web.setWebViewClient(new WebViewClient() {
                        private boolean navigate(String target, boolean clicked) {
                            if (GameWebUrls.sameOrigin(url, target)) return false;
                            // Only an explicit link click may leave the server, in the system browser. No auth headers.
                            if (clicked && GameWebUrls.externalHttps(target)) {
                                try { activity.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(target))); }
                                catch (android.content.ActivityNotFoundException ignored) { }
                            }
                            return true;
                        }
                        @Override
                        public boolean shouldOverrideUrlLoading(WebView view, String target) {
                            WebView.HitTestResult hit = view.getHitTestResult();
                            return navigate(target, hit != null && hit.getType() == WebView.HitTestResult.SRC_ANCHOR_TYPE);
                        }
                        @Override
                        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                            if (!request.isForMainFrame()) return true;
                            return navigate(request.getUrl().toString(), request.hasGesture());
                        }
                        @Override
                        public void onPageStarted(WebView view, String target, Bitmap icon) {
                            if (!GameWebUrls.sameOrigin(url, target)) view.stopLoading();
                        }
                    });
                } else web.setWebViewClient(new WebViewClient());
                web.loadUrl(url);

                Button close = ShellDialogs.button(activity, "Close", false);
                close.setOnClickListener(new android.view.View.OnClickListener() {
                    @Override
                    public void onClick(android.view.View v) {
                        dialog.dismiss();
                    }
                });
                android.widget.LinearLayout root = new android.widget.LinearLayout(activity);
                root.setOrientation(android.widget.LinearLayout.VERTICAL);
                root.setBackgroundColor(ShellDialogs.SURFACE);
                android.widget.LinearLayout.LayoutParams bar = new android.widget.LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
                int gap = ShellDialogs.dp(activity, 8);
                bar.setMargins(gap, gap, gap, gap);
                root.addView(close, bar);
                root.addView(web, new android.widget.LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                        0, 1));
                dialog.setContentView(root);
                dialog.setOnKeyListener(new Dialog.OnKeyListener() {
                    @Override
                    public boolean onKey(android.content.DialogInterface d, int keyCode, KeyEvent event) {
                        if (keyCode != KeyEvent.KEYCODE_BACK || event.getAction() != KeyEvent.ACTION_UP) return false;
                        if (web.canGoBack()) web.goBack(); else dialog.dismiss();
                        return true;
                    }
                });
                dialog.setOnDismissListener(new android.content.DialogInterface.OnDismissListener() {
                    @Override
                    public void onDismiss(android.content.DialogInterface d) {
                        web.destroy();
                        if (current == dialog) current = null;
                    }
                });
                current = dialog;
                dialog.show();
                if (dialog.getWindow() != null) {
                    dialog.getWindow().setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
                    dialog.getWindow().setSoftInputMode(android.view.WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
                    ShellDialogs.keepClearOfSystemBars(dialog.getWindow(), root);
                }
            }
        });
    }

    private static void dismiss() {
        if (current != null) current.dismiss();
    }
}
