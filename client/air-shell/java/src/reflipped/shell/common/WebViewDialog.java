package reflipped.shell.common;

import android.app.Activity;
import android.app.Dialog;
import android.graphics.Color;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;

/**
 * Shows a web page over the game in a full-screen dialog with a close button (the Back key goes back
 * in the page, then closes). Stands in for the Kakao SDK's in-app web views (`KGSUPPORT_SHOW*`).
 * Only http(s) URLs are opened.
 */
public final class WebViewDialog {
    private static Dialog current;

    private WebViewDialog() {
    }

    public static void show(final Activity activity, final String url) {
        if (url == null || !(url.startsWith("http://") || url.startsWith("https://"))) return;
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                dismiss();
                final Dialog dialog = new Dialog(activity, android.R.style.Theme_Black_NoTitleBar_Fullscreen);
                final WebView web = new WebView(activity);
                web.getSettings().setJavaScriptEnabled(true);
                web.setBackgroundColor(Color.WHITE);
                web.setWebViewClient(new WebViewClient());
                web.loadUrl(url);

                Button close = new Button(activity);
                close.setText("Close");
                close.setOnClickListener(new android.view.View.OnClickListener() {
                    @Override
                    public void onClick(android.view.View v) {
                        dialog.dismiss();
                    }
                });
                FrameLayout root = new FrameLayout(activity);
                root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.MATCH_PARENT));
                root.addView(close, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP | Gravity.END));
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
            }
        });
    }

    private static void dismiss() {
        if (current != null) current.dismiss();
    }
}
