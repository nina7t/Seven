package com.sevenz.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final String CHANNEL_ID = "SevenzAudioChannel";
    private static final int NOTIFICATION_ID = 1;
    private PowerManager.WakeLock wakeLock;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        createNotificationChannel();
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "Sevenz Audio",
                NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("Audio playback controls");
            channel.setShowBadge(false);
            
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }
    }

    @Override
    public void onResume() {
        super.onResume();
        // Release wake lock when app is in foreground
        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
        }
    }

    @Override
    public void onPause() {
        super.onPause();
        // Acquire wake lock to keep audio playing when app is in background
        PowerManager powerManager = (PowerManager) getSystemService(POWER_SERVICE);
        if (powerManager != null) {
            wakeLock = powerManager.newWakeLock(
                PowerManager.PARTIAL_WAKE_LOCK,
                "Sevenz:AudioWakeLock"
            );
            if (!wakeLock.isHeld()) {
                wakeLock.acquire(10 * 60 * 60 * 1000L); // 10 hours max
            }
        }
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
        }
    }
}