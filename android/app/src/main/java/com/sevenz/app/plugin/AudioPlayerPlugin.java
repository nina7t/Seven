package com.sevenz.app.plugin;

import android.content.Intent;
import android.os.Build;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import com.sevenz.app.AudioService;

import org.schabi.newpipe.extractor.NewPipe;
import org.schabi.newpipe.extractor.exceptions.ExtractionException;
import org.schabi.newpipe.extractor.services.youtube.YoutubeService;
import org.schabi.newpipe.extractor.stream.AudioStream;
import org.schabi.newpipe.extractor.stream.StreamInfo;

import java.util.Comparator;
import java.util.HashMap;
import java.util.Map;

@CapacitorPlugin(name = "AudioPlayerPlugin")
public class AudioPlayerPlugin extends Plugin {
    
    private static final String TAG = "AudioPlayerPlugin";
    public static final String ACTION_PLAY = "com.sevenz.app.PLAY";
    public static final String ACTION_PAUSE = "com.sevenz.app.PAUSE";
    public static final String ACTION_RESUME = "com.sevenz.app.RESUME";
    public static final String ACTION_STOP = "com.sevenz.app.STOP";
    
    // Static instance for AudioService callbacks
    private static AudioPlayerPlugin instance;
    
    @Override
    public void load() {
        instance = this;
    }
    
    public static void notifyNextTrack(android.content.Context context) {
        if (instance != null) {
            instance.notifyListeners("next", new JSObject());
        }
    }
    
    public static void notifyPreviousTrack(android.content.Context context) {
        if (instance != null) {
            instance.notifyListeners("previous", new JSObject());
        }
    }
    
    public static void notifyPlaybackStateChanged(boolean isPlaying) {
        if (instance != null) {
            JSObject data = new JSObject();
            data.put("isPlaying", isPlaying);
            instance.notifyListeners("playbackStateChanged", data);
        }
    }
    
    public static void notifyTrackEnded(android.content.Context context) {
        if (instance != null) {
            instance.notifyListeners("trackEnded", new JSObject());
        }
    }
    
    public static void notifyRequestNextTrack(android.content.Context context) {
        if (instance != null) {
            instance.notifyListeners("requestNextTrack", new JSObject());
        }
    }
    
    public static void notifyTrackChanged(android.content.Context context) {
        if (instance != null) {
            instance.notifyListeners("trackChanged", new JSObject());
        }
    }
    
    /**
     * Play a YouTube video by extracting audio URL using NewPipeExtractor
     * This extracts URLs directly on device without any server!
     */
    @PluginMethod
    public void playVideo(PluginCall call) {
        String videoId = call.getString("videoId");
        final String title = call.getString("title", "Unknown");
        final String artist = call.getString("artist", "Unknown Artist");
        final String thumb = call.getString("thumb", "");
        
        if (videoId == null || videoId.isEmpty()) {
            call.reject("videoId is required");
            return;
        }
        
        Log.d(TAG, "playVideo called for: " + videoId);
        
        // Run extraction on background thread
        new Thread(() -> {
            try {
                Log.d(TAG, "Starting NewPipeExtractor for: " + videoId);
                
                // Initialize NewPipe
                // Initialize NewPipe downloader
                if (NewPipe.getDownloader() == null) {
                    NewPipe.init(DownloaderImpl.getInstance());
                }
                
                YoutubeService service = (YoutubeService) NewPipe.getService(0); // 0 = YouTube
                
                String videoUrl = "https://www.youtube.com/watch?v=" + videoId;
                Log.d(TAG, "Fetching stream info from: " + videoUrl);
                
                // Get stream info
                StreamInfo info = StreamInfo.getInfo(videoUrl);
                Log.d(TAG, "Stream info fetched, title: " + info.getName());
                
                // Find best audio stream (highest bitrate)
                java.util.List<AudioStream> audioStreams = info.getAudioStreams();
                Log.d(TAG, "Found " + audioStreams.size() + " audio streams");
                
                AudioStream bestAudio = audioStreams
                    .stream()
                    .max(Comparator.comparingInt(AudioStream::getAverageBitrate))
                    .orElse(null);
                
                if (bestAudio == null) {
                    Log.e(TAG, "No audio stream found");
                    call.reject("No audio available for this video.");
                    return;
                }
                
                String audioUrl = bestAudio.getUrl();
                int bitrate = bestAudio.getAverageBitrate();
                
                Log.d(TAG, "Found audio URL! Bitrate: " + bitrate + " URL length: " + audioUrl.length());
                
                // Start the AudioService with the extracted URL
                startAudioService(audioUrl, title, artist, thumb);
                
                JSObject result = new JSObject();
                result.put("success", true);
                result.put("audioUrl", audioUrl);
                result.put("bitrate", bitrate);
                result.put("message", "Playing: " + title);
                
                call.resolve(result);
                
            } catch (Exception e) {
                String errorDetail = e.getClass().getSimpleName() + ": " + (e.getMessage() != null ? e.getMessage() : "no message");
                Log.e(TAG, "Extraction failed: " + errorDetail, e);
                e.printStackTrace();
                call.reject("Extraction failed: " + errorDetail);
            }
        }).start();
    }
    
    private void startAudioService(String url, String title, String artist, String thumb) {
        Log.d(TAG, "startAudioService called with URL length: " + (url != null ? url.length() : 0));
        
        Intent intent = new Intent(getContext(), AudioService.class);
        intent.setAction(ACTION_PLAY);
        intent.putExtra("action", ACTION_PLAY);
        intent.putExtra("url", url);
        intent.putExtra("title", title);
        intent.putExtra("artist", artist);
        intent.putExtra("thumb", thumb);
        
        Log.d(TAG, "Starting foreground service...");
        
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getContext().startForegroundService(intent);
            Log.d(TAG, "startForegroundService called (Android O+)");
        } else {
            getContext().startService(intent);
            Log.d(TAG, "startService called (pre-O)");
        }
    }
    
    // Existing methods for direct URL playback
    @PluginMethod
    public void play(PluginCall call) {
        String url = call.getString("url");
        String title = call.getString("title", "Unknown");
        String artist = call.getString("artist", "Unknown Artist");
        String thumb = call.getString("thumb", "");
        
        if (url == null || url.isEmpty()) {
            call.reject("URL is required");
            return;
        }
        
        startAudioService(url, title, artist, thumb);
        
        JSObject result = new JSObject();
        result.put("success", true);
        call.resolve(result);
    }
    
    @PluginMethod
    public void pause(PluginCall call) {
        Intent intent = new Intent(getContext(), AudioService.class);
        intent.setAction(ACTION_PAUSE);
        getContext().startService(intent);
        
        JSObject result = new JSObject();
        result.put("success", true);
        call.resolve(result);
    }
    
    @PluginMethod
    public void resume(PluginCall call) {
        Intent intent = new Intent(getContext(), AudioService.class);
        intent.setAction(ACTION_RESUME);
        getContext().startService(intent);
        
        JSObject result = new JSObject();
        result.put("success", true);
        call.resolve(result);
    }
    
    @PluginMethod
    public void stop(PluginCall call) {
        Intent intent = new Intent(getContext(), AudioService.class);
        intent.setAction(ACTION_STOP);
        getContext().startService(intent);
        
        JSObject result = new JSObject();
        result.put("success", true);
        call.resolve(result);
    }
    
    @PluginMethod
    public void isPlaying(PluginCall call) {
        JSObject result = new JSObject();
        result.put("isPlaying", false);
        call.resolve(result);
    }
    
    // URL cache for preloading tracks
    private static Map<String, String> urlCache = new HashMap<>();
    
    @PluginMethod
    public void skipNext(PluginCall call) {
        notifyListeners("skipNext", new JSObject());
        call.resolve();
    }
    
    @PluginMethod
    public void skipPrevious(PluginCall call) {
        notifyListeners("skipPrevious", new JSObject());
        call.resolve();
    }
    
    @PluginMethod
    public void preload(PluginCall call) {
        String videoId = call.getString("videoId");
        if (videoId == null || videoId.isEmpty()) {
            call.reject("videoId is required");
            return;
        }
        
        // Check cache first
        if (urlCache.containsKey(videoId)) {
            JSObject result = new JSObject();
            result.put("cached", true);
            result.put("videoId", videoId);
            call.resolve(result);
            return;
        }
        
        // Preload in background thread
        new Thread(() -> {
            try {
                Log.d(TAG, "Preloading track: " + videoId);
                
                // Initialize NewPipe if needed
                if (NewPipe.getDownloader() == null) {
                    NewPipe.init(DownloaderImpl.getInstance());
                }
                
                String videoUrl = "https://www.youtube.com/watch?v=" + videoId;
                StreamInfo info = StreamInfo.getInfo(videoUrl);
                
                AudioStream bestAudio = info.getAudioStreams()
                    .stream()
                    .max(Comparator.comparingInt(AudioStream::getAverageBitrate))
                    .orElse(null);
                
                if (bestAudio != null) {
                    urlCache.put(videoId, bestAudio.getUrl());
                    Log.d(TAG, "Preloaded URL cached for: " + videoId);
                }
            } catch (Exception e) {
                Log.e(TAG, "Preload failed for: " + videoId, e);
            }
        }).start();
        
        JSObject result = new JSObject();
        result.put("preloading", true);
        result.put("videoId", videoId);
        call.resolve(result);
    }
    
    @PluginMethod
    public void getPreloadedUrl(PluginCall call) {
        String videoId = call.getString("videoId");
        if (videoId == null || videoId.isEmpty()) {
            call.reject("videoId is required");
            return;
        }
        
        String cachedUrl = urlCache.get(videoId);
        JSObject result = new JSObject();
        result.put("videoId", videoId);
        result.put("hasUrl", cachedUrl != null);
        if (cachedUrl != null) {
            result.put("url", cachedUrl);
        }
        call.resolve(result);
    }
    
    @PluginMethod
    public void clearPreloadCache(PluginCall call) {
        urlCache.clear();
        call.resolve();
    }
    
    @PluginMethod
    public void setCrossfade(PluginCall call) {
        int durationMs = call.getInt("durationMs", 0);
        
        Intent intent = new Intent(getContext(), AudioService.class);
        intent.setAction("com.sevenz.app.SET_CROSSFADE");
        intent.putExtra("durationMs", durationMs);
        getContext().startService(intent);
        
        JSObject result = new JSObject();
        result.put("durationMs", durationMs);
        call.resolve(result);
    }
    
    @PluginMethod
    public void loadNextTrack(PluginCall call) {
        String videoId = call.getString("videoId");
        final String title = call.getString("title", "Unknown");
        final String artist = call.getString("artist", "Unknown Artist");
        final String thumb = call.getString("thumb", "");
        
        if (videoId == null || videoId.isEmpty()) {
            call.reject("videoId is required");
            return;
        }
        
        // Check cache first
        String cachedUrl = urlCache.get(videoId);
        if (cachedUrl != null) {
            // Send directly to service
            Intent intent = new Intent(getContext(), AudioService.class);
            intent.setAction("com.sevenz.app.LOAD_NEXT");
            intent.putExtra("url", cachedUrl);
            intent.putExtra("title", title);
            intent.putExtra("artist", artist);
            intent.putExtra("thumb", thumb);
            getContext().startService(intent);
            
            JSObject result = new JSObject();
            result.put("cached", true);
            result.put("loaded", true);
            call.resolve(result);
            return;
        }
        
        // Extract URL on background thread
        new Thread(() -> {
            try {
                if (NewPipe.getDownloader() == null) {
                    NewPipe.init(DownloaderImpl.getInstance());
                }
                
                String videoUrl = "https://www.youtube.com/watch?v=" + videoId;
                StreamInfo info = StreamInfo.getInfo(videoUrl);
                
                AudioStream bestAudio = info.getAudioStreams()
                    .stream()
                    .max(Comparator.comparingInt(AudioStream::getAverageBitrate))
                    .orElse(null);
                
                if (bestAudio != null) {
                    String audioUrl = bestAudio.getUrl();
                    urlCache.put(videoId, audioUrl);
                    
                    // Send to service
                    Intent intent = new Intent(getContext(), AudioService.class);
                    intent.setAction("com.sevenz.app.LOAD_NEXT");
                    intent.putExtra("url", audioUrl);
                    intent.putExtra("title", title);
                    intent.putExtra("artist", artist);
                    intent.putExtra("thumb", thumb);
                    getContext().startService(intent);
                    
                    call.resolve(new JSObject() {{ put("loaded", true); }});
                } else {
                    call.reject("No audio stream found");
                }
            } catch (Exception e) {
                Log.e(TAG, "Error loading next track", e);
                call.reject("Extraction failed: " + e.getMessage());
            }
        }).start();
    }
}