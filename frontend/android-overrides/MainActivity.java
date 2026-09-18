package com.udf.party;

import android.os.Bundle;
import android.view.WindowManager;
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
  }
}
