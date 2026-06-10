package com.sevenz.app.plugin;

import android.content.Intent;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;

import com.sevenz.app.AudioService;

public class AudioPlayerPlugin extends Plugin {
    
    public static final String ACTION_PLAY = "com.sevenz.app.PLAY";
    public static final String ACTION_PAUSE = "com.sevenz.app.PAUSE";
    public static final String ACTION_RESUME = "com.sevenz.app.RESUME";
    public static final String ACTION_STOP = "com.sevenz.app.STOP";
    
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
        
        Intent intent = new Intent(getContext(), AudioService.class);
        intent.setAction(ACTION_PLAY);
        intent.putExtra("url", url);
        intent.putExtra("title", title);
        intent.putExtra("artist", artist);
        intent.putExtra("thumb", thumb);
        
        getContext().startForegroundService(intent);
        
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
        // This would need to be implemented with a bound service for accurate state
        JSObject result = new JSObject();
        result.put("isPlaying", false); // Placeholder
        call.resolve(result);
    }
}