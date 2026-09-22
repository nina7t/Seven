package com.sevenz.app;

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
import androidx.annotation.OptIn;
import androidx.core.app.NotificationCompat;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media.session.MediaButtonReceiver;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.DefaultLoadControl;
import androidx.media3.exoplayer.LoadControl;

import com.bumptech.glide.Glide;
import com.bumptech.glide.request.target.CustomTarget;
import com.bumptech.glide.request.transition.Transition;
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
    private static final String ACTION_ABORT_CROSSFADE = "com.sevenz.app.ABORT_CROSSFADE";
    private static final String ACTION_SEEK = "com.sevenz.app.SEEK";
    
    // ── Architecture DOUBLE LECTEUR (vrai crossfade avec chevauchement) ──
    // Deux ExoPlayer : `player` (ce qu'on entend, pilote notif/MediaSession/position)
    // et `nextPlayer` (piste suivante, préparée en avance, muette, en pause).
    //
    // Une première tentative de double lecteur avait échoué (saccades, lecteur promu
    // IDLE). Les deux causes sont traitées ici :
    //   1. FOCUS AUDIO — les deux lecteurs sont construits avec
    //      setAudioAttributes(attrs, handleAudioFocus=false) : Media3 passe alors null
    //      à son AudioFocusManager, donc aucun des deux ne demande ni n'abandonne le
    //      focus. Plus de bagarre possible, le service reste seul maître.
    //   2. SACCADES — le 2e flux se mettait à bufferiser PILE au moment du fondu, en
    //      concurrence réseau avec le 1er. `nextPlayer` est maintenant préparé
    //      REQUEST_NEXT_LEAD_MS avant l'entrée dans la fenêtre de fondu, playWhenReady
    //      à false : il a le temps de remplir son buffer au calme. Au moment du fondu
    //      il ne reste que du décodage, ce qui ne coûte quasi rien.
    //
    // Repli : si `nextPlayer` n'est pas READY à l'entrée dans la fenêtre (extraction
    // lente, réseau coupé), on retombe sur l'ancien chemin éprouvé — simple fondu de
    // sortie puis avance normale via STATE_ENDED -> JS. Jamais de blocage.
    private ExoPlayer activePlayer;  // alias du player actif (compat)

    // Lecteur de la piste suivante, préparé à l'avance et silencieux jusqu'au fondu.
    private ExoPlayer nextPlayer;
    private String nextVideoId = "";
    private String nextTitle = "";
    private String nextArtist = "";
    private String nextThumb = "";

    // true entre le démarrage du chevauchement et la promotion de nextPlayer.
    // Pendant ce laps, STATE_ENDED du lecteur sortant doit être IGNORÉ : sinon le JS
    // avancerait la file une 2e fois et relancerait la piste depuis le début.
    private boolean crossfadeRunning = false;

    private String currentVideoId = "";
    private String currentTitle = "";
    private String currentArtist = "";
    private String currentThumb = "";
    private Bitmap currentArtwork = null;
    private PowerManager.WakeLock wakeLock;
    private MediaSessionCompat mediaSession;

    // Dernière position connue, mise à jour sur le main thread par updatePlaybackState().
    // Exposée au plugin (donc au JS) pour alimenter la barre de progression en natif.
    private static volatile long lastPositionMs = 0;
    private static volatile long lastDurationMs = 0;
    private static volatile boolean lastIsPlaying = false;

    public static double getLastPositionSec() { return lastPositionMs / 1000.0; }
    public static double getLastDurationSec() { return lastDurationMs / 1000.0; }
    public static boolean isLastPlaying() { return lastIsPlaying; }

    // État du service exposé au plugin : on évite de le démarrer sans raison
    // quand l’utilisateurice règle le crossfade avant la première lecture
    // (Android 12+ tue un foreground service lancé sans startForeground).
    private static volatile boolean serviceRunning = false;
    public static boolean isRunning() { return serviceRunning; }
    private static volatile int pendingCrossfadeMs = -1;
    public static void setPendingCrossfade(int ms) { pendingCrossfadeMs = ms; }

    private void applyPendingCrossfade() {
        int ms = pendingCrossfadeMs;
        if (ms >= 0) {
            pendingCrossfadeMs = -1;
            setCrossfade(ms);
        }
    }
    
    // ── Réglages de fondu (mono-lecteur) ──
    private int crossfadeDuration = 0;          // durée du fondu en ms, 0 = désactivé
    private boolean fadeOutStarted = false;      // true pendant la rampe de sortie
    private boolean nextTrackRequested = false;  // true une fois la suivante demandée au JS
    private Runnable fadeRunnable = null;        // rampe de volume en cours
    // Chaque rampe capture le numéro de génération courant ; toute annulation
    // l'incrémente, ce qui tue proprement une rampe orpheline sans avoir à comparer
    // des références de lecteurs (qui changent justement au moment de la promotion).
    private int fadeGeneration = 0;

    // Le player courant a-t-il besoin d'un fondu d'ENTRÉE quand il deviendra READY ?
    // Posé à true lors d'un playAudio() déclenché par une avance avec fondu activé.
    private boolean pendingFadeIn = false;

    // Durée du fondu d'ENTRÉE (court : démarrage doux sans retarder la lecture).
    private static final long FADE_IN_MS = 1200;

    // Pas de la rampe de volume (~25 màj/s : imperceptible à l'oreille, coût nul).
    private static final long FADE_STEP_MS = 40;

    // Demande la suivante au JS bien avant la fin : extraction NewPipe (réseau, 1-3s)
    // PUIS bufferisation du 2e lecteur. C'est cette marge qui évite les saccades.
    private static final long REQUEST_NEXT_LEAD_MS = 14000;
    private static final long CROSSFADE_CHECK_INTERVAL_MS = 300;

    private final Handler progressHandler = new Handler(Looper.getMainLooper());
    private final Handler crossfadeHandler = new Handler(Looper.getMainLooper());
    private final Handler fadeHandler = new Handler(Looper.getMainLooper());

    private final Runnable updateProgressRunnable = new Runnable() {
        @Override
        public void run() {
            if (player != null && player.isPlaying()) {
                updatePlaybackState();
                progressHandler.postDelayed(this, 500);
            }
        }
    };

    private final Runnable crossfadeCheckRunnable = new Runnable() {
        @Override
        public void run() {
            checkCrossfadeTrigger();
            // En pause, inutile de sonder : la surveillance est relancée par
            // onIsPlayingChanged / resumeAudio dès que la lecture repart.
            if (player != null && crossfadeDuration > 0 && player.isPlaying()) {
                crossfadeHandler.postDelayed(this, CROSSFADE_CHECK_INTERVAL_MS);
            }
        }
    };
    
    @Override
    public void onCreate() {
        super.onCreate();
        serviceRunning = true;
        createNotificationChannel();
        acquireWakeLock();
        initMediaSession();
        applyPendingCrossfade();
    }
    
    private void initMediaSession() {
        mediaSession = new MediaSessionCompat(this, "SevenzMedia");
        // SANS ce callback, les contrôles de la notification système MediaSession
        // (lecture/pause, suivant/précédent, barre de progression sur l'écran verrouillé
        // et le volet "Contenu dynamique") n'avaient aucun effet hors de l'app.
        mediaSession.setFlags(MediaSessionCompat.FLAG_HANDLES_MEDIA_BUTTONS | MediaSessionCompat.FLAG_HANDLES_TRANSPORT_CONTROLS);
        mediaSession.setCallback(new MediaSessionCompat.Callback() {
            @Override public void onPlay() { resumeAudio(); }
            @Override public void onPause() { pauseAudio(); }
            @Override public void onStop() { stopAudio(); }
            @Override public void onSkipToNext() { nextTrack(); }
            @Override public void onSkipToPrevious() { previousTrack(); }
            @Override public void onFastForward() { forward(10000); }
            @Override public void onRewind() { rewind(10000); }
            @Override public void onSeekTo(long pos) { seekTo(pos); }
        });
        mediaSession.setActive(true);
    }
    
    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        android.util.Log.d("AudioService", "onStartCommand called, intent=" + (intent != null ? "not null" : "null"));

        if (intent == null) {
            android.util.Log.d("AudioService", "Intent is null, returning START_NOT_STICKY");
            return START_NOT_STICKY;
        }

        if (Intent.ACTION_MEDIA_BUTTON.equals(intent.getAction())) {
            MediaButtonReceiver.handleIntent(mediaSession, intent);
            return START_STICKY;
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
                String playVideoId = intent.getStringExtra("videoId");
                currentTitle = intent.getStringExtra("title");
                currentArtist = intent.getStringExtra("artist");
                currentThumb = intent.getStringExtra("thumb");
                android.util.Log.d("AudioService", "PLAY action - URL: " + (url != null ? "present (" + url.length() + " chars)" : "NULL"));
                playAudio(url);
                // Après playAudio(), qui remet currentVideoId à vide.
                currentVideoId = playVideoId != null ? playVideoId : "";
                break;
            case ACTION_PAUSE:
                android.util.Log.d("AudioService", "PAUSE action");
                // Track intent even if the track is still being extracted/loaded,
                // so playAudio() doesn't auto-start once the player becomes ready.
                shouldAutoPlay = false;
                if (player != null) {
                    pauseAudio();
                }
                break;
            case ACTION_RESUME:
                android.util.Log.d("AudioService", "RESUME action");
                shouldAutoPlay = true;
                if (player != null) {
                    resumeAudio();
                }
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
            case ACTION_SEEK:
                long seekMs = intent.getLongExtra("positionMs", 0);
                android.util.Log.d("AudioService", "SEEK action: " + seekMs + "ms");
                seekTo(seekMs);
                break;
            case ACTION_SET_CROSSFADE:
                int durationMs = intent.getIntExtra("durationMs", 0);
                android.util.Log.d("AudioService", "SET_CROSSFADE: " + durationMs + "ms");
                setCrossfade(durationMs);
                break;
            case ACTION_LOAD_NEXT:
                android.util.Log.d("AudioService", "LOAD_NEXT action");
                prepareNextPlayer(
                    intent.getStringExtra("url"),
                    intent.getStringExtra("videoId"),
                    intent.getStringExtra("title"),
                    intent.getStringExtra("artist"),
                    intent.getStringExtra("thumb")
                );
                break;
            case ACTION_ABORT_CROSSFADE:
                // Le JS signale que l'utilisateur a repris la main.
                android.util.Log.d("AudioService", "ABORT_CROSSFADE action");
                abortCrossfade();
                break;
        }
        
        return START_STICKY;
    }
    
    // Single player for stable playback (crossfade disabled)
    private ExoPlayer player;
    // Set false by a PAUSE that arrives while still extracting/loading,
    // so the upcoming track doesn't auto-start once the player is ready.
    private volatile boolean shouldAutoPlay = true;
    
    private void playAudio(String url) {
        android.util.Log.d("AudioService", "playAudio called, URL: " + (url != null ? url.substring(0, Math.min(50, url.length())) + "..." : "NULL"));

        if (url == null || url.isEmpty()) {
            android.util.Log.e("AudioService", "URL is null or empty, cannot play");
            return;
        }
        
        // stopAudio() libère la MediaSession et la met à null. Si le service est
        // réutilisé avant sa destruction effective, onCreate() n'est pas rejoué :
        // sans cette recréation, updatePlaybackState() sortirait aussitôt et la barre
        // de progression (alimentée par lastPositionMs) resterait figée à 0.
        if (mediaSession == null) initMediaSession();

        currentVideoId = "";

        // CRITICAL: Must call startForeground within 5 seconds of service start
        // Start with placeholder notification immediately
        startForeground(NOTIFICATION_ID, buildNotification());
        android.util.Log.d("AudioService", "startForeground called immediately");
        
        // Une nouvelle lecture (choix utilisateur, skip, avance de repli) invalide
        // tout chevauchement et toute piste suivante déjà préparée.
        abortCrossfade();
        cancelFade();

        // Stop any existing playback
        if (player != null) {
            player.stop();
            player.release();
        }

        // Create new player
        player = createSimpleExoPlayer();
        activePlayer = player;

        // Si le fondu est activé, la piste démarrera en fondu d'ENTRÉE (volume 0->1)
        // une fois READY. Sinon volume plein immédiat (comportement historique).
        boolean fadeIn = crossfadeDuration > 0 && shouldAutoPlay;
        pendingFadeIn = fadeIn;

        try {
            android.util.Log.d("AudioService", "Setting media item and preparing...");
            MediaItem mediaItem = MediaItem.fromUri(url);
            player.setMediaItem(mediaItem);
            player.setVolume(fadeIn ? 0f : 1.0f);
            player.setPlayWhenReady(shouldAutoPlay);
            shouldAutoPlay = true; // consumed; default back to auto-play for the next track
            player.prepare();

            // Load artwork (updates notification when ready)
            loadArtwork(currentThumb);
            startProgressUpdates();
            // (Re)démarre la surveillance de fondu pour cette nouvelle piste.
            startCrossfadeMonitoring();

        } catch (Exception e) {
            android.util.Log.e("AudioService", "Error playing audio", e);
        }
    }
    
    @OptIn(markerClass = UnstableApi.class)
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
        
        // Référence à soi-même : permet au listener de vérifier qu'il s'agit bien
        // du player ACTIF (et pas d'un ancien player déjà retiré).
        final ExoPlayer[] selfRef = new ExoPlayer[1];
        // IMPORTANT : on NE gère PAS le focus audio explicitement (comportement
        // historique stable). `handleAudioFocus=true` faisait pauser/reprendre le
        // player tout seul sur les changements de focus -> bouton play et timeline
        // désynchronisés. Avec un seul lecteur, ce focus explicite est inutile.
        ExoPlayer newPlayer = new ExoPlayer.Builder(this)
            .setLoadControl(loadControl)
            .build();
        AudioAttributes audioAttributes = new AudioAttributes.Builder()
            .setUsage(C.USAGE_MEDIA)
            .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
            .build();
        newPlayer.setAudioAttributes(audioAttributes, false);
        newPlayer.setHandleAudioBecomingNoisy(true);
        // WAKE_MODE_NETWORK pose un WakeLock CPU *et* un WifiLock. Le service
        // tenait déjà le CPU, mais rien ne gardait la radio Wi-Fi active : en
        // veille profonde, l'extraction réseau de la piste suivante pouvait
        // échouer sans bruit sur certains appareils.
        newPlayer.setWakeMode(C.WAKE_MODE_NETWORK);
        selfRef[0] = newPlayer;

        newPlayer.addListener(new Player.Listener() {
            @Override
            public void onPlaybackStateChanged(int playbackState) {
                if (selfRef[0] != player) return; // ignore un ancien player
                android.util.Log.d("AudioService", "Playback state: " + playbackState);

                // Fondu d'ENTRÉE : la piste vient d'être bufferisée et démarre à vol 0.
                if (playbackState == Player.STATE_READY && pendingFadeIn) {
                    pendingFadeIn = false;
                    startFadeIn();
                }

                if (playbackState == Player.STATE_ENDED) {
                    // Chevauchement en cours : la piste sortante a fini pendant le fondu,
                    // c'est normal. La promotion est pilotée par la fin de la rampe —
                    // surtout ne pas prévenir le JS, il avancerait la file deux fois.
                    if (crossfadeRunning) {
                        android.util.Log.d("AudioService", "STATE_ENDED pendant le fondu -> ignoré");
                        return;
                    }

                    // La suivante est prête mais le fondu n'a pas pu démarrer à temps
                    // (extraction tardive) : on bascule quand même tout de suite, ce qui
                    // évite l'aller-retour réseau par le JS et donc le blanc entre titres.
                    if (nextPlayer != null && nextPlayer.getPlaybackState() == Player.STATE_READY) {
                        android.util.Log.d("AudioService", "Track ended - suivante prête, bascule directe");
                        cancelFade();
                        // Différé d'un tour de boucle : promoteNextPlayer() libère ce
                        // lecteur-ci, or on est en train d'itérer sur SES listeners.
                        crossfadeHandler.post(new Runnable() {
                            @Override public void run() { promoteNextPlayer(); }
                        });
                        return;
                    }

                    android.util.Log.d("AudioService", "Track ended - notifying JS");
                    // Le fondu de sortie a déjà ramené le volume à ~0 ; on libère la rampe.
                    cancelFade();
                    releaseNextPlayer();
                    AudioPlayerPlugin.notifyTrackEnded(getApplicationContext());
                }
            }

            // Le lecteur PRINCIPAL n'avait aucun gestionnaire d'erreur : une URL
            // refusée (403 sur lien périmé) le faisait passer en STATE_IDLE et non
            // STATE_ENDED, donc le JS n'était jamais prévenu — silence définitif,
            // sans même une ligne de log.
            @Override
            public void onPlayerError(androidx.media3.common.PlaybackException error) {
                if (selfRef[0] != player) return;
                android.util.Log.e("AudioService", "Lecteur principal en erreur: "
                    + error.getErrorCodeName(), error);
                // L'URL est probablement morte : ne pas la resservir depuis le cache.
                AudioPlayerPlugin.invalidateUrl(currentVideoId);
                AudioPlayerPlugin.notifyPlaybackError(currentVideoId, error.getErrorCodeName());
            }

            @Override
            public void onIsPlayingChanged(boolean isPlaying) {
                if (selfRef[0] != player) return;
                android.util.Log.d("AudioService", "isPlaying: " + isPlaying);
                // Les deux boucles s'arrêtent d'elles-mêmes quand la lecture cesse :
                // les relancer ici couvre TOUS les chemins de reprise (notification,
                // casque, JS, promotion). Sans le startProgressUpdates(), une bascule
                // sur un lecteur pas encore "isPlaying" figeait la position remontée
                // au JS, donc la barre de progression. Les deux appels sont idempotents.
                if (isPlaying) {
                    startCrossfadeMonitoring();
                    startProgressUpdates();
                }
                updatePlaybackState();
                updateNotification();
                AudioPlayerPlugin.notifyPlaybackStateChanged(isPlaying);
            }
        });

        return newPlayer;
    }
    
    // ══════════════════════════════════════════════════════════════
    // FONDU MONO-LECTEUR (fade-out de fin + fade-in de début)
    // Toutes ces méthodes tournent sur le MAIN THREAD (handlers main looper).
    //
    // Principe : UN seul ExoPlayer. On NE joue PAS deux flux en même temps
    // (c'était la cause des saccades / du focus disputé / du "promu KO").
    //  - Quand on approche de la fin du titre : rampe de volume 1->0 (fade-out)
    //    sur la fenêtre configurée, et on demande la suivante au JS (extraction).
    //  - À STATE_ENDED : avance NORMALE (notifyTrackEnded -> playNext), fiable.
    //  - Quand le nouveau player devient READY : rampe 0->1 (fade-in court).
    // Ce n'est pas un overlap parfait mais c'est FLUIDE, STABLE, et la suivante
    // démarre TOUJOURS (on réutilise le chemin d'avance déjà éprouvé).
    // ══════════════════════════════════════════════════════════════

    private void setCrossfade(int durationMs) {
        if (durationMs < 0) durationMs = 0;
        crossfadeDuration = durationMs;
        android.util.Log.d("AudioService", "setCrossfade: " + durationMs + "ms");
        if (crossfadeDuration > 0) {
            startCrossfadeMonitoring();
        } else {
            // Désactivation : on stoppe la surveillance, on annule tout fondu en cours
            // et on REMET le volume à fond (sinon le titre courant resterait baissé).
            stopCrossfadeMonitoring();
            abortCrossfade();
            cancelFade();
            if (player != null) {
                try { player.setVolume(1f); } catch (Exception ignored) {}
            }
        }
    }

    private void startCrossfadeMonitoring() {
        crossfadeHandler.removeCallbacks(crossfadeCheckRunnable);
        if (crossfadeDuration > 0 && player != null) {
            crossfadeHandler.postDelayed(crossfadeCheckRunnable, CROSSFADE_CHECK_INTERVAL_MS);
        }
    }

    private void stopCrossfadeMonitoring() {
        crossfadeHandler.removeCallbacks(crossfadeCheckRunnable);
    }

    private void checkCrossfadeTrigger() {
        if (crossfadeDuration <= 0 || player == null) return;
        if (!player.isPlaying()) return;

        long duration = player.getDuration();
        long position = player.getCurrentPosition();
        // Durée inconnue (live / pas encore connue) -> pas de fondu possible.
        if (duration <= 0) return;

        // Clamp : sur un titre plus court que le fondu, on limite la fenêtre à la
        // moitié du titre pour ne pas fondre quasi tout le morceau.
        long effectiveCf = Math.min(crossfadeDuration, Math.max(0, duration / 2));
        if (effectiveCf <= 0) return;

        long remaining = duration - position;

        // Filet de sécurité : on est sorti de la fenêtre de fondu alors qu'une rampe
        // de sortie avait démarré (durée réévaluée par ExoPlayer, seek non passé par
        // seekTo...). Sans ça le titre resterait muet jusqu'à la fin.
        if (fadeOutStarted) {
            if (remaining > effectiveCf + 1500) cancelFadeRestoreVolume();
            return;
        }

        // 1) Demander la suivante au JS, assez tôt pour l'extraction réseau.
        //    (Le JS la met en cache via preload ; l'avance réelle reste sur trackEnded.)
        if (!nextTrackRequested && remaining <= effectiveCf + REQUEST_NEXT_LEAD_MS) {
            nextTrackRequested = true;
            android.util.Log.d("AudioService", "Fade: requesting next track (remaining=" + remaining + "ms)");
            AudioPlayerPlugin.notifyRequestNextTrack(getApplicationContext());
        }

        // 2) Entrée dans la fenêtre de fondu.
        if (remaining <= effectiveCf) {
            if (nextPlayer != null && nextPlayer.getPlaybackState() == Player.STATE_READY) {
                // Cas nominal : la suivante est bufferisée -> VRAI crossfade.
                startRealCrossfade(remaining);
            } else {
                // Repli : suivante pas prête. Simple fondu de sortie, puis avance
                // normale par STATE_ENDED -> JS (chemin historique, toujours fiable).
                android.util.Log.d("AudioService", "Fondu: suivante pas prête -> repli fondu de sortie");
                startFadeOut(remaining);
            }
        }
    }

    // ══════════════════════════════════════════════════════════════
    // 2e LECTEUR : préparation, chevauchement, promotion
    // ══════════════════════════════════════════════════════════════

    // Prépare la piste suivante dans un lecteur séparé : muet, en pause, mais en train
    // de bufferiser. Appelé bien avant la fenêtre de fondu (voir REQUEST_NEXT_LEAD_MS).
    private void prepareNextPlayer(String url, String videoId, String title, String artist, String thumb) {
        if (url == null || url.isEmpty()) {
            android.util.Log.w("AudioService", "prepareNextPlayer: URL vide, ignoré");
            return;
        }
        if (crossfadeDuration <= 0) return;            // fondu désactivé entre-temps
        if (crossfadeRunning) return;                  // chevauchement déjà en cours

        releaseNextPlayer();                           // idempotent

        nextVideoId = videoId != null ? videoId : "";
        nextTitle  = title  != null ? title  : "";
        nextArtist = artist != null ? artist : "";
        nextThumb  = thumb  != null ? thumb  : "";

        try {
            final ExoPlayer np = createSimpleExoPlayer();
            nextPlayer = np;

            // Listener dédié au rôle "suivante" : il se neutralise tout seul dès que
            // np n'est plus nextPlayer (donc après promotion ou libération).
            np.addListener(new Player.Listener() {
                @Override
                public void onPlayerError(androidx.media3.common.PlaybackException error) {
                    if (np != nextPlayer) return;
                    android.util.Log.e("AudioService", "nextPlayer en erreur -> abandon du chevauchement", error);
                    AudioPlayerPlugin.notifyCrossfadeDebug("suivante KO -> repli");
                    // CRUCIAL : sortir du chevauchement IMMÉDIATEMENT. Si
                    // `crossfadeRunning` restait à true, le STATE_ENDED de la sortante
                    // serait avalé par sa garde, la promotion sortirait à vide, et plus
                    // aucun événement n'atteindrait le JS : la lecture s'arrêterait
                    // pour de bon. Ces lignes ne sont que des écritures de champs et un
                    // setVolume sur l'AUTRE lecteur : sans danger depuis ce callback.
                    stopFadeRamp();
                    crossfadeRunning = false;
                    fadeOutStarted = false;
                    nextTrackRequested = false;
                    pendingFadeIn = false;
                    if (player != null) {
                        try { player.setVolume(1f); } catch (Exception ignored) {}
                    }

                    // La libération, elle, est différée d'un tour de boucle : on est
                    // dans le listener de CE lecteur, et le release() d'un ExoPlayer
                    // pendant l'itération de ses propres listeners n'est pas sûr.
                    // On le détache tout de suite pour que plus personne ne l'utilise.
                    final ExoPlayer dead = np;
                    nextPlayer = null;
                    crossfadeHandler.post(new Runnable() {
                        @Override public void run() {
                            try { dead.release(); } catch (Exception ignored) {}
                        }
                    });
                }
            });

            np.setMediaItem(MediaItem.fromUri(url));
            np.setVolume(0f);            // silencieux jusqu'au fondu
            np.setPlayWhenReady(false);  // bufferise sans jouer
            np.prepare();

            android.util.Log.d("AudioService", "nextPlayer préparé: " + nextTitle);
            AudioPlayerPlugin.notifyCrossfadeDebug("suivante préparée");
        } catch (Exception e) {
            android.util.Log.e("AudioService", "prepareNextPlayer a échoué", e);
            releaseNextPlayer();
        }
    }

    // Libère le lecteur "suivante" sans toucher au lecteur courant.
    private void releaseNextPlayer() {
        if (nextPlayer == null) return;
        ExoPlayer np = nextPlayer;
        nextPlayer = null;   // mis à null AVANT release : neutralise les listeners
        try { np.stop(); } catch (Exception ignored) {}
        try { np.release(); } catch (Exception ignored) {}
        android.util.Log.d("AudioService", "nextPlayer libéré");
    }

    // Démarre le VRAI chevauchement : les deux lecteurs jouent ensemble le temps du
    // fondu, en rampes complémentaires, puis nextPlayer devient le lecteur courant.
    private void startRealCrossfade(long remainingMs) {
        if (crossfadeRunning || fadeOutStarted) return;
        if (player == null || nextPlayer == null) return;

        final ExoPlayer out = player;
        final ExoPlayer in  = nextPlayer;

        // Le fondu ne peut pas durer plus que ce qu'il reste de piste sortante.
        long dur = Math.max(500, Math.min(crossfadeDuration, remainingMs));

        crossfadeRunning = true;
        fadeOutStarted = true;  // bloque tout autre déclenchement sur cette piste

        try {
            in.setVolume(0f);
            in.play();
        } catch (Exception e) {
            android.util.Log.e("AudioService", "Impossible de démarrer la suivante -> repli", e);
            crossfadeRunning = false;
            fadeOutStarted = false;
            releaseNextPlayer();
            startFadeOut(remainingMs);
            return;
        }

        android.util.Log.d("AudioService", "VRAI crossfade sur " + dur + "ms");
        AudioPlayerPlugin.notifyCrossfadeDebug("crossfade " + (dur / 1000.0) + "s");

        startVolumeRamp(out, in, dur, new Runnable() {
            @Override public void run() { promoteNextPlayer(); }
        });
    }

    // nextPlayer devient le lecteur courant : on bascule métadonnées, notification,
    // MediaSession et position, on libère l'ancien, et on prévient le JS pour qu'il
    // avance l'index de sa file (listener `trackChanged` -> commitCrossfadeAdvance).
    private void promoteNextPlayer() {
        if (nextPlayer == null) {
            // Rien à promouvoir (suivante tombée en erreur juste avant). Si la piste
            // courante est déjà finie, personne d'autre ne préviendra le JS : on le
            // fait ici, sinon la lecture resterait muette indéfiniment.
            crossfadeRunning = false;
            if (player != null && player.getPlaybackState() == Player.STATE_ENDED) {
                android.util.Log.w("AudioService", "Promotion à vide sur piste finie -> trackEnded de secours");
                cancelFade();
                AudioPlayerPlugin.notifyTrackEnded(getApplicationContext());
            }
            return;
        }

        // Intention de lecture AVANT bascule : si quelque chose a mis la lecture en
        // pause pendant le chevauchement (casque débranché -> becomingNoisy agit
        // directement sur le lecteur, sans passer par pauseAudio), il ne faut
        // surtout pas redémarrer tout seul dans le haut-parleur.
        final boolean wasPlaying = (player == null) || player.getPlayWhenReady();

        ExoPlayer old = player;
        player = nextPlayer;
        nextPlayer = null;
        activePlayer = player;
        crossfadeRunning = false;

        // L'ancien lecteur est retiré AVANT release : son listener, qui teste
        // `selfRef[0] != player`, devient inerte et ne peut plus notifier le JS.
        if (old != null) {
            try { old.stop(); } catch (Exception ignored) {}
            try { old.release(); } catch (Exception ignored) {}
        }

        currentVideoId = nextVideoId;
        currentTitle   = nextTitle;
        currentArtist  = nextArtist;
        currentThumb   = nextThumb;
        // On GARDE l'ancienne pochette jusqu'à l'arrivée de la nouvelle : la mettre
        // à null ferait clignoter l'écran verrouillé le temps du chargement Glide.

        try {
            player.setVolume(1f);
            if (wasPlaying) player.play();   // no-op si le chevauchement l'avait démarré
            else player.pause();             // pause externe pendant le fondu : on la respecte
        } catch (Exception ignored) {}

        // Réarme les drapeaux pour que la piste promue puisse à son tour enchaîner.
        stopFadeRamp();
        fadeOutStarted = false;
        nextTrackRequested = false;
        pendingFadeIn = false;

        android.util.Log.d("AudioService", "Promotion -> " + currentTitle);
        AudioPlayerPlugin.notifyCrossfadeDebug("bascule: " + currentTitle);

        loadArtwork(currentThumb);       // rafraîchit la notification à l'arrivée
        updatePlaybackState();
        updateNotification();
        startProgressUpdates();
        startCrossfadeMonitoring();

        // Aucun onIsPlayingChanged ne sera émis (le lecteur promu jouait déjà) :
        // il faut donc pousser l'état au JS à la main.
        AudioPlayerPlugin.notifyPlaybackStateChanged(wasPlaying);
        AudioPlayerPlugin.notifyTrackChanged(getApplicationContext(), currentVideoId);
    }

    // Abandonne un chevauchement en cours et revient proprement au lecteur courant
    // à plein volume (pause, seek, nouvelle piste choisie par l'utilisateur...).
    private void abortCrossfade() {
        stopFadeRamp();
        crossfadeRunning = false;
        releaseNextPlayer();
        // Réarmer l'état de fondu, sinon après une pause en plein chevauchement
        // fadeOutStarted resterait à true : la piste finirait sans aucun fondu ET
        // aucune suivante ne serait re-préparée pour la transition d'après.
        fadeOutStarted = false;
        nextTrackRequested = false;
        pendingFadeIn = false;
        if (player != null) {
            try { player.setVolume(1f); } catch (Exception ignored) {}
        }
    }

    // Rampe de volume DESCENDANTE sur le seul player actif, calée sur le temps
    // restant réel pour atteindre ~0 pile à la fin du titre.
    private void startFadeOut(long remainingMs) {
        if (fadeOutStarted || player == null) return;
        fadeOutStarted = true;   // NE PAS appeler cancelFade() ensuite : il remettrait
                                 // ce drapeau à false et la rampe repartirait de zéro
                                 // toutes les 300 ms (fondu inaudible + spam du JS).

        final ExoPlayer fp = player;
        float startVol;
        try { startVol = fp.getVolume(); } catch (Exception e) { startVol = 1f; }
        if (startVol <= 0.01f) startVol = 1f; // sécurité

        long dur = Math.max(200, remainingMs); // au moins 200ms de rampe
        android.util.Log.d("AudioService", "startFadeOut over " + dur + "ms (from vol=" + startVol + ")");
        AudioPlayerPlugin.notifyCrossfadeDebug("fade-out " + (dur / 1000.0) + "s");

        startVolumeRamp(fp, null, dur, null);
        // Pas de watchdog nécessaire : STATE_ENDED déclenche l'avance quoi qu'il arrive.
    }

    // Rampe de volume MONTANTE au démarrage d'une nouvelle piste (fade-in court).
    private void startFadeIn() {
        if (player == null) return;
        final ExoPlayer fp = player;
        android.util.Log.d("AudioService", "startFadeIn over " + FADE_IN_MS + "ms");
        AudioPlayerPlugin.notifyCrossfadeDebug("fade-in " + (FADE_IN_MS / 1000.0) + "s");

        startVolumeRamp(null, fp, FADE_IN_MS, null);
    }

    // Rampe de volume maison (Handler + horloge) plutôt que ValueAnimator :
    // ValueAnimator est soumis à l'ÉCHELLE D'ANIMATION SYSTÈME (options dev réglées
    // sur "Désactivée", mode économie de batterie sur beaucoup de ROMs) -> la durée
    // devient 0 et le fondu se transforme en coupure sèche. Un Handler ignore ça.
    //
    // UNE seule rampe pilote les DEUX lecteurs, ce qui garantit que les deux courbes
    // restent exactement complémentaires (pas de dérive entre deux timers séparés).
    //   out : volume -> 0   suivant cos(t*pi/2)
    //   in  : volume -> 1   suivant sin(t*pi/2)
    // Courbe "equal power" et non linéaire : cos²+sin²=1, donc la puissance sonore
    // totale reste constante pendant tout le fondu — c'est ce qui évite le creux
    // au milieu qu'on entend avec deux rampes linéaires.
    //
    // `out` ou `in` peut être null : fondu de sortie seul, ou d'entrée seul.
    private void startVolumeRamp(final ExoPlayer out, final ExoPlayer in,
                                 long durationMs, final Runnable onComplete) {
        stopFadeRamp();
        final long dur = Math.max(50, durationMs);
        final long startAt = android.os.SystemClock.uptimeMillis();
        final float outFrom;
        if (out != null) {
            float v;
            try { v = out.getVolume(); } catch (Exception e) { v = 1f; }
            outFrom = (v <= 0.01f) ? 1f : v;
        } else {
            outFrom = 1f;
        }

        // Génération capturée : toute annulation (nouvelle rampe, abandon, nouvelle
        // piste) l'incrémente et cette rampe-ci s'arrête d'elle-même au tick suivant.
        final int gen = ++fadeGeneration;

        fadeRunnable = new Runnable() {
            @Override
            public void run() {
                if (gen != fadeGeneration) return;   // rampe périmée

                float t = (android.os.SystemClock.uptimeMillis() - startAt) / (float) dur;
                if (t >= 1f) {
                    if (out != null) { try { out.setVolume(0f); } catch (Exception ignored) {} }
                    if (in  != null) { try { in.setVolume(1f);  } catch (Exception ignored) {} }
                    fadeRunnable = null;
                    if (onComplete != null) onComplete.run();
                    return;
                }

                double angle = t * Math.PI / 2.0;
                if (out != null) {
                    float v = clamp01((float) (outFrom * Math.cos(angle)));
                    try { out.setVolume(v); } catch (Exception ignored) {}
                }
                if (in != null) {
                    float v = clamp01((float) Math.sin(angle));
                    try { in.setVolume(v); } catch (Exception ignored) {}
                }
                fadeHandler.postDelayed(this, FADE_STEP_MS);
            }
        };
        fadeHandler.post(fadeRunnable);
    }

    private static float clamp01(float v) {
        return v < 0f ? 0f : (v > 1f ? 1f : v);
    }

    // Arrête la rampe en cours SANS toucher aux drapeaux ni au volume atteint.
    private void stopFadeRamp() {
        fadeGeneration++;   // invalide la rampe éventuellement en vol
        if (fadeRunnable != null) {
            fadeHandler.removeCallbacks(fadeRunnable);
            fadeRunnable = null;
        }
    }

    // Annule toute rampe de volume en cours ET réarme les drapeaux de fondu.
    // À n'appeler QUE sur un vrai changement d'état (nouvelle piste, seek, stop,
    // désactivation du fondu) — jamais depuis startFadeOut/startFadeIn.
    // Ne touche PAS à nextPlayer ni à crossfadeRunning : c'est le rôle
    // d'abortCrossfade(), pour que les deux responsabilités restent séparées.
    private void cancelFade() {
        stopFadeRamp();
        fadeOutStarted = false;
        nextTrackRequested = false;
        pendingFadeIn = false;
    }

    private void loadArtwork(String thumbUrl) {
        if (thumbUrl == null || thumbUrl.isEmpty()) {
            currentArtwork = null;
            updateNotification(); // Update with placeholder
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
                    updateNotification(); // Update with artwork
                }
                
                @Override
                public void onLoadCleared(@Nullable Drawable placeholder) {}
                
                @Override
                public void onLoadFailed(@Nullable Drawable errorDrawable) {
                    currentArtwork = null;
                    updateNotification(); // Update without artwork
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

        // Cache des valeurs pour le plugin/JS (lecture thread-safe via volatile)
        lastPositionMs = position;
        long dur = player.getDuration();
        lastDurationMs = dur > 0 ? dur : 0;
        lastIsPlaying = isPlaying;

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
    
    // Un seek manuel pendant un fade-out doit annuler la rampe et restaurer le volume,
    // sinon l'utilisateur reviendrait en arrière sur un son baissé/muet.
    private void cancelFadeRestoreVolume() {
        if (crossfadeRunning) {
            // Chevauchement réellement en cours : la position change sous nos pieds,
            // on l'abandonne complètement.
            abortCrossfade();
        } else {
            // Simple rampe (ou rien) : on l'annule SANS toucher à nextPlayer. Le
            // détruire à chaque ±10s gâcherait les 14s de marge de préparation et
            // ferait retomber la transition suivante sur le repli.
            stopFadeRamp();
            fadeOutStarted = false;
            pendingFadeIn = false;
            if (nextPlayer == null) nextTrackRequested = false;
        }
        if (player != null) {
            try { player.setVolume(1f); } catch (Exception ignored) {}
        }
    }

    private void rewind(long ms) {
        if (player != null) {
            cancelFadeRestoreVolume();
            long newPos = Math.max(0, player.getCurrentPosition() - ms);
            player.seekTo(newPos);
            updatePlaybackState();
            updateNotification();
        }
    }

    private void forward(long ms) {
        if (player != null) {
            cancelFadeRestoreVolume();
            long newPos = Math.min(player.getDuration(), player.getCurrentPosition() + ms);
            player.seekTo(newPos);
            updatePlaybackState();
            updateNotification();
        }
    }

    private void seekTo(long ms) {
        if (player != null) {
            cancelFadeRestoreVolume();
            long dur = player.getDuration();
            long target = ms < 0 ? 0 : (dur > 0 ? Math.min(dur, ms) : ms);
            player.seekTo(target);
            updatePlaybackState();
            updateNotification();
        }
    }

    private void pauseAudio() {
        // Pendant un chevauchement, `player` est encore la piste SORTANTE : la mettre
        // seule en pause laisserait la piste entrante jouer toute seule. On abandonne
        // donc le chevauchement (retour au lecteur courant à plein volume) avant.
        if (crossfadeRunning) abortCrossfade();
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
        stopCrossfadeMonitoring();
        cancelFade();
        crossfadeRunning = false;
        releaseNextPlayer();
        lastIsPlaying = false;
        lastPositionMs = 0;

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
        prevIntent.putExtra("action", ACTION_PREV);
        PendingIntent prevPendingIntent = PendingIntent.getService(
            this, 1, prevIntent, PendingIntent.FLAG_IMMUTABLE
        );

        // Rewind 10s action
        Intent rewindIntent = new Intent(this, AudioService.class);
        rewindIntent.putExtra("action", ACTION_REWIND);
        PendingIntent rewindPendingIntent = PendingIntent.getService(
            this, 2, rewindIntent, PendingIntent.FLAG_IMMUTABLE
        );

        // Play/Pause action
        String playPauseAction = isPlaying ? ACTION_PAUSE : ACTION_RESUME;
        int playPauseIcon = isPlaying ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play;
        Intent playPauseIntent = new Intent(this, AudioService.class);
        playPauseIntent.putExtra("action", playPauseAction);
        PendingIntent playPausePendingIntent = PendingIntent.getService(
            this, 3, playPauseIntent, PendingIntent.FLAG_IMMUTABLE
        );

        // Forward 10s action
        Intent forwardIntent = new Intent(this, AudioService.class);
        forwardIntent.putExtra("action", ACTION_FORWARD);
        PendingIntent forwardPendingIntent = PendingIntent.getService(
            this, 4, forwardIntent, PendingIntent.FLAG_IMMUTABLE
        );

        // Next action
        Intent nextIntent = new Intent(this, AudioService.class);
        nextIntent.putExtra("action", ACTION_NEXT);
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
            .addAction(android.R.drawable.ic_media_next, "Next", nextPendingIntent);

        // mediaSession peut être null si une notification est reconstruite après
        // stopAudio()/onDestroy() (race avec le runnable de progression) -> évite un NPE.
        androidx.media.app.NotificationCompat.MediaStyle mediaStyle =
            new androidx.media.app.NotificationCompat.MediaStyle()
                .setShowActionsInCompactView(0, 2, 4);
        if (mediaSession != null) {
            mediaStyle.setMediaSession(mediaSession.getSessionToken());
        }
        builder.setStyle(mediaStyle);

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
        stopCrossfadeMonitoring();
        cancelFade();
        crossfadeRunning = false;
        releaseNextPlayer();

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
        serviceRunning = false;
        super.onDestroy();
    }
    
    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
    
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // User swiped the app away — keep audio playing in the background.
        // The foreground service is explicitly designed for this: do NOT stop audio here.
        android.util.Log.d("AudioService", "onTaskRemoved — keeping audio alive");
    }
}