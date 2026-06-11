package com.sevenz.app.plugin;

import android.content.Intent;
import android.os.AsyncTask;
import android.os.Build;
import android.util.Log;
import android.util.SparseArray;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;

import com.sevenz.app.AudioService;

import at.huber.youtubeExtractor.YouTubeExtractor;
import at.huber.youtubeExtractor.YtFile;
import at.huber.youtubeExtractor.VideoMeta;

public class AudioPlayerPlugin extends Plugin {
    
    private static final String TAG = "AudioPlayerPlugin";
    public static final String ACTION_PLAY = "com.sevenz.app.PLAY";
    public static final String ACTION_PAUSE = "com.sevenz.app.PAUSE";
    public static final String ACTION_RESUME = "com.sevenz.app.RESUME";
    public static final String ACTION_STOP = "com.sevenz.app.STOP";
    
    /**
     * Play a YouTube video by extracting audio URL using YouTubeExtractor
     * This extracts URLs directly on device without any server!
     */
    @PluginMethod
    public void playVideo(PluginCall call) {
        String videoId = call.getString("videoId");
        String title = call.getString("title", "Unknown");
        String artist = call.getString("artist", "Unknown Artist");
        String thumb = call.getString("thumb", "");
        
        if (videoId == null || videoId.isEmpty()) {
            call.reject("videoId is required");
            return;
        }
        
        Log.d(TAG, "playVideo called for: " + videoId);
        
        // Extract and play
        String youtubeLink = "https://www.youtube.com/watch?v=" + videoId;
        
        YouTubeExtractor extractor = new YouTubeExtractor(getContext()) {
            @Override
            public void onExtractionComplete(SparseArray<YtFile> ytFiles, VideoMeta videoMeta) {
                if (ytFiles == null) {
                    Log.e(TAG, "Failed to extract - ytFiles is null");
                    call.reject("Failed to extract audio. Try another video.");
                    return;
                }
                
                try {
                    // Find best audio format (prefer m4a over webm)
                    String audioUrl = null;
                    int bestBitrate = 0;
                    
                    for (int i = 0; i < ytFiles.size(); i++) {
                        YtFile file = ytFiles.get(ytFiles.keyAt(i));
                        
                        if (file.getFormat().getAudioBitrate() > 0) {
                            int bitrate = file.getFormat().getAudioBitrate();
                            String format = file.getFormat().getExt();
                            
                            // Prefer m4a (higher quality) or highest bitrate
                            if (audioUrl == null || 
                                (format.equals("m4a") && !file.getFormat().getExt().equals("m4a")) ||
                                bitrate > bestBitrate) {
                                audioUrl = file.getUrl();
                                bestBitrate = bitrate;
                            }
                        }
                    }
                    
                    if (audioUrl == null) {
                        Log.e(TAG, "No audio stream found");
                        call.reject("No audio available for this video.");
                        return;
                    }
                    
                    Log.d(TAG, "Found audio URL! Bitrate: " + bestBitrate);
                    
                    // Start the AudioService with the extracted URL
                    startAudioService(audioUrl, title, artist, thumb);
                    
                    JSObject result = new JSObject();
                    result.put("success", true);
                    result.put("audioUrl", audioUrl);
                    result.put("bitrate", bestBitrate);
                    result.put("message", "Playing: " + title);
                    
                    call.resolve(result);
                    
                } catch (Exception e) {
                    Log.e(TAG, "Error processing audio", e);
                    call.reject("Error: " + e.getMessage());
                }
            }
        };
        
        extractor.execute(youtubeLink);
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