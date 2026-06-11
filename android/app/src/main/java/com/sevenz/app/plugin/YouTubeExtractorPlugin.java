package com.sevenz.app.plugin;

import android.os.AsyncTask;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * YouTubeExtractor - Extracts audio stream URLs directly on Android
 * Uses YouTube's streaming API to get audio URLs without a server
 */
public class YouTubeExtractorPlugin extends Plugin {
    
    private static final String TAG = "YouTubeExtractor";
    
    @PluginMethod
    public void getAudioUrl(PluginCall call) {
        String videoId = call.getString("videoId");
        
        if (videoId == null || videoId.isEmpty()) {
            call.reject("videoId is required");
            return;
        }
        
        Log.d(TAG, "Getting audio URL for: " + videoId);
        
        new ExtractAudioTask(call).execute(videoId);
    }
    
    private class ExtractAudioTask extends AsyncTask<String, Void, JSObject> {
        
        private final PluginCall call;
        
        ExtractAudioTask(PluginCall call) {
            this.call = call;
        }
        
        @Override
        protected JSObject doInBackground(String... params) {
            String videoId = params[0];
            
            try {
                // Method 1: Try Invidious API (public instances that work)
                JSObject result = tryInvidious(videoId);
                if (result != null) {
                    return result;
                }
                
                // Method 2: Try direct YouTube streaming URL extraction
                result = tryDirectExtraction(videoId);
                if (result != null) {
                    return result;
                }
                
                // Method 3: Fallback with error message
                JSObject error = new JSObject();
                error.put("error", "Could not extract audio URL. Try a different video.");
                return error;
                
            } catch (Exception e) {
                Log.e(TAG, "Extraction failed", e);
                JSObject error = new JSObject();
                error.put("error", "Extraction failed: " + e.getMessage());
                return error;
            }
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
     * Try fetching audio URL via Invidious public instances
     */
    private JSObject tryInvidious(String videoId) {
        String[] instances = {
            "https://invidious.protokolla.fi",
            "https://inv.nadeko.net",
            "https://invidious.nerdvpn.de",
            "https://yewtu.be"
        };
        
        for (String instance : instances) {
            try {
                Log.d(TAG, "Trying instance: " + instance);
                
                URL url = new URL(instance + "/api/v1/videos/" + videoId);
                HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                conn.setRequestMethod("GET");
                conn.setConnectTimeout(8000);
                conn.setReadTimeout(8000);
                conn.addRequestProperty("User-Agent", "Mozilla/5.0");
                
                int responseCode = conn.getResponseCode();
                
                if (responseCode == 200) {
                    BufferedReader reader = new BufferedReader(
                        new InputStreamReader(conn.getInputStream())
                    );
                    StringBuilder response = new StringBuilder();
                    String line;
                    while ((line = reader.readLine()) != null) {
                        response.append(line);
                    }
                    reader.close();
                    
                    return parseInvidiousResponse(response.toString(), videoId, instance);
                }
                
                conn.disconnect();
                
            } catch (Exception e) {
                Log.d(TAG, "Instance failed: " + instance + " - " + e.getMessage());
            }
        }
        
        return null;
    }
    
    /**
     * Parse Invidious API response to extract best audio format
     */
    private JSObject parseInvidiousResponse(String response, String videoId, String instance) {
        try {
            JSONObject json = new JSONObject(response);
            
            // Check for error in response
            if (json.has("error")) {
                Log.d(TAG, "Invidious error: " + json.getString("error"));
                return null;
            }
            
            // Get video info
            String title = json.optString("title", "Unknown");
            String author = json.optString("author", "Unknown Artist");
            int duration = json.optInt("lengthSeconds", 0);
            
            // Find best audio format from adaptiveFormats
            JSONArray adaptiveFormats = json.optJSONArray("adaptiveFormats");
            
            if (adaptiveFormats == null) {
                Log.d(TAG, "No adaptive formats found");
                return null;
            }
            
            JSONObject bestAudio = null;
            int bestBitrate = 0;
            
            for (int i = 0; i < adaptiveFormats.length(); i++) {
                JSONObject format = adaptiveFormats.getJSONObject(i);
                String type = format.optString("type", "");
                
                // Look for audio-only formats
                if (type.startsWith("audio/")) {
                    int bitrate = format.optInt("bitrate", 0);
                    
                    if (bitrate > bestBitrate) {
                        bestBitrate = bitrate;
                        bestAudio = format;
                    }
                }
            }
            
            if (bestAudio == null) {
                Log.d(TAG, "No audio format found in adaptive formats");
                return null;
            }
            
            String audioUrl = bestAudio.optString("url", "");
            String mimeType = bestAudio.optString("type", "audio/webm").split(";")[0].trim();
            
            if (audioUrl.isEmpty()) {
                return null;
            }
            
            Log.d(TAG, "Found audio URL! Bitrate: " + bestBitrate + ", via: " + instance);
            
            JSObject result = new JSObject();
            result.put("videoId", videoId);
            result.put("title", title);
            result.put("author", author);
            result.put("duration", duration);
            result.put("audioUrl", audioUrl);
            result.put("mimeType", mimeType);
            result.put("bitrate", bestBitrate);
            result.put("expiresAt", new java.util.Date(System.currentTimeMillis() + 4 * 60 * 60 * 1000).toString());
            result.put("via", instance);
            
            return result;
            
        } catch (Exception e) {
            Log.e(TAG, "Failed to parse Invidious response", e);
            return null;
        }
    }
    
    /**
     * Try direct YouTube URL extraction using signature deciphering
     * This is a simplified version - for production, use yt-dlp binary
     */
    private JSObject tryDirectExtraction(String videoId) {
        // For now, return null to fall through to error
        // In a full implementation, you would:
        // 1. Fetch the video page HTML
        // 2. Extract the player config JSON
        // 3. Parse streaming URLs and decipher signatures
        // This is complex and better handled by yt-dlp
        return null;
    }
}