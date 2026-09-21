package com.udf.mail;

import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.webkit.CookieManager;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    // Ask Android to protect screenshots, recording and app-switcher previews.
    // This is defense in depth, not protection against a compromised device.
    getWindow().setFlags(
      WindowManager.LayoutParams.FLAG_SECURE,
      WindowManager.LayoutParams.FLAG_SECURE
    );
    super.onCreate(savedInstanceState);
    CookieManager.getInstance().setAcceptThirdPartyCookies(getBridge().getWebView(), false);
    if (Build.VERSION.SDK_INT >= 35) {
      // API 36 enforces edge-to-edge; keep web controls outside bars and the IME.
      WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
      View content = findViewById(android.R.id.content);
      ViewCompat.setOnApplyWindowInsetsListener(content, (view, windowInsets) -> {
        Insets safe = windowInsets.getInsets(
          WindowInsetsCompat.Type.systemBars() |
          WindowInsetsCompat.Type.displayCutout() |
          WindowInsetsCompat.Type.ime()
        );
        view.setPadding(safe.left, safe.top, safe.right, safe.bottom);
        return WindowInsetsCompat.CONSUMED;
      });
      ViewCompat.requestApplyInsets(content);
    }
  }

  @Override
  public void onPause() {
    // Persist the server-issued cookies before Android stops this process.
    CookieManager.getInstance().flush();
    super.onPause();
  }
}
