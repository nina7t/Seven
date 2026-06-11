package com.sevenz.app.plugin;

import android.content.Intent;
import android.os.AsyncTask;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;

import com.sevenz.app.AudioService;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;

public class AudioPlayerPlugin extends Plugin {
    
    private static final String TAG = "AudioPlayerPlugin";
    public static final String ACTION_PLAY = "com.sevenz.app.PLAY";
    public static final String ACTION_PAUSE = "com.sevenz.app.PAUSE";
    public static final String ACTION_RESUME = "com.sevenz.app.RESUME";
    public static final String ACTION_STOP = "com.sevenz.app.STOP";
    
    // Invidious instances for audio extraction (no server needed!)
    private static final String[] INVIDIUS_INSTANCES = {
        "https://invidious.protokolla.fi",
        "https://inv.nadeko.net",
        "https://invidious.nerdvpn.de",
        "https://yewtu.be"
    };
    
    /**
     * Play a YouTube video by extracting audio URL directly on device
     * This is the main method - it handles extraction + playback
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
        
        new PlayVideoTask(call, videoId, title, artist, thumb).execute();
    }
    
    private class PlayVideoTask extends AsyncTask<Void, Void, JSObject> {
        
        private final PluginCall call;
        private final String videoId;
        private final String title;
        private final String artist;
        private final String thumb;
        
        PlayVideoTask(PluginCall call, String videoId, String title, String artist, String thumb) {
            this.call = call;
            this.videoId = videoId;
            this.title = title;
            this.artist = artist;
            this.thumb = thumb;
        }
        
        @Override
        protected JSObject doInBackground(Void... params) {
            String audioUrl = extractAudioUrl(videoId);
            
            if (audioUrl == null) {
                JSObject error = new JSObject();
                error.put("error", "Could not extract audio URL. Try a different video.");
                return error;
            }
            
            // Start the AudioService with the extracted URL
            startAudioService(audioUrl, title, artist, thumb);
            
            JSObject result = new JSObject();
            result.put("success", true);
            result.put("audioUrl", audioUrl);
            result.put("message", "Playing: " + title);
            
            return result;
        }
        
        @Override
        protected void onPostExecute(JSObject result) {
            if (result.has("error")) {
                call.reject(result.getString("error"));
            } else {
                call.resolve(result);
            }
        }
    }
    
    /**
     * Extract audio URL using Invidious API (runs on device, no server!)
     */
    private String extractAudioUrl(String videoId) {
        for (String instance : INVIDIUS_INSTANCES) {
            try {
                Log.d(TAG, "Trying Invidious: " + instance);
                
                URL url = new URL(instance + "/api/v1/videos/" + videoId);
                HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                conn.setRequestMethod("GET");
                conn.setConnectTimeout(10000);
                conn.setReadTimeout(10000);
                conn.addRequestProperty("User-Agent", "Mozilla/5.0");
                
                if (conn.getResponseCode() == 200) {
                    BufferedReader reader = new BufferedReader(
                        new InputStreamReader(conn.getInputStream())
                    );
                    StringBuilder response = new StringBuilder();
                    String line;
                    while ((line = reader.readLine()) != null) {
                        response.append(line);
                    }
                    reader.close();
                    conn.disconnect();
                    
                    String audioUrl = parseAudioUrl(response.toString());
                    if (audioUrl != null) {
                        Log.d(TAG, "Found audio URL via " + instance);
                        return audioUrl;
                    }
                }
                
                conn.disconnect();
                
            } catch (Exception e) {
                Log.d(TAG, "Instance failed: " + instance + " - " + e.getMessage());
            }
        }
        
        return null;
    }
    
    /**
     * Parse Invidious response to find best audio URL
     */
    private String parseAudioUrl(String response) {
        try {
            JSONObject json = new JSONObject(response);
            
            if (json.has("error")) {
                return null;
            }
            
            org.json.JSONArray adaptiveFormats = json.optJSONArray("adaptiveFormats");
            if (adaptiveFormats == null) {
                return null;
            }
            
            JSONObject bestAudio = null;
            int bestBitrate = 0;
            
            for (int i = 0; i < adaptiveFormats.length(); i++) {
                JSONObject format = adaptiveFormats.getJSONObject(i);
                String type = format.optString("type", "");
                
                if (type.startsWith("audio/")) {
                    int bitrate = format.optInt("bitrate", 0);
                    if (bitrate > bestBitrate) {
                        bestBitrate = bitrate;
                        bestAudio = format;
                    }
                }
            }
            
            if (bestAudio != null) {
                return bestAudio.optString("url", "");
            }
            
        } catch (Exception e) {
            Log.e(TAG, "Failed to parse response", e);
        }
        
        return null;
    }
    
    private void startAudioService(String url, String title, String artist, String thumb) {
        Intent intent = new Intent(getContext(), AudioService.class);
        intent.setAction(ACTION_PLAY);
        intent.putExtra("url", url);
        intent.putExtra("title", title);
        intent.putExtra("artist", artist);
        intent.putExtra("thumb", thumb);
        getContext().startForegroundService(intent);
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