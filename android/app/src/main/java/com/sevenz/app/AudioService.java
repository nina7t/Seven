package com.sevenz.app;

import android.animation.Animator;
import android.animation.AnimatorListenerAdapter;
import android.animation.ValueAnimator;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.drawable.Drawable;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.media3.common.MediaItem;
import androidx.media3.common.Player;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.DefaultLoadControl;
import androidx.media3.exoplayer.LoadControl;

import com.bumptech.glide.Glide;
import com.bumptech.glide.request.target.CustomTarget;
import com.bumptech.glide.request.transition.Transition;
import com.getcapacitor.BridgeActivity;
import com.sevenz.app.plugin.AudioPlayerPlugin;

public class AudioService extends Service {
    
    private static final String CHANNEL_ID = "SevenzAudioChannel";
    private static final int NOTIFICATION_ID = 1;
    private static final String ACTION_PLAY = "com.sevenz.app.PLAY";
    private static final String ACTION_PAUSE = "com.sevenz.app.PAUSE";
    private static final String ACTION_RESUME = "com.sevenz.app.RESUME";
    private static final String ACTION_STOP = "com.sevenz.app.STOP";
    private static final String ACTION_NEXT = "com.sevenz.app.NEXT";
    private static final String ACTION_PREV = "com.sevenz.app.PREV";
    private static final String ACTION_REWIND = "com.sevenz.app.REWIND";
    private static final String ACTION_FORWARD = "com.sevenz.app.FORWARD";
    private static final String ACTION_SET_CROSSFADE = "com.sevenz.app.SET_CROSSFADE";
    private static final String ACTION_LOAD_NEXT = "com.sevenz.app.LOAD_NEXT";
    
    // Dual player architecture for crossfade
    private ExoPlayer playerA;
    private ExoPlayer playerB;
    private ExoPlayer activePlayer;  // Currently playing
    private ExoPlayer nextPlayer;    // Preloaded for crossfade
    
    private String currentTitle = "";
    private String currentArtist = "";
    private String currentThumb = "";
    private String nextUrl = null;   // Preloaded next track URL
    private String nextTitle = "";
    private String nextArtist = "";
    private String nextThumb = "";
    private Bitmap currentArtwork = null;
    private Bitmap nextArtwork = null;
    private PowerManager.WakeLock wakeLock;
    private MediaSessionCompat mediaSession;
    
    // Crossfade settings
    private int crossfadeDuration = 0; // in milliseconds, 0 = disabled
    private boolean crossfadeStarted = false;
    private ValueAnimator crossfadeAnimator = null;
    
    private final Handler progressHandler = new Handler(Looper.getMainLooper());
    private final Handler crossfadeHandler = new Handler(Looper.getMainLooper());
    
    private final Runnable updateProgressRunnable = new Runnable() {
        @Override
        public void run() {
            if (player != null && player.isPlaying()) {
                updatePlaybackState();
                // Crossfade disabled - no trigger check
                progressHandler.postDelayed(this, 500);
            }
        }
    };
    
    private final Runnable crossfadeCheckRunnable = new Runnable() {
        @Override
        public void run() {
            checkCrossfadeTrigger();
            if (activePlayer != null && activePlayer.isPlaying() && crossfadeDuration > 0) {
                crossfadeHandler.postDelayed(this, 500);
            }
        }
    };
    
    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
        acquireWakeLock();
        initMediaSession();
    }
    
    private void initMediaSession() {
        mediaSession = new MediaSessionCompat(this, "SevenzMedia");
        mediaSession.setActive(true);
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
                currentThumb = intent.getStringExtra("thumb");
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
                android.util.Log.d("AudioService", "NEXT action");
                nextTrack();
                break;
            case ACTION_PREV:
                android.util.Log.d("AudioService", "PREV action");
                previousTrack();
                break;
            case ACTION_REWIND:
                android.util.Log.d("AudioService", "REWIND action");
                rewind(10000);
                break;
            case ACTION_FORWARD:
                android.util.Log.d("AudioService", "FORWARD action");
                forward(10000);
                break;
            case ACTION_SET_CROSSFADE:
                int durationMs = intent.getIntExtra("durationMs", 0);
                android.util.Log.d("AudioService", "SET_CROSSFADE: " + durationMs + "ms");
                setCrossfade(durationMs);
                break;
            case ACTION_LOAD_NEXT:
                String nextTrackUrl = intent.getStringExtra("url");
                String nextTrackTitle = intent.getStringExtra("title");
                String nextTrackArtist = intent.getStringExtra("artist");
                String nextTrackThumb = intent.getStringExtra("thumb");
                android.util.Log.d("AudioService", "LOAD_NEXT action");
                loadNextTrack(nextTrackUrl, nextTrackTitle, nextTrackArtist, nextTrackThumb);
                break;
        }
        
        return START_STICKY;
    }
    
    // Single player for stable playback (crossfade disabled)
    private ExoPlayer player;
    
    private void playAudio(String url) {
        android.util.Log.d("AudioService", "playAudio called, URL: " + (url != null ? url.substring(0, Math.min(50, url.length())) + "..." : "NULL"));
        
        if (url == null || url.isEmpty()) {
            android.util.Log.e("AudioService", "URL is null or empty, cannot play");
            return;
        }
        
        // Stop any existing playback
        if (player != null) {
            player.stop();
            player.release();
        }
        
        // Create new player
        player = createSimpleExoPlayer();
        activePlayer = player; // for compatibility with existing code
        
        try {
            android.util.Log.d("AudioService", "Setting media item and preparing...");
            MediaItem mediaItem = MediaItem.fromUri(url);
            player.setMediaItem(mediaItem);
            player.setVolume(1.0f);
            player.setPlayWhenReady(true);
            player.prepare();
            
            // Load artwork and start foreground after
            loadArtwork(currentThumb);
            startProgressUpdates();
            
        } catch (Exception e) {
            android.util.Log.e("AudioService", "Error playing audio", e);
        }
    }
    
    private ExoPlayer createSimpleExoPlayer() {
        android.util.Log.d("AudioService", "Creating simple ExoPlayer");
        LoadControl loadControl = new DefaultLoadControl.Builder()
            .setBufferDurationsMs(
                5000,   // minBufferMs
                15000,  // maxBufferMs
                500,    // bufferForPlaybackMs - fast start
                1000    // bufferForPlaybackAfterRebufferMs
            )
            .build();
        
        ExoPlayer newPlayer = new ExoPlayer.Builder(this)
            .setLoadControl(loadControl)
            .build();
        
        newPlayer.addListener(new Player.Listener() {
            @Override
            public void onPlaybackStateChanged(int playbackState) {
                android.util.Log.d("AudioService", "Playback state: " + playbackState);
                if (playbackState == Player.STATE_ENDED) {
                    android.util.Log.d("AudioService", "Track ended - notifying JS");
                    AudioPlayerPlugin.notifyTrackEnded(getApplicationContext());
                }
            }
            
            @Override
            public void onIsPlayingChanged(boolean isPlaying) {
                android.util.Log.d("AudioService", "isPlaying: " + isPlaying);
                updatePlaybackState();
                updateNotification();
                AudioPlayerPlugin.notifyPlaybackStateChanged(isPlaying);
            }
        });
        
        return newPlayer;
    }
    
    private ExoPlayer createExoPlayer() {
        android.util.Log.d("AudioService", "Creating new ExoPlayer with optimized load control");
        LoadControl loadControl = new DefaultLoadControl.Builder()
            .setBufferDurationsMs(
                5000,   // minBufferMs - 5s instead of 50s default
                15000,  // maxBufferMs
                500,    // bufferForPlaybackMs - 500ms instead of 2500ms
                1000    // bufferForPlaybackAfterRebufferMs
            )
            .build();
        
        ExoPlayer player = new ExoPlayer.Builder(this)
            .setLoadControl(loadControl)
            .build();
        
        player.addListener(new Player.Listener() {
            @Override
            public void onPlaybackStateChanged(int playbackState) {
                android.util.Log.d("AudioService", "Playback state changed: " + playbackState);
                if (playbackState == Player.STATE_ENDED) {
                    android.util.Log.d("AudioService", "Track ended - player");
                    // If this is the active player and no crossfade was started, notify JS
                    if (player == activePlayer && !crossfadeStarted && crossfadeDuration == 0) {
                        AudioPlayerPlugin.notifyTrackEnded(getApplicationContext());
                    }
                }
            }
            
            @Override
            public void onIsPlayingChanged(boolean isPlaying) {
                android.util.Log.d("AudioService", "isPlaying changed: " + isPlaying);
                if (player == activePlayer) {
                    updatePlaybackState();
                    updateNotification();
                    AudioPlayerPlugin.notifyPlaybackStateChanged(isPlaying);
                }
            }
        });
        
        return player;
    }
    
    // Crossfade disabled - methods kept for future reimplementation
    private void setCrossfade(int durationMs) {
        // Crossfade temporarily disabled for stability
        android.util.Log.d("AudioService", "Crossfade ignored (disabled): " + durationMs + "ms");
    }
    
    private void startCrossfadeMonitoring() {
        // Disabled
    }
    
    private void stopCrossfadeMonitoring() {
        crossfadeHandler.removeCallbacks(crossfadeCheckRunnable);
    }
    
    private void checkCrossfadeTrigger() {
        // Crossfade disabled - do nothing
    }
    
    private void loadNextTrack(String url, String title, String artist, String thumb) {
        // Crossfade disabled - ignore load next track
        android.util.Log.d("AudioService", "loadNextTrack ignored (crossfade disabled)");
    }
    
    // Crossfade methods kept for future reimplementation (all disabled)
    private void startCrossfade() {
        // Disabled
    }
    
    private void cancelCrossfade() {
        if (crossfadeAnimator != null) {
            crossfadeAnimator.cancel();
            crossfadeAnimator = null;
        }
    }
    
    private void loadNextArtwork(String thumbUrl) {
        // Crossfade disabled - no next artwork needed
    }
    
    private void loadArtwork(String thumbUrl) {
        if (thumbUrl == null || thumbUrl.isEmpty()) {
            currentArtwork = null;
            startForeground(NOTIFICATION_ID, buildNotification());
            startProgressUpdates();
            return;
        }
        
        Glide.with(getApplicationContext())
            .asBitmap()
            .load(thumbUrl)
            .into(new CustomTarget<Bitmap>() {
                @Override
                public void onResourceReady(@NonNull Bitmap resource, @Nullable Transition<? super Bitmap> transition) {
                    currentArtwork = resource;
                    updateMediaMetadata();
                    startForeground(NOTIFICATION_ID, buildNotification());
                    startProgressUpdates();
                }
                
                @Override
                public void onLoadCleared(@Nullable Drawable placeholder) {}
                
                @Override
                public void onLoadFailed(@Nullable Drawable errorDrawable) {
                    currentArtwork = null;
                    startForeground(NOTIFICATION_ID, buildNotification());
                    startProgressUpdates();
                }
            });
    }
    
    private void startProgressUpdates() {
        progressHandler.removeCallbacks(updateProgressRunnable);
        progressHandler.post(updateProgressRunnable);
    }
    
    private void stopProgressUpdates() {
        progressHandler.removeCallbacks(updateProgressRunnable);
    }
    
    private void updatePlaybackState() {
        if (mediaSession == null || player == null) return;
        
        boolean isPlaying = player.isPlaying();
        long position = player.getCurrentPosition();
        
        PlaybackStateCompat playbackState = new PlaybackStateCompat.Builder()
            .setActions(
                PlaybackStateCompat.ACTION_PLAY |
                PlaybackStateCompat.ACTION_PAUSE |
                PlaybackStateCompat.ACTION_SKIP_TO_NEXT |
                PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS |
                PlaybackStateCompat.ACTION_SEEK_TO |
                PlaybackStateCompat.ACTION_FAST_FORWARD |
                PlaybackStateCompat.ACTION_REWIND
            )
            .setState(
                isPlaying ? PlaybackStateCompat.STATE_PLAYING : PlaybackStateCompat.STATE_PAUSED,
                position,
                1.0f
            )
            .build();
        
        mediaSession.setPlaybackState(playbackState);
        updateMediaMetadata();
    }
    
    private void updateMediaMetadata() {
        if (mediaSession == null) return;
        
        long duration = player != null ? player.getDuration() : 0;
        if (duration < 0) duration = 0;
        
        MediaMetadataCompat.Builder metadataBuilder = new MediaMetadataCompat.Builder()
            .putString(MediaMetadataCompat.METADATA_KEY_TITLE, currentTitle != null ? currentTitle : "Sevenz")
            .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, currentArtist != null ? currentArtist : "Unknown")
            .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, duration);
        
        if (currentArtwork != null) {
            metadataBuilder.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, currentArtwork);
            metadataBuilder.putBitmap(MediaMetadataCompat.METADATA_KEY_DISPLAY_ICON, currentArtwork);
        }
        
        mediaSession.setMetadata(metadataBuilder.build());
    }
    
    private void nextTrack() {
        // Emit event to JS via AudioPlayerPlugin
        AudioPlayerPlugin.notifyNextTrack(getApplicationContext());
    }
    
    private void previousTrack() {
        AudioPlayerPlugin.notifyPreviousTrack(getApplicationContext());
    }
    
    private void rewind(long ms) {
        if (player != null) {
            long newPos = Math.max(0, player.getCurrentPosition() - ms);
            player.seekTo(newPos);
            updatePlaybackState();
            updateNotification();
        }
    }
    
    private void forward(long ms) {
        if (player != null) {
            long newPos = Math.min(player.getDuration(), player.getCurrentPosition() + ms);
            player.seekTo(newPos);
            updatePlaybackState();
            updateNotification();
        }
    }
    
    private void pauseAudio() {
        if (player != null) {
            player.pause();
            stopProgressUpdates();
            updatePlaybackState();
            updateNotification();
        }
    }
    
    private void resumeAudio() {
        if (player != null) {
            player.play();
            startProgressUpdates();
            updatePlaybackState();
            updateNotification();
        }
    }
    
    private void stopAudio() {
        stopProgressUpdates();
        
        if (player != null) {
            player.stop();
            player.release();
            player = null;
        }
        
        if (mediaSession != null) {
            mediaSession.setActive(false);
            mediaSession.release();
            mediaSession = null;
        }
        currentArtwork = null;
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
        boolean isPlaying = player != null && player.isPlaying();
        
        // Intent to open app when notification is clicked
        Intent openIntent = new Intent(this, MainActivity.class);
        openIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent openPendingIntent = PendingIntent.getActivity(
            this, 0, openIntent, PendingIntent.FLAG_IMMUTABLE
        );
        
        // Previous action
        Intent prevIntent = new Intent(this, AudioService.class);
        prevIntent.setAction(ACTION_PREV);
        PendingIntent prevPendingIntent = PendingIntent.getService(
            this, 1, prevIntent, PendingIntent.FLAG_IMMUTABLE
        );
        
        // Rewind 10s action
        Intent rewindIntent = new Intent(this, AudioService.class);
        rewindIntent.setAction(ACTION_REWIND);
        PendingIntent rewindPendingIntent = PendingIntent.getService(
            this, 2, rewindIntent, PendingIntent.FLAG_IMMUTABLE
        );
        
        // Play/Pause action
        String playPauseAction = isPlaying ? ACTION_PAUSE : ACTION_RESUME;
        int playPauseIcon = isPlaying ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play;
        Intent playPauseIntent = new Intent(this, AudioService.class);
        playPauseIntent.setAction(playPauseAction);
        PendingIntent playPausePendingIntent = PendingIntent.getService(
            this, 3, playPauseIntent, PendingIntent.FLAG_IMMUTABLE
        );
        
        // Forward 10s action
        Intent forwardIntent = new Intent(this, AudioService.class);
        forwardIntent.setAction(ACTION_FORWARD);
        PendingIntent forwardPendingIntent = PendingIntent.getService(
            this, 4, forwardIntent, PendingIntent.FLAG_IMMUTABLE
        );
        
        // Next action
        Intent nextIntent = new Intent(this, AudioService.class);
        nextIntent.setAction(ACTION_NEXT);
        PendingIntent nextPendingIntent = PendingIntent.getService(
            this, 5, nextIntent, PendingIntent.FLAG_IMMUTABLE
        );
        
        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(currentTitle != null ? currentTitle : "Sevenz")
            .setContentText(currentArtist != null ? currentArtist : "Playing...")
            .setSmallIcon(R.mipmap.ic_launcher)
            .setLargeIcon(currentArtwork)
            .setContentIntent(openPendingIntent)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(isPlaying)
            .setOnlyAlertOnce(true)
            .addAction(android.R.drawable.ic_media_previous, "Previous", prevPendingIntent)
            .addAction(android.R.drawable.ic_media_rew, "-10s", rewindPendingIntent)
            .addAction(playPauseIcon, isPlaying ? "Pause" : "Play", playPausePendingIntent)
            .addAction(android.R.drawable.ic_media_ff, "+10s", forwardPendingIntent)
            .addAction(android.R.drawable.ic_media_next, "Next", nextPendingIntent)
            .setStyle(new androidx.media.app.NotificationCompat.MediaStyle()
                .setMediaSession(mediaSession.getSessionToken())
                .setShowActionsInCompactView(0, 2, 4));
        
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
        stopProgressUpdates();
        
        if (player != null) {
            player.release();
            player = null;
        }
        
        if (mediaSession != null) {
            mediaSession.setActive(false);
            mediaSession.release();
            mediaSession = null;
        }
        releaseWakeLock();
        super.onDestroy();
    }
    
    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
    
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        super.onTaskRemoved(rootIntent);
        stopAudio();
    }
}