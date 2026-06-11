package com.sevenz.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.media3.common.MediaItem;
import androidx.media3.common.Player;
import androidx.media3.exoplayer.ExoPlayer;

import com.getcapacitor.BridgeActivity;

public class AudioService extends Service {
    
    private static final String CHANNEL_ID = "SevenzAudioChannel";
    private static final int NOTIFICATION_ID = 1;
    private static final String ACTION_PLAY = "com.sevenz.app.PLAY";
    private static final String ACTION_PAUSE = "com.sevenz.app.PAUSE";
    private static final String ACTION_RESUME = "com.sevenz.app.RESUME";
    private static final String ACTION_STOP = "com.sevenz.app.STOP";
    private static final String ACTION_NEXT = "com.sevenz.app.NEXT";
    private static final String ACTION_PREV = "com.sevenz.app.PREV";
    
    private ExoPlayer player;
    private String currentTitle = "";
    private String currentArtist = "";
    private String currentThumb = "";
    private PowerManager.WakeLock wakeLock;
    
    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
        acquireWakeLock();
    }
    
    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        android.util.Log.d("AudioService", "onStartCommand called, intent=" + (intent != null ? "not null" : "null"));
        
        if (intent == null) {
            android.util.Log.d("AudioService", "Intent is null, returning START_NOT_STICKY");
            return START_NOT_STICKY;
        }
        
        String action = intent.getStringExtra("action");
        if (action == null) {
            action = intent.getAction();
        }
        
        android.util.Log.d("AudioService", "Action received: " + action);
        
        if (action == null) {
            android.util.Log.d("AudioService", "Action is null, returning START_NOT_STICKY");
            return START_NOT_STICKY;
        }
        
        switch (action) {
            case ACTION_PLAY:
                String url = intent.getStringExtra("url");
                currentTitle = intent.getStringExtra("title");
                currentArtist = intent.getStringExtra("artist");
                android.util.Log.d("AudioService", "PLAY action - URL: " + (url != null ? "present (" + url.length() + " chars)" : "NULL"));
                playAudio(url);
                break;
            case ACTION_PAUSE:
                android.util.Log.d("AudioService", "PAUSE action");
                pauseAudio();
                break;
            case ACTION_RESUME:
                android.util.Log.d("AudioService", "RESUME action");
                resumeAudio();
                break;
            case ACTION_STOP:
                android.util.Log.d("AudioService", "STOP action");
                stopAudio();
                break;
            case ACTION_NEXT:
                // Next track - emit event to JS
                break;
            case ACTION_PREV:
                // Prev track - emit event to JS
                break;
        }
        
        return START_STICKY;
    }
    
    private void playAudio(String url) {
        android.util.Log.d("AudioService", "playAudio called, URL: " + (url != null ? url.substring(0, Math.min(50, url.length())) + "..." : "NULL"));
        
        if (url == null || url.isEmpty()) {
            android.util.Log.e("AudioService", "URL is null or empty, cannot play");
            return;
        }
        
        if (player == null) {
            android.util.Log.d("AudioService", "Creating new ExoPlayer");
            player = new ExoPlayer.Builder(this).build();
            player.addListener(new Player.Listener() {
                @Override
                public void onPlaybackStateChanged(int playbackState) {
                    android.util.Log.d("AudioService", "Playback state changed: " + playbackState);
                    if (playbackState == Player.STATE_ENDED) {
                        // Track ended - emit event to JS
                    }
                }
            });
        }
        
        try {
            android.util.Log.d("AudioService", "Setting media item and preparing...");
            MediaItem mediaItem = MediaItem.fromUri(url);
            player.setMediaItem(mediaItem);
            player.prepare();
            player.play();
            
            android.util.Log.d("AudioService", "Calling startForeground...");
            startForeground(NOTIFICATION_ID, buildNotification());
            android.util.Log.d("AudioService", "Notification started");
        } catch (Exception e) {
            android.util.Log.e("AudioService", "Error playing audio", e);
        }
    }
    
    private void pauseAudio() {
        if (player != null) {
            player.pause();
            updateNotification();
        }
    }
    
    private void resumeAudio() {
        if (player != null) {
            player.play();
            updateNotification();
        }
    }
    
    private void stopAudio() {
        if (player != null) {
            player.stop();
            player.release();
            player = null;
        }
        releaseWakeLock();
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
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
            channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }
    }
    
    private Notification buildNotification() {
        // Intent to open app when notification is clicked
        Intent openIntent = new Intent(this, MainActivity.class);
        openIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent openPendingIntent = PendingIntent.getActivity(
            this, 0, openIntent, PendingIntent.FLAG_IMMUTABLE
        );
        
        // Pause/Play action
        boolean isPlaying = player != null && player.isPlaying();
        String playPauseAction = isPlaying ? ACTION_PAUSE : ACTION_RESUME;
        int playPauseIcon = isPlaying ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play;
        
        Intent pauseIntent = new Intent(this, AudioService.class);
        pauseIntent.setAction(playPauseAction);
        PendingIntent pausePendingIntent = PendingIntent.getService(
            this, 1, pauseIntent, PendingIntent.FLAG_IMMUTABLE
        );
        
        // Stop action
        Intent stopIntent = new Intent(this, AudioService.class);
        stopIntent.setAction(ACTION_STOP);
        PendingIntent stopPendingIntent = PendingIntent.getService(
            this, 2, stopIntent, PendingIntent.FLAG_IMMUTABLE
        );
        
        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(currentTitle != null ? currentTitle : "Sevenz")
            .setContentText(currentArtist != null ? currentArtist : "Playing...")
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentIntent(openPendingIntent)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(isPlaying)
            .addAction(playPauseIcon, isPlaying ? "Pause" : "Play", pausePendingIntent)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Stop", stopPendingIntent)
            .setStyle(new androidx.media.app.NotificationCompat.MediaStyle()
                .setShowActionsInCompactView(0, 1));
        
        return builder.build();
    }
    
    private void updateNotification() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) {
            manager.notify(NOTIFICATION_ID, buildNotification());
        }
    }
    
    private void acquireWakeLock() {
        PowerManager powerManager = (PowerManager) getSystemService(POWER_SERVICE);
        if (powerManager != null) {
            wakeLock = powerManager.newWakeLock(
                PowerManager.PARTIAL_WAKE_LOCK,
                "Sevenz:AudioWakeLock"
            );
            wakeLock.acquire(10 * 60 * 60 * 1000L); // 10 hours max
        }
    }
    
    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
        }
    }
    
    @Override
    public void onDestroy() {
        if (player != null) {
            player.release();
            player = null;
        }
        releaseWakeLock();
        super.onDestroy();
    }
    
    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}