package com.udf.party;

import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    // High-security requirement: block screenshots, screen recording, screen
    // mirroring/casting and the recent-apps thumbnail for the whole app, so
    // member PII and ward data can never be captured from the device.
    //
    // FLAG_SECURE must be set before the window's content view is created
    // (i.e. before super.onCreate()), otherwise it does not take effect.
    getWindow().setFlags(
      WindowManager.LayoutParams.FLAG_SECURE,
      WindowManager.LayoutParams.FLAG_SECURE
    );
    super.onCreate(savedInstanceState);
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
}
