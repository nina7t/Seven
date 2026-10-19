package com.sevenz.app;

import android.content.Context;
import android.media.AudioManager;
import android.media.audiofx.BassBoost;
import android.media.audiofx.Equalizer;
import android.util.Log;

/**
 * Égaliseur et renforcement des basses, partagés par tout le processus.
 *
 * Les deux ExoPlayer du fondu enchaîné jouent sur UNE même session audio : les
 * effets Android étant attachés à une session, ils s'appliquent aux deux
 * lecteurs à la fois, sans saut de son au moment de la bascule.
 *
 * Le réglage (activé, gains par bande, basses) est mémorisé ici : il peut être
 * posé avant que le service tourne, et il est réappliqué à chaque création des
 * effets (nouveau service, après un stopAudio).
 */
public final class AudioFx {

    private static final String TAG = "AudioFx";

    // Réglage voulu par l'utilisateur, indépendant de l'existence des effets.
    private static boolean enabled = false;
    private static float[] bandsDb = new float[0];
    private static float bassBoost = 0f;   // 0..1

    private static int sessionId = 0;      // 0 = pas encore générée
    private static Equalizer eq;
    private static BassBoost bb;

    private AudioFx() {}

    /** Session audio commune aux lecteurs, générée une fois par processus. */
    public static synchronized int sessionId(Context context) {
        if (sessionId == 0) {
            AudioManager am = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
            if (am != null) sessionId = am.generateAudioSessionId();
            if (sessionId <= 0) sessionId = 0;
        }
        return sessionId;
    }

    /**
     * Crée les effets sur la session commune (si besoin) et y applique le
     * réglage mémorisé. Appelé par le service avant de lancer un lecteur.
     * Un appareil sans égaliseur n'empêche jamais la lecture.
     */
    public static synchronized void attach(Context context) {
        int session = sessionId(context);
        if (session == 0) return;
        if (eq == null) {
            try { eq = new Equalizer(0, session); }
            catch (Throwable t) { eq = null; Log.w(TAG, "Égaliseur indisponible sur cet appareil", t); }
        }
        if (bb == null) {
            try { bb = new BassBoost(0, session); }
            catch (Throwable t) { bb = null; Log.w(TAG, "Renfort des basses indisponible", t); }
        }
        apply();
    }

    /** Libère les effets (fin de lecture). Le réglage, lui, est conservé. */
    public static synchronized void release() {
        if (eq != null) { try { eq.release(); } catch (Throwable ignored) {} eq = null; }
        if (bb != null) { try { bb.release(); } catch (Throwable ignored) {} bb = null; }
    }

    /** Mémorise le réglage et l'applique tout de suite si les effets existent. */
    public static synchronized void set(boolean on, float[] gainsDb, float boost) {
        enabled = on;
        bandsDb = gainsDb != null ? gainsDb.clone() : new float[0];
        bassBoost = Math.max(0f, Math.min(1f, boost));
        apply();
    }

    // Appelé sous verrou. Les gains sont convertis en millibels et bornés par la
    // plage de l'appareil (souvent ±15 dB, parfois moins).
    private static void apply() {
        if (eq != null) {
            try {
                short[] range = eq.getBandLevelRange();
                short bands = eq.getNumberOfBands();
                for (short b = 0; b < bands; b++) {
                    float db = (enabled && b < bandsDb.length) ? bandsDb[b] : 0f;
                    int mb = Math.round(db * 100f);
                    mb = Math.max(range[0], Math.min(range[1], mb));
                    eq.setBandLevel(b, (short) mb);
                }
                eq.setEnabled(enabled);
            } catch (Throwable t) {
                Log.w(TAG, "Réglage de l'égaliseur refusé", t);
            }
        }
        if (bb != null) {
            try {
                boolean on = enabled && bassBoost > 0f;
                if (bb.getStrengthSupported()) bb.setStrength((short) Math.round(bassBoost * 1000f));
                bb.setEnabled(on);
            } catch (Throwable t) {
                Log.w(TAG, "Réglage des basses refusé", t);
            }
        }
    }

    /** Bandes disponibles, lisibles même si aucun lecteur ne tourne. */
    public static final class Info {
        public boolean available;
        public int[] centerHz = new int[0];
        public float[] minDb = new float[0];
        public float[] maxDb = new float[0];
        public boolean bassBoost;
    }

    public static synchronized Info info(Context context) {
        Info info = new Info();
        // Sans service, on crée un égaliseur temporaire sur la session commune
        // le temps de lire ses bandes. Créer un effet avant le lecteur est le
        // chemin prévu par Android.
        Equalizer e = eq;
        boolean temp = false;
        int session = sessionId(context);
        if (e == null && session != 0) {
            try { e = new Equalizer(0, session); temp = true; } catch (Throwable t) { e = null; }
        }
        if (e != null) {
            try {
                short[] range = e.getBandLevelRange();
                short n = e.getNumberOfBands();
                info.centerHz = new int[n];
                info.minDb = new float[n];
                info.maxDb = new float[n];
                for (short b = 0; b < n; b++) {
                    info.centerHz[b] = e.getCenterFreq(b) / 1000;   // milliHertz -> Hz
                    info.minDb[b] = range[0] / 100f;
                    info.maxDb[b] = range[1] / 100f;
                }
                info.available = n > 0;
            } catch (Throwable t) {
                info.available = false;
            }
            if (temp) { try { e.release(); } catch (Throwable ignored) {} }
        }

        if (bb != null) {
            try { info.bassBoost = bb.getStrengthSupported(); } catch (Throwable t) { info.bassBoost = false; }
        } else if (session != 0) {
            try {
                BassBoost b = new BassBoost(0, session);
                info.bassBoost = b.getStrengthSupported();
                b.release();
            } catch (Throwable t) { info.bassBoost = false; }
        }
        return info;
    }
}
