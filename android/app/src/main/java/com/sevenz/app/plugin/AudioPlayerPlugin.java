package com.sevenz.app.plugin;

import android.content.Intent;
import android.os.Build;
import android.util.Log;

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
                // Initialize NewPipe
                YoutubeService service = (YoutubeService) NewPipe.getService(0); // 0 = YouTube
                
                String videoUrl = "https://www.youtube.com/watch?v=" + videoId;
                
                // Get stream info
                StreamInfo info = StreamInfo.getInfo(videoUrl);
                
                // Find best audio stream (highest bitrate)
                AudioStream bestAudio = info.getAudioStreams()
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
                
                Log.d(TAG, "Found audio URL! Bitrate: " + bitrate);
                
                // Start the AudioService with the extracted URL
                startAudioService(audioUrl, title, artist, thumb);
                
                JSObject result = new JSObject();
                result.put("success", true);
                result.put("audioUrl", audioUrl);
                result.put("bitrate", bitrate);
                result.put("message", "Playing: " + title);
                
                call.resolve(result);
                
            } catch (Exception e) {
                Log.e(TAG, "Extraction failed", e);
                call.reject("Extraction failed: " + e.getMessage());
            }
        }).start();
    }
    
    private void startAudioService(String url, String title, String artist, String thumb) {
        Intent intent = new Intent(getContext(), AudioService.class);
        intent.setAction(ACTION_PLAY);
        intent.putExtra("action", ACTION_PLAY);
        intent.putExtra("url", url);
        intent.putExtra("title", title);
        intent.putExtra("artist", artist);
        intent.putExtra("thumb", thumb);
        
        Log.d(TAG, "Starting AudioService with URL");
        
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getContext().startForegroundService(intent);
        } else {
            getContext().startService(intent);
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