package com.sevenz.app;

import android.content.Context;

import androidx.annotation.Nullable;
import androidx.annotation.OptIn;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.database.StandaloneDatabaseProvider;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.datasource.cache.CacheDataSource;
import androidx.media3.datasource.cache.LeastRecentlyUsedCacheEvictor;
import androidx.media3.datasource.cache.SimpleCache;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.exoplayer.source.MediaSource;

import java.io.File;

/**
 * Cache disque des flux audio, partagé par tous les ExoPlayer du service.
 *
 * Un seul SimpleCache peut ouvrir un dossier donné : or deux lecteurs
 * coexistent pendant le fondu enchaîné. D'où ce singleton, créé à la demande
 * et jamais libéré (il vit aussi longtemps que le processus).
 *
 * Cache LRU complet plutôt que « début seulement » comme Spotify : ExoPlayer
 * remplit le cache au fil de la lecture, donc borner au début demanderait de
 * couper les requêtes à la main, alors qu'un LRU de 150 Mo garde déjà le début
 * (et le reste) des ~40 derniers titres écoutés sans aucune logique en plus.
 *
 * La clé de cache est le videoId, posée par l'appelant via
 * MediaItem.Builder#setCustomCacheKey : les URLs googlevideo changent à chaque
 * extraction et expirent, une clé par URL ne servirait jamais deux fois.
 */
@OptIn(markerClass = UnstableApi.class)
public final class AudioCache {

    private static final long MAX_BYTES = 150L * 1024 * 1024;

    private static SimpleCache cache;
    private static boolean failed = false;

    private AudioCache() {}

    /** null si le cache n'a pas pu être créé (disque plein, dossier verrouillé…). */
    @Nullable
    private static synchronized SimpleCache get(Context context) {
        if (cache != null || failed) return cache;
        try {
            File dir = new File(context.getApplicationContext().getCacheDir(), "audio");
            cache = new SimpleCache(dir,
                new LeastRecentlyUsedCacheEvictor(MAX_BYTES),
                new StandaloneDatabaseProvider(context.getApplicationContext()));
        } catch (Throwable t) {
            // On ne réessaie pas à chaque piste : la lecture continue sans cache.
            failed = true;
            android.util.Log.w("AudioCache", "Cache audio indisponible, lecture sans cache", t);
        }
        return cache;
    }

    /**
     * Fabrique de sources pour ExoPlayer.Builder#setMediaSourceFactory, ou null
     * pour garder la fabrique par défaut (sans cache).
     */
    @Nullable
    public static MediaSource.Factory mediaSourceFactory(Context context) {
        SimpleCache c = get(context);
        if (c == null) return null;
        CacheDataSource.Factory dataSource = new CacheDataSource.Factory()
            .setCache(c)
            .setUpstreamDataSourceFactory(new DefaultHttpDataSource.Factory()
                .setAllowCrossProtocolRedirects(true))
            // Une erreur de lecture du cache (fichier abîmé) ne doit pas bloquer
            // la piste : on repasse par le réseau.
            .setFlags(CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR);
        return new DefaultMediaSourceFactory(dataSource);
    }
}
