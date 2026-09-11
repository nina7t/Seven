package com.sevenz.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;
import com.sevenz.app.plugin.AudioPlayerPlugin;

public class MainActivity extends BridgeActivity {
    private static final String CHANNEL_ID = "SevenzAudioChannel";
    private static final int NOTIFICATION_ID = 1;
    private static final int NOTIFICATION_PERMISSION_REQUEST_CODE = 100;
    private PowerManager.WakeLock wakeLock;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Register plugins BEFORE super.onCreate so the bridge picks them up
        // when the WebView initializes.
        registerPlugin(AudioPlayerPlugin.class);
        super.onCreate(savedInstanceState);
        createNotificationChannel();
        requestNotificationPermission();
    }

    private void requestNotificationPermission() {
        // Without this, the playback notification (and its pause/play button)
        // never shows on Android 13+, since POST_NOTIFICATIONS defaults to denied.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, android.Manifest.permission.POST_NOTIFICATIONS)
                    != PackageManager.PERMISSION_GRANTED) {
                ActivityCompat.requestPermissions(
                    this,
                    new String[]{ android.Manifest.permission.POST_NOTIFICATIONS },
                    NOTIFICATION_PERMISSION_REQUEST_CODE
                );
            }
        }
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
        // Acquire wake lock to keep audio playing when app is in background.
        // Libérer tout lock précédent avant d'en recréer un : sinon chaque onPause
        // créait un nouveau WakeLock en écrasant la référence -> locks orphelins
        // jamais libérés (acquis pour 10h chacun).
        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
        }
        PowerManager powerManager = (PowerManager) getSystemService(POWER_SERVICE);
        if (powerManager != null) {
            wakeLock = powerManager.newWakeLock(
                PowerManager.PARTIAL_WAKE_LOCK,
                "Sevenz:AudioWakeLock"
            );
            wakeLock.acquire(10 * 60 * 60 * 1000L); // 10 hours max
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