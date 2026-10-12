package com.sevenz.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;
import com.sevenz.app.plugin.AudioPlayerPlugin;

public class MainActivity extends BridgeActivity {
    private static final String CHANNEL_ID = "SevenzAudioChannel";
    private static final int NOTIFICATION_ID = 1;
    private static final int NOTIFICATION_PERMISSION_REQUEST_CODE = 100;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Register plugins BEFORE super.onCreate so the bridge picks them up
        // when the WebView initializes.
        registerPlugin(AudioPlayerPlugin.class);
        super.onCreate(savedInstanceState);
        // Navigation à 3 boutons : Android pose un voile clair sous les boutons
        // pour garantir le contraste. L'app dessine déjà son fond nuit jusqu'en
        // bas (--safe-bottom), on retire donc ce voile blanc.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            getWindow().setNavigationBarContrastEnforced(false);
        }
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

    // Plus de WakeLock ici : l'activité en prenait un de 10h à chaque onPause,
    // même sans lecture. Le CPU est tenu par AudioService, et seulement pendant
    // la lecture.
}
