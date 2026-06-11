package com.sevenz.app.plugin;

import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.widget.Toast;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;

import com.sevenz.app.AudioService;

import org.schabi.newpipe.extractor.NewPipe;
import org.schabi.newpipe.extractor.exceptions.ExtractionException;
import org.schabi.newpipe.extractor.services.youtube.YoutubeService;
import org.schabi.newpipe.extractor.stream.AudioStream;
import org.schabi.newpipe.extractor.stream.StreamInfo;

import java.util.Comparator;

public class AudioPlayerPlugin extends Plugin {
    
    private static final String TAG = "AudioPlayerPlugin";
    public static final String ACTION_PLAY = "com.sevenz.app.PLAY";
    public static final String ACTION_PAUSE = "com.sevenz.app.PAUSE";
    public static final String ACTION_RESUME = "com.sevenz.app.RESUME";
    public static final String ACTION_STOP = "com.sevenz.app.STOP";
    
    // Handler for showing Toasts on main thread
    private Handler mainHandler = new Handler(Looper.getMainLooper());
    
    private void showToast(String message) {
        mainHandler.post(() -> Toast.makeText(getContext(), message, Toast.LENGTH_LONG).show());
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
        showToast("Extraction audio en cours...");
        
        // Run extraction on background thread
        new Thread(() -> {
            try {
                Log.d(TAG, "Starting NewPipeExtractor for: " + videoId);
                showToast("Extraction YouTube...");
                
                // Initialize NewPipe
                YoutubeService service = (YoutubeService) NewPipe.getService(0); // 0 = YouTube
                
                String videoUrl = "https://www.youtube.com/watch?v=" + videoId;
                Log.d(TAG, "Fetching stream info from: " + videoUrl);
                
                // Get stream info
                StreamInfo info = StreamInfo.getInfo(videoUrl);
                Log.d(TAG, "Stream info fetched, title: " + info.getName());
                showToast("Titre trouvé: " + info.getName());
                
                // Find best audio stream (highest bitrate)
                java.util.List<AudioStream> audioStreams = info.getAudioStreams();
                Log.d(TAG, "Found " + audioStreams.size() + " audio streams");
                
                AudioStream bestAudio = audioStreams
                    .stream()
                    .max(Comparator.comparingInt(AudioStream::getAverageBitrate))
                    .orElse(null);
                
                if (bestAudio == null) {
                    Log.e(TAG, "No audio stream found");
                    showToast("ERREUR: Aucun flux audio trouvé");
                    call.reject("No audio available for this video.");
                    return;
                }
                
                String audioUrl = bestAudio.getUrl();
                int bitrate = bestAudio.getAverageBitrate();
                
                Log.d(TAG, "Found audio URL! Bitrate: " + bitrate + " URL length: " + audioUrl.length());
                showToast("Audio trouvé! Bitrate: " + bitrate + "kbps");
                
                // Start the AudioService with the extracted URL
                startAudioService(audioUrl, title, artist, thumb);
                showToast("Lecture en arrière-plan!");
                
                JSObject result = new JSObject();
                result.put("success", true);
                result.put("audioUrl", audioUrl);
                result.put("bitrate", bitrate);
                result.put("message", "Playing: " + title);
                
                call.resolve(result);
                
            } catch (Exception e) {
                Log.e(TAG, "Extraction failed", e);
                e.printStackTrace();
                String errorMsg = e.getMessage();
                if (errorMsg == null || errorMsg.isEmpty()) {
                    errorMsg = e.getClass().getSimpleName();
                }
                showToast("ERREUR extraction: " + errorMsg);
                call.reject("Extraction failed: " + errorMsg);
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
}