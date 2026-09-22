package com.sevenz.app.plugin;

import android.content.Intent;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import com.sevenz.app.AudioService;
import com.sevenz.app.plugin.DownloaderImpl;
import com.sevenz.app.resolver.NewPipeResolver;

import org.schabi.newpipe.extractor.NewPipe;
import org.schabi.newpipe.extractor.services.youtube.YoutubeService;
import org.schabi.newpipe.extractor.stream.AudioStream;
import org.schabi.newpipe.extractor.stream.StreamInfo;

import java.util.Comparator;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

@CapacitorPlugin(name = "AudioPlayerPlugin")
public class AudioPlayerPlugin extends Plugin {
    
    private static final String TAG = "AudioPlayerPlugin";
    public static final String ACTION_PLAY = "com.sevenz.app.PLAY";
    public static final String ACTION_PAUSE = "com.sevenz.app.PAUSE";
    public static final String ACTION_RESUME = "com.sevenz.app.RESUME";
    public static final String ACTION_STOP = "com.sevenz.app.STOP";
    
    // Static instance for AudioService callbacks
    private static volatile AudioPlayerPlugin instance;

    // ══════════════════════════════════════════════════════════════
    // FILE D'ATTENTE NATIVE
    // ══════════════════════════════════════════════════════════════
    // Écran verrouillé, Android met la WebView en retrait : l'événement
    // `trackEnded` part bien du service, mais le JS qui devait répondre en
    // appelant playVideo() ne s'exécute plus. La musique s'arrêtait donc à la
    // fin de chaque morceau, et il fallait rouvrir l'app.
    //
    // Le JS pousse désormais à l'avance les prochaines pistes DÉJÀ RÉSOLUES
    // (videoId connu). En fin de piste, le natif se sert lui-même dans cette
    // file : plus aucun aller-retour JavaScript sur le chemin critique.
    static final class Upcoming {
        final String videoId, title, artist, thumb;
        Upcoming(String v, String t, String a, String th) {
            videoId = v; title = t; artist = a; thumb = th;
        }
    }

    private static final java.util.ArrayDeque<Upcoming> upcoming = new java.util.ArrayDeque<>();

    /** Remplace la file native. Appelé par le JS tant qu'il est vivant. */
    @PluginMethod
    public void setUpcoming(PluginCall call) {
        com.getcapacitor.JSArray arr = call.getArray("tracks");
        synchronized (upcoming) {
            upcoming.clear();
            if (arr != null) {
                try {
                    java.util.List<Object> items = arr.toList();
                    for (Object o : items) {
                        if (!(o instanceof org.json.JSONObject)) continue;
                        org.json.JSONObject j = (org.json.JSONObject) o;
                        String id = j.optString("videoId", "");
                        if (id.isEmpty()) continue;   // non résolue : inutile ici
                        upcoming.add(new Upcoming(
                            id,
                            j.optString("title", "Unknown"),
                            j.optString("artist", "Unknown Artist"),
                            j.optString("thumb", "")));
                    }
                } catch (Exception e) {
                    Log.e(TAG, "setUpcoming: file illisible", e);
                }
            }
            Log.d(TAG, "File native : " + upcoming.size() + " piste(s) d'avance");
        }
        call.resolve();
    }
    
    @Override
    public void load() {
        instance = this;
    }

    @PluginMethod
    public void openAudioSettings(PluginCall call) {
        try {
            Intent intent = new Intent(Settings.ACTION_BLUETOOTH_SETTINGS);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("Unable to open audio settings", e);
        }
    }
    
    public static void notifyNextTrack(android.content.Context context) {
        if (instance != null) {
            // Le JS écoute "skipNext" (et non "next") -> sinon le bouton suivant
            // de la notification/MediaSession ne déclenchait rien hors de l'app.
            instance.notifyListeners("skipNext", new JSObject());
        }
    }

    public static void notifyPreviousTrack(android.content.Context context) {
        if (instance != null) {
            instance.notifyListeners("skipPrevious", new JSObject());
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
        // D'abord tenter l'avance SANS le JS : c'est tout l'intérêt: écran
        // verrouillé, personne ne répondrait à l'événement ci-dessous.
        if (advanceNatively(context)) return;

        // File vide (ou plus rien à jouer) : on retombe sur le chemin
        // historique, qui suppose une WebView vivante.
        if (instance != null) {
            instance.notifyListeners("trackEnded", new JSObject());
        }
    }

    /**
     * Joue la piste suivante de la file native. Renvoie false si la file est
     * vide — l'appelant retombe alors sur l'ancien chemin via le JS.
     */
    private static boolean advanceNatively(android.content.Context context) {
        final Upcoming next;
        synchronized (upcoming) {
            next = upcoming.poll();
        }
        if (next == null) return false;
        if (context == null) return false;

        Log.d(TAG, "Avance native vers : " + next.title);
        final android.content.Context app = context.getApplicationContext();

        // URL déjà en cache : départ immédiat, aucune latence.
        String cached = getFreshUrl(next.videoId);
        if (cached != null) {
            sendPlay(app, next, cached);
            return true;
        }

        // Sinon extraction sur un thread — le service tient le CPU éveillé
        // pendant ce temps grâce à son WakeLock.
        new Thread(() -> {
            try {
                if (NewPipe.getDownloader() == null) {
                    NewPipe.init(DownloaderImpl.getInstance());
                }
                StreamInfo info = StreamInfo.getInfo("https://www.youtube.com/watch?v=" + next.videoId);
                AudioStream best = info.getAudioStreams().stream()
                    .max(Comparator.comparingInt(AudioStream::getAverageBitrate))
                    .orElse(null);
                if (best == null) {
                    Log.e(TAG, "Avance native : aucun flux audio pour " + next.videoId);
                    // Piste injouable : on tente la suivante plutôt que de
                    // laisser le silence s'installer.
                    if (!advanceNatively(app) && instance != null) {
                        instance.notifyListeners("trackEnded", new JSObject());
                    }
                    return;
                }
                putUrl(next.videoId, best.getUrl());
                sendPlay(app, next, best.getUrl());
            } catch (Exception e) {
                Log.e(TAG, "Avance native : extraction échouée pour " + next.videoId, e);
                if (!advanceNatively(app) && instance != null) {
                    instance.notifyListeners("trackEnded", new JSObject());
                }
            }
        }).start();
        return true;
    }

    /** Commande la lecture au service, puis informe le JS de ce qui tourne. */
    private static void sendPlay(android.content.Context app, Upcoming t, String url) {
        Intent intent = new Intent(app, AudioService.class);
        intent.putExtra("action", ACTION_PLAY);
        intent.putExtra("url", url);
        intent.putExtra("videoId", t.videoId);
        intent.putExtra("title", t.title);
        intent.putExtra("artist", t.artist);
        intent.putExtra("thumb", t.thumb);
        // Le service tourne déjà en foreground (la lecture précédente vient de
        // s'achever) : startService suffit et évite le démarrage d'un second.
        // En cas de refus (service mort entre-temps, restriction Android 12+),
        // mieux vaut repasser la main au JS que laisser le silence s'installer.
        try {
            app.startService(intent);
        } catch (Exception e) {
            Log.e(TAG, "Avance native : service injoignable", e);
            if (instance != null) instance.notifyListeners("trackEnded", new JSObject());
            return;
        }

        // `trackChanged` et non `trackEnded` : le JS n'a qu'à resynchroniser son
        // index quand il se réveillera, surtout pas à relancer une lecture.
        notifyTrackChanged(app, t.videoId);
    }
    
    public static void notifyRequestNextTrack(android.content.Context context) {
        if (instance != null) {
            instance.notifyListeners("requestNextTrack", new JSObject());
        }
    }
    
    // `videoId` = piste RÉELLEMENT promue par le natif. Sans lui, le JS devait
    // deviner laquelle en se fiant à un index posé ~20s plus tôt, et se trompait
    // dès que la file avait bougé entre-temps.
    public static void notifyTrackChanged(android.content.Context context, String videoId) {
        if (instance != null) {
            JSObject data = new JSObject();
            data.put("videoId", videoId != null ? videoId : "");
            instance.notifyListeners("trackChanged", data);
        }
    }

    // Canal de debug natif -> JS pour diagnostiquer le crossfade sans adb.
    public static void notifyCrossfadeDebug(String msg) {
        if (instance != null) {
            JSObject data = new JSObject();
            data.put("msg", msg);
            instance.notifyListeners("crossfadeDebug", data);
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

        // Si l'URL a déjà été préchargée (cache rempli par preload/loadNextTrack),
        // on démarre IMMÉDIATEMENT sans ré-extraction réseau (1-3s) -> transition fluide
        // entre les titres (fondu de sortie -> suivante quasi instantanée -> fondu d'entrée).
        String preloaded = getFreshUrl(videoId);
        if (preloaded != null && !preloaded.isEmpty()) {
            Log.d(TAG, "playVideo: URL préchargée en cache -> démarrage immédiat");
            startAudioService(preloaded, title, artist, thumb, videoId);
            JSObject result = new JSObject();
            result.put("success", true);
            result.put("cached", true);
            result.put("message", "Playing (cached): " + title);
            call.resolve(result);
            return;
        }

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
                    getActivity().runOnUiThread(() -> call.reject("No audio available for this video."));
                    return;
                }

                String audioUrl = bestAudio.getUrl();
                int bitrate = bestAudio.getAverageBitrate();

                Log.d(TAG, "Found audio URL! Bitrate: " + bitrate + " URL length: " + audioUrl.length());

                // Start the AudioService with the extracted URL
                startAudioService(audioUrl, title, artist, thumb, videoId);

                getActivity().runOnUiThread(() -> {
                    JSObject result = new JSObject();
                    result.put("success", true);
                    result.put("audioUrl", audioUrl);
                    result.put("bitrate", bitrate);
                    result.put("message", "Playing: " + title);
                    call.resolve(result);
                });

            } catch (Exception e) {
                String errorDetail = e.getClass().getSimpleName() + ": " + (e.getMessage() != null ? e.getMessage() : "no message");
                Log.e(TAG, "Extraction failed: " + errorDetail, e);
                e.printStackTrace();
                getActivity().runOnUiThread(() -> call.reject("Extraction failed: " + errorDetail));
            }
        }).start();
    }
    
    private void startAudioService(String url, String title, String artist, String thumb) {
        startAudioService(url, title, artist, thumb, null);
    }

    // `videoId` permet au service de purger la bonne entrée de cache quand
    // ExoPlayer refuse l'URL (403 sur un lien périmé).
    private void startAudioService(String url, String title, String artist, String thumb, String videoId) {
        Log.d(TAG, "startAudioService called with URL length: " + (url != null ? url.length() : 0));
        
        Intent intent = new Intent(getContext(), AudioService.class);
        intent.putExtra("action", ACTION_PLAY);
        intent.putExtra("url", url);
        intent.putExtra("videoId", videoId != null ? videoId : "");
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
        intent.putExtra("action", ACTION_PAUSE);
        getContext().startService(intent);
        
        JSObject result = new JSObject();
        result.put("success", true);
        call.resolve(result);
    }
    
    @PluginMethod
    public void resume(PluginCall call) {
        Intent intent = new Intent(getContext(), AudioService.class);
        intent.putExtra("action", ACTION_RESUME);
        getContext().startService(intent);
        
        JSObject result = new JSObject();
        result.put("success", true);
        call.resolve(result);
    }
    
    @PluginMethod
    public void stop(PluginCall call) {
        Intent intent = new Intent(getContext(), AudioService.class);
        intent.putExtra("action", ACTION_STOP);
        getContext().startService(intent);
        
        JSObject result = new JSObject();
        result.put("success", true);
        call.resolve(result);
    }
    
    @PluginMethod
    public void isPlaying(PluginCall call) {
        JSObject result = new JSObject();
        result.put("isPlaying", AudioService.isLastPlaying());
        call.resolve(result);
    }

    // Position de lecture courante (en secondes) pour la barre de progression
    @PluginMethod
    public void getPosition(PluginCall call) {
        JSObject result = new JSObject();
        result.put("position", AudioService.getLastPositionSec());
        result.put("duration", AudioService.getLastDurationSec());
        result.put("isPlaying", AudioService.isLastPlaying());
        call.resolve(result);
    }

    // Seek absolu (en secondes)
    @PluginMethod
    public void seekTo(PluginCall call) {
        double seconds = call.getDouble("position", 0.0);
        Intent intent = new Intent(getContext(), AudioService.class);
        intent.putExtra("action", "com.sevenz.app.SEEK");
        intent.putExtra("positionMs", (long) (seconds * 1000));
        getContext().startService(intent);
        call.resolve();
    }

    // URL cache for preloading tracks (accédé depuis plusieurs threads -> thread-safe)
    // Les URLs de flux googlevideo EXPIRENT (quelques heures). Ce cache n'avait
    // aucune péremption : une entrée périmée était resservie telle quelle, ExoPlayer
    // prenait un 403, et — faute de gestionnaire d'erreur — la lecture s'arrêtait
    // sans un mot. C'est la panne « ça marchait hier soir ».
    private static final class CachedUrl {
        final String url; final long expiresAt;
        CachedUrl(String url, long expiresAt) { this.url = url; this.expiresAt = expiresAt; }
    }
    private static final Map<String, CachedUrl> urlCache = new ConcurrentHashMap<>();
    private static final long URL_TTL_FALLBACK_MS = 90 * 60 * 1000L;
    private static final long URL_SAFETY_MARGIN_MS = 5 * 60 * 1000L;
    private static final int URL_CACHE_MAX = 200;

    /** Les URLs googlevideo portent un paramètre `expire=<epoch sec>`. On s'y fie
     *  quand il est lisible, avec une marge ; sinon TTL prudent. */
    private static long computeExpiry(String url) {
        long fallback = System.currentTimeMillis() + URL_TTL_FALLBACK_MS;
        try {
            int i = url.indexOf("expire=");
            if (i < 0) return fallback;
            int end = url.indexOf('&', i);
            String v = end < 0 ? url.substring(i + 7) : url.substring(i + 7, end);
            long expMs = Long.parseLong(v) * 1000L - URL_SAFETY_MARGIN_MS;
            return Math.min(expMs, fallback);
        } catch (Exception e) { return fallback; }
    }

    private static void putUrl(String videoId, String url) {
        if (videoId == null || url == null || url.isEmpty()) return;
        if (urlCache.size() >= URL_CACHE_MAX) urlCache.clear(); // borne mémoire simple
        urlCache.put(videoId, new CachedUrl(url, computeExpiry(url)));
    }

    /** null si absente OU périmée (l'entrée périmée est purgée au passage). */
    private static String getFreshUrl(String videoId) {
        if (videoId == null) return null;
        CachedUrl c = urlCache.get(videoId);
        if (c == null) return null;
        if (System.currentTimeMillis() >= c.expiresAt) { urlCache.remove(videoId); return null; }
        return c.url;
    }

    /** Purge ciblée : appelée quand ExoPlayer refuse une URL (403/410). */
    public static void invalidateUrl(String videoId) {
        if (videoId != null && !videoId.isEmpty()) urlCache.remove(videoId);
    }

    /** Remonte au JS une erreur de LECTURE (distincte d'une erreur d'extraction). */
    public static void notifyPlaybackError(String videoId, String codeName) {
        if (instance == null) return;
        JSObject d = new JSObject();
        d.put("videoId", videoId != null ? videoId : "");
        d.put("name", codeName != null ? codeName : "");
        instance.notifyListeners("playbackError", d);
    }
    
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
        if (getFreshUrl(videoId) != null) {
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
                    putUrl(videoId, bestAudio.getUrl());
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
        
        String cachedUrl = getFreshUrl(videoId);
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
        if (durationMs < 0) durationMs = 0;

        // Mémoriser la valeur pour le prochain démarrage du service ; on ne
        // démarre pas le service juste pour ça, sinon Android 12+ tue le
        // foreground service faute d’appel immédiat à startForeground().
        AudioService.setPendingCrossfade(durationMs);

        // Si le service est déjà en vie (lecture en cours), lui transmettre
        // directement afin que le fondu s’applique au titre courant.
        if (AudioService.isRunning()) {
            Intent intent = new Intent(getContext(), AudioService.class);
            intent.putExtra("action", "com.sevenz.app.SET_CROSSFADE");
            intent.putExtra("durationMs", durationMs);
            getContext().startService(intent);
        }

        JSObject result = new JSObject();
        result.put("durationMs", durationMs);
        call.resolve(result);
    }
    
    @PluginMethod
    public void cancelCrossfade(PluginCall call) {
        Intent intent = new Intent(getContext(), AudioService.class);
        intent.putExtra("action", "com.sevenz.app.ABORT_CROSSFADE");
        getContext().startService(intent);
        call.resolve();
    }

    @PluginMethod
    public void loadNextTrack(PluginCall call) {
        final String videoId = call.getString("videoId");
        final String title = call.getString("title", "Unknown");
        final String artist = call.getString("artist", "Unknown Artist");
        final String thumb = call.getString("thumb", "");
        
        if (videoId == null || videoId.isEmpty()) {
            call.reject("videoId is required");
            return;
        }
        
        // Check cache first
        String cachedUrl = getFreshUrl(videoId);
        if (cachedUrl != null) {
            // Send directly to service
            Intent intent = new Intent(getContext(), AudioService.class);
            intent.putExtra("action", "com.sevenz.app.LOAD_NEXT");
            intent.putExtra("url", cachedUrl);
            intent.putExtra("videoId", videoId);
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
                    putUrl(videoId, audioUrl);
                    
                    // Send to service
                    Intent intent = new Intent(getContext(), AudioService.class);
                    intent.putExtra("action", "com.sevenz.app.LOAD_NEXT");
                    intent.putExtra("url", audioUrl);
                    intent.putExtra("videoId", videoId);
                    intent.putExtra("title", title);
                    intent.putExtra("artist", artist);
                    intent.putExtra("thumb", thumb);
                    getContext().startService(intent);

                    getActivity().runOnUiThread(() -> {
                        JSObject result = new JSObject();
                        result.put("loaded", true);
                        call.resolve(result);
                    });
                } else {
                    getActivity().runOnUiThread(() -> call.reject("No audio stream found"));
                }
            } catch (Exception e) {
                Log.e(TAG, "Error loading next track", e);
                getActivity().runOnUiThread(() -> call.reject("Extraction failed: " + e.getMessage()));
            }
        }).start();
    }

    /**
     * Résout un titre officiel (artiste + titre + durée) en vidéo YouTube fiable.
     * Recherche via NewPipeExtractor, score les candidats et retourne le meilleur.
     * Si fetchAudio=true, extrait également l'URL audio du meilleur candidat.
     * Cette méthode DOIT être appelée depuis l'APK Android (pas sur le web).
     */
    @PluginMethod
    public void resolveTrack(PluginCall call) {
        final String artist = call.getString("artist", "");
        final String title = call.getString("title", "");
        final Integer durationSec = call.getInt("durationSec"); // null si absent
        final boolean fetchAudio = call.getBoolean("fetchAudio", false);

        if (artist.isEmpty() || title.isEmpty()) {
            call.reject("artist and title are required");
            return;
        }

        new Thread(() -> {
            try {
                NewPipeResolver resolver = new NewPipeResolver(artist, title, durationSec);
                NewPipeResolver.ResolvedTrack track = resolver.resolve();

                if (track == null) {
                    getActivity().runOnUiThread(() -> call.reject("No reliable match found"));
                    return;
                }

                String audioUrl = null;
                if (fetchAudio) {
                    audioUrl = track.fetchAudioUrl();
                    if (audioUrl != null && !audioUrl.isEmpty()) {
                        putUrl(track.videoId, audioUrl);
                    }
                }

                final String finalAudioUrl = audioUrl;
                getActivity().runOnUiThread(() -> {
                    JSObject result = new JSObject();
                    result.put("videoId", track.videoId);
                    result.put("title", track.title);
                    result.put("uploader", track.uploader);
                    result.put("durationSec", track.durationSec);
                    result.put("score", track.score);
                    result.put("url", track.url);
                    if (finalAudioUrl != null) {
                        result.put("audioUrl", finalAudioUrl);
                    }
                    call.resolve(result);
                });

            } catch (Exception e) {
                Log.e(TAG, "resolveTrack failed", e);
                final String msg = e.getMessage() != null ? e.getMessage() : "Resolution failed";
                getActivity().runOnUiThread(() -> call.reject("Resolution failed: " + msg));
            }
        }).start();
    }
}