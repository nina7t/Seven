# Projet Sevenz - App de musique YouTube

## Contexte

Application web (HTML/CSS/JS) transformée en app Android via Capacitor. L'app permet de rechercher et écouter de la musique via YouTube.

## Problème à résoudre

**Le player YouTube s'arrête quand on quitte l'app ou éteint l'écran.**

L'app utilise le player YouTube IFrame API pour lire la musique. Quand l'utilisateur quitte l'app ou éteint l'écran, le WebView se ferme et la musique s'arrête.

## Ce qui a été essayé

1. **Media Session API** - Affiche les contrôles dans la notification mais n'empêche pas l'arrêt
2. **Capacitor Keep Awake plugin** - Empêche l'écran de s'éteindre mais pas la fermeture du WebView
3. **Wake Lock natif dans MainActivity.java** - Garde le CPU actif mais le player s'arrête quand même
4. **Foreground Service permissions** - AndroidManifest mis à jour avec FOREGROUND_SERVICE et WAKE_LOCK

## Stack technique

- **Frontend** : HTML/CSS/JS vanilla (index.html ~6500 lignes)
- **Mobile** : Capacitor pour Android APK
- **Backend proxy** : Node.js/Express sur Render.com (seven-hjai.onrender.com)
- **APIs** : YouTube Data API v3 (avec 5 clés pour 50K req/jour), Invidious (actuellement HS)
- **Auth** : Firebase Auth
- **Notifications** : Media Session API

## Code pertinent

### Player YouTube (index.html ~ligne 3257)
```javascript
window.onYouTubeIframeAPIReady = function() {
  S.player = new YT.Player('yt-player', {
    height: '0', width: '0',
    playerVars: { autoplay: 0, playsinline: 1, controls: 0, disablekb: 1, fs: 0, modestbranding: 1 },
    events: {
      onReady() { restorePlayerState(); },
      onStateChange(e) {
        if (e.data === YT.PlayerState.PLAYING) {
          S.isPlaying = true;
          enableKeepAwake();
          updateMediaSession(S.currentTrack);
        }
      }
    }
  });
};
```

### MainActivity.java (Wake Lock)
```java
@Override
public void onPause() {
    super.onPause();
    PowerManager powerManager = (PowerManager) getSystemService(POWER_SERVICE);
    if (powerManager != null) {
        wakeLock = powerManager.newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK,
            "Sevenz:AudioWakeLock"
        );
        if (!wakeLock.isHeld()) {
            wakeLock.acquire(10 * 60 * 60 * 1000L);
        }
    }
}
```

### AndroidManifest.xml
```xml
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK" />
<uses-permission android:name="android.permission.WAKE_LOCK" />
```

## Question

Comment faire pour que la musique continue de jouer en arrière-plan quand l'utilisateur quitte l'app ? Les apps comme MusicFly+ ou YouTube Music (crackées) y arrivent — elles extraient le stream audio et le jouent dans un player natif.

Quelles solutions techniques recommandes-tu ?