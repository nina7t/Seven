# 🎵 SEVENZ — RECAPITULATIF DU PROJET

**Date du récap :** 22 Juin 2026  
**Repo :** `nina7t/Seven`  
**Stack :** Capacitor 8 + Node.js + AndrJe oid natif + Firebase  
**App :** Lecteur musical YouTube-style (web + Android)

---

## 1. 📱 VUE D'ENSEMBLE

Sevenz est une application musicale hybride (PWA + APK Android) qui permet de :
- Rechercher et écouter de la musique via YouTube
- Gérer une bibliothèque personnelle (favoris, playlists, historique)
- Écouter en arrière-plan sur Android avec notification media
- Télécharger des titres pour le mode offline
- Importer ses playlists Spotify (OAuth)

Le frontend est une SPA monolithique dans `www/index.html` (~7 700 lignes). Le backend est un proxy Node.js dans `server/`.

---

## 2. 🏗️ ARCHITECTURE

```
┌─────────────────────────────────────────┐
│  FRONTEND                               │
│  www/index.html    → SPA + state global │
│  config.js         → clés API locales   │
│  manifest.json     → PWA                  │
│  sw.js             → service worker       │
└─────────────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────┐
│  PROXY SERVEUR                          │
│  server/server.js         → Express API │
│  server/invidious-client.js → fallback  │
│  server/fallback-data.js  → data static  │
│  server/.quota.json       → quota perso  │
└─────────────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────┐
│  ANDROID NATIVE                         │
│  AudioService.java        → audio FG     │
│  AudioPlayerPlugin.java   → bridge Cap.  │
│  YouTubeExtractorPlugin.java → extraction│
│  MainActivity.java        → entry point  │
└─────────────────────────────────────────┘
```

### Endpoints proxy
| Route | Source | Usage |
|-------|--------|-------|
| `/api/search?q=` | Deezer | Métadonnées officielles des titres (recherche) |
| `/api/artist?q=` | Deezer | Artiste + top titres + discographie + similaires |
| `/api/album/:id` | Deezer | Album + tracklist complète |
| `/api/youtube/*` | YouTube Data API v3 | Résolution audio, trending, durées |

**Principe métadonnées → audio** : Deezer fournit les entités officielles (artiste, titre,
album, pochette, durée). Le `videoId` YouTube n'existe pas à l'affichage — il est résolu au
clic via `resolveVideoId()` / `ensureVideoId()`. Une piste en attente a `id: null` + un objet `meta`.

### Dépendances clés
- `@capacitor/core` / `android` / `cli` : v8.4.0
- `@capacitor-community/keep-awake` : écran allumé
- `@capacitor-community/media` : gestion média
- Firebase Auth + Firestore : compte & sync cloud
- YouTube IFrame API : lecteur web

---

## 3. ✅ FONCTIONNALITÉS IMPLÉMENTÉES

### 🎧 Lecture
- Lecture audio web (YouTube IFrame) et natif Android
- Play / Pause / Next / Previous
- Barre de progression cliquable + temps courant/total
- Shuffle (aléatoire)
- Repeat 3 modes : off → all → one (`S.repeat` 0/1/2)
- Préchargement des pistes suivantes (`preloadNext`, `preloadNextForCrossfade`)
- Crossfade natif Android
- Restauration de l'état player après fermeture (10 min)
- Media Session API : contrôles depuis notification / écran verrouillé
- Sleep timer (minuterie d'arrêt)
- Gestion du volume (UI + contrôle natif)

### 🔍 Recherche & Découverte
- Recherche par titre / artiste avec debounce
- Skeleton loading sur les résultats
- Filtrage anti-clips vidéo (`filterAI`)
- Score "officiel" : VEVO / Topic / Official boostés
- Carte artiste via Deezer (photo réelle, nombre de fans) — repli MusicBrainz
- Discographie (albums + singles) via Deezer — repli MusicBrainz + Cover Art Archive
- Nom d'album cliquable dans les résultats → ouvre la page album
- Recommandations basées sur la piste en cours (`loadRecommendedTracks`)
- Catégories de genres (bubbles)
- Fallback Invidious si quota YouTube dépassé
- Cache YouTube avec TTL 6h (`_ytCache`)

### 🎤 Pages Artiste & Album (Sept. 2026)
- **Nom d'artiste cliquable partout** : résultats de recherche, pistes de playlist, titres likés, cartes accueil, barre de lecture, lecteur plein écran, vue Albums, bibliothèque
- Nettoyage des noms de chaînes YouTube avant navigation (`Stromae - Topic`, `StromaeVEVO` → `Stromae`)
- **Page artiste** : bandeau photo, nombre de fans, titres populaires avec durées, sections Albums / Singles et EP (avec « Tout afficher »), « Les fans aiment aussi » (rebond vers un autre artiste)
- **Page album** : pochette, artiste cliquable, année, nombre de titres, durée totale, tracklist complète, badge explicite, label et date de sortie
- Les deux pages s'intègrent au routing SPA (`spaBack` / `spaForward` / bouton retour Android)

### 📚 Bibliothèque
- Titres likés (favoris)
- Création / édition / suppression de playlists
- Ajout / retrait de titres dans une playlist
- Couverture custom pour les playlists
- Vue détail playlist
- Historique d'écoute
- Vue Artistes / Albums
- Filtres bibliothèque (Tout / Playlists)
- Import playlists Spotify via OAuth
- Import playlists Deezer par lien public ou profil entier (aucune connexion requise)

### ☁️ Compte & Sync
- Authentification Firebase (email / password / OAuth)
- Sync cloud Firestore (favoris, playlists, historique)
- Profil utilisateur
- Onboarding sélection artistes

### 📱 Mobile / UX
- Dark theme
- Navigation SPA avec back/forward
- Bottom nav mobile
- Pull-to-refresh
- Vibration au tap (`navigator.vibrate`)
- Toast notifications
- PWA installable (manifest + sw.js)
- Mode offline : sauvegarde IndexedDB d'un titre
- File d'attente visible (Queue Manager latéral)

---

## 4. 🔧 BUGS CORRIGÉS / AMÉLIORATIONS RÉCENTES

| ID | Problème | Fichier | Statut |
|----|----------|---------|--------|
| BUG-001 | Notification pause/resume ne fonctionnait pas | `AudioService.java` | ✅ Fixé (intents via `putExtra`) |
| BUG-002 | Intents inconsistants dans `AudioPlayerPlugin` | `AudioPlayerPlugin.java` | ✅ Fixé |
| BUG-006 | `AsyncTask` déprécié Android 11+ | `YouTubeExtractorPlugin.java` | ✅ Remplacé par `ExecutorService` |
| BUG-004 | Quota API non persistant | `server/server.js` | ✅ Sauvegardé dans `.quota.json` toutes les 30s |
| UX-001 | Pas de feedback de chargement | `www/index.html` | ✅ `showLoadingState()` + spinner |
| UX-002 | Saut de contenu recherche | `www/index.html` | ✅ `renderSearchSkeleton()` |
| PERF-001 | Latence lecture | `www/index.html` | ✅ Préload 3 pistes à l'avance |
| FEAT-001 | Queue Manager invisible | `www/index.html` | ✅ Drawer latéral avec liste `S.queue` |
| FEAT-002 | Repeat modes | `www/index.html` | ✅ off / all / one |
| FEAT-003 | Sleep timer | `www/index.html` | ✅ Programmation d'arrêt |
| FEAT-004 | Volume fonctionnel | `www/index.html` | ✅ Connecté au player natif + MediaSession |
| FEAT-005 | Pas de navigation par artiste/album (façon Spotify) | `index.html` + `server/server.js` | ✅ Pages artiste & album Deezer + liens cliquables partout |
| BUG-007 | « Angèle » ouvrait un homonyme à 13 fans au lieu de l'artiste à 1,7 M | `server/server.js` | ✅ Résolution classée par justesse du nom **puis** notoriété |
| BUG-008 | Albums en double dans la discographie (rééditions Deezer) | `server/server.js` | ✅ `dedupeReleases()` garde l'édition de référence |
| FEAT-006 | Pas d'import pour les utilisateurs Deezer | `index.html` + `server/server.js` | ✅ Import par lien de playlist ou par profil (lot), sans clé ni OAuth |
| BUG-009 | Pochettes de playlist jamais affichées | `index.html` | ✅ `style="…url(\"…\")…"` → `url('…')` en 7 endroits |
| BUG-010 | Suite de lecture hors-sujet (rap après un titre 80s) | `server/server.js` + `index.html` | ✅ Graine = label YouTube → radio Deezer par artiste |
| BUG-011 | Même titre répété en plusieurs formats | `index.html` | ✅ `dedupeTracks()` sur titre normalisé |
| BUG-012 | Onboarding : que du rap, et sans photos | `index.html` + `server/server.js` | ✅ 15 genres, recherche libre, photos Deezer |

---

## 5. ❌ CE QUI MANQUE ENCORE

### Manques critiques / importants
- **Paroles synchronisées (Lyrics)** — Spotify-like karaoke
- **File d'attente modifiable** — visible mais pas réordonnable par drag
- **Mode Radio** — `openRadio()` est encore un stub "à venir"
- **Partage de piste** — bouton présent mais non connecté à `navigator.share()`
- **Batch download** — offline uniquement piste par piste
- **Gestion des doublons** — bloqué mais sans message explicite
- **Smart playlists automatiques** — "Découvertes de la semaine" etc.

### Améliorations futures
- Égaliseur (Web Audio API)
- Stats d'écoute personnelles (Wrapped)
- Playlists collaboratives / partage par lien
- Section "Nouveautés / Sorties récentes"
- Tests unitaires (Jest / JUnit)
- Service Worker complet pour offline avancé
- Sentry / Firebase Crashlytics pour le monitoring
- Modularisation du gros `index.html` en composants ES6

---

## 6. 📁 FICHIERS CLÉS

| Fichier | Rôle |
|---------|------|
| `/Applications/MAMP/htdocs/spoti/www/index.html` | Frontend principal (~7 700 lignes) |
| `/Applications/MAMP/htdocs/spoti/server/server.js` | Proxy API Express |
| `/Applications/MAMP/htdocs/spoti/server/invidious-client.js` | Client fallback Invidious |
| `/Applications/MAMP/htdocs/spoti/server/fallback-data.js` | Données fallback statiques |
| `/Applications/MAMP/htdocs/spoti/android/app/src/main/java/com/sevenz/app/AudioService.java` | Service audio foreground Android |
| `/Applications/MAMP/htdocs/spoti/android/app/src/main/java/com/sevenz/app/AudioPlayerPlugin.java` | Bridge Capacitor audio |
| `/Applications/MAMP/htdocs/spoti/android/app/src/main/java/com/sevenz/app/YouTubeExtractorPlugin.java` | Extraction URL audio YouTube |
| `/Applications/MAMP/htdocs/spoti/capacitor.config.json` | Configuration Capacitor |
| `/Applications/MAMP/htdocs/spoti/manifest.json` | PWA |
| `/Applications/MAMP/htdocs/spoti/sw.js` | Service worker |
| `/Applications/MAMP/htdocs/spoti/config.js` | Configuration API locale (gitignored) |
| `/Applications/MAMP/htdocs/spoti/package.json` | Dépendances Capacitor |
| `/Applications/MAMP/htdocs/spoti/server/package.json` | Dépendances serveur |

---

## 7. 📊 SCORES (depuis les audits)

| Domaine | Score Actuel | Commentaire |
|---------|--------------|-------------|
| Lecture & Player | 8/10 | Repeat modes, queue, preload OK |
| Recherche | 9/10 | Cache, MusicBrainz, fallback |
| Bibliothèque | 8/10 | Playlists, favoris, historique |
| Découverte | 7/10 | Manque Radio et Nouveautés |
| UX Mobile | 8/10 | Quelques boutons encore à câbler |
| Social | 2/10 | Aucune feature sociale |
| **Global** | **7.3/10** | Application fonctionnelle et stable |

---

## 8. 🚀 PROCHAINES PRIORITÉS SUGGÉRÉES

1. **Quick wins** (< 1h) : connecter le partage, message "déjà dans la playlist", stub Radio
2. **Sprint** (2-4h) : queue réordonnable, batch download, stats d'écoute
3. **Gros sujets** : lyrics (LRCLib), égaliseur, nouveautés artistes, modularisation frontend

---

## 9. 📝 JOURNAL

### 17 septembre 2026 — Retours d'une première utilisatrice

Une amie de Nina a essuyé les plâtres sur un téléphone neuf. Quatre problèmes,
trois causes distinctes.

**1. L'onboarding ne proposait que du rap**
`ARTIST_DB` comptait 53 entrées, presque toutes rap / trap / R&B / afro, et
`INITIAL_GENRES` n'en tirait que ces genres. Qui écoute du rock ou de la variété
n'avait littéralement rien à cocher, et aucun moyen de chercher ailleurs.
→ `ARTIST_DB_EXTRA` ajoute rock, années 80, chanson française, pop internationale,
metal, jazz, latino, reggae ; `INITIAL_GENRES` couvre 15 genres.
→ Champ de recherche pour choisir **n'importe quel** artiste (validation explicite,
jamais pendant la frappe).

**2. Les artistes n'avaient pas de visuel**
2 entrées sur 53 portaient une image : le reste s'affichait en dégradé avec des
initiales. → `GET /api/deezer/artists?names=a|b|c` résout les photos chez Deezer
au rendu. 30/30 avec photo réelle.

**3. Après un titre des années 80, la suite passait en rap** ← le vrai morceau de bravoure
`relatedToVideoId` a été supprimé de l'API YouTube en août 2023. Le contournement
en place prenait le **nom de la chaîne YouTube** comme graine de recommandation.
Or cette chaîne est très souvent le **label**, pas l'artiste : pour
« Smalltown Boy » de Bronski Beat, c'est `London Records`. La suite devenait donc
le catalogue du label — interviews et clips TV compris — et du rap dès que le
label en publie.
→ `GET /api/deezer/radio?artist=` s'appuie sur `/artist/{id}/radio` de Deezer :
25 titres partant de l'artiste réel, sans clé ni OAuth. YouTube ne sert plus que
de repli. Vérifié : après Smalltown Boy viennent Pet Shop Boys, Art of Noise,
Eurythmics, The Cure.

**4. Le même titre revenait en plusieurs formats (47 Ter)**
Même cause : YouTube renvoie « L'adresse (Clip Officiel) » *et* « L'adresse ».
→ `dedupeTracks()` / `trackTitleKey()` normalisent le titre (accents, parenthèses,
« Clip Officiel », « Remaster », « Radio Edit »…) avant d'empiler la file.

**Bonus** : le classement nom-puis-notoriété de `resolveDeezerArtist` est extrait
en `rankArtistMatches()` et sert aussi à la recherche libre — sans lui,
« Indochine » remontait « Mount Indochina » et « Indorphine » avant le groupe.

**Ce que permettent (et ne permettent pas) les autres services**
| Service | Titres liés | Diffusion audio |
|---------|-------------|-----------------|
| **Deezer** | ✅ `/artist/{id}/radio`, sans clé ni OAuth | ❌ extraits de 30 s seulement |
| Spotify | ❌ `/recommendations` et `related-artists` supprimés le 27/11/2024 pour toute nouvelle app (403) | ❌ SDK + abonnement de l'auditeur |
| Tidal | ✅ via leur API | ❌ le Player SDK est le **seul** moyen autorisé, et il exige un abonnement Tidal côté auditeur |
| Last.fm | ✅ déjà branché, sert de second repli | ❌ métadonnées uniquement |

À noter : `/genre/{id}/artists` et `/chart/{genre}/artists` de Deezer renvoient le
même top global quel que soit le genre — inutilisables pour bâtir une grille par
genre, d'où la liste curée côté app.

**Vérifié au navigateur (desktop + Pixel 7)** : 20 contrôles verts — pages artiste
et album, import de playlist, pochettes, titres liés sans rap, déduplication,
onboarding (30 photos, genres variés, recherche à validation explicite), aucun
débordement horizontal, aucune erreur JS.

---

### 11 septembre 2026 — Import de playlists Deezer

**Objectif** : qu'une amie sur Deezer puisse verser ses playlists dans l'app.

**Pourquoi pas d'équivalent Exportify** : l'API publique Deezer ne demande ni clé
ni OAuth. Le lien de la playlist suffit, tant qu'elle est publique. (Exportify
existe parce que Spotify impose un token même pour une playlist publique.)

**Backend — `server/server.js`**
- `GET /api/deezer/playlist?url=` → playlist + tracklist complète. Accepte une URL
  complète, avec préfixe de langue (`/fr/playlist/…`) ou un identifiant nu.
- `GET /api/deezer/profile?url=` → playlists publiques d'un profil, pour l'import en lot.
- Cache 1 h. `deezerGetRaw()` ajouté à côté de `deezerGet()` : les handlers d'import
  ont besoin de lire l'erreur Deezer pour formuler leur propre message.

**Frontend — `index.html`**
- Bouton « Importer Deezer » dans l'en-tête Playlists + entrée dans le menu mobile.
- Modale à deux onglets : **Une playlist** (coller un lien) et **Tout un profil**
  (cases à cocher, « Tout sélectionner », import séquentiel).
- `createPlaylistFromSpotifyData()` généralisée en `createPlaylistFromImport(data, source)` —
  Spotify et Deezer renvoient la même forme.
- Les pistes arrivent avec `id: null` + `meta` : `playTrack()` délègue à `resolveAndPlay()`,
  donc la résolution YouTube se fait au premier clic, pas à l'import.

**Deux pièges de l'API Deezer**
- La tracklist incluse dans `/playlist/{id}` est **tronquée à 400 titres, sans champ
  `next`** : une playlist de 636 titres en perdrait 236 en silence. On passe toujours
  par `/playlist/{id}/tracks?index=&limit=` (vérifié : 636/636 en 7 pages).
- Les erreurs arrivent en **HTTP 200** avec `{"error":{"code":800}}` dans le corps.
  Tester le statut ne suffit pas.

**Bug corrigé au passage — voir BUG-009**
La pochette des playlists ne s'affichait nulle part. Sept endroits construisaient
`style="…url("…")…"` : le navigateur ferme l'attribut au premier guillemet interne et
perd l'image. Invisible jusqu'ici (peu de playlists avec pochette), flagrant dès que
chaque playlist importée en a une. Corrigé partout en `url('…')` — `cssUrl()` échappe
déjà les apostrophes.

**Régression mobile corrigée** : l'ajout d'un troisième bouton rognait « Nouvelle
playlist ». L'en-tête passe en colonne sur téléphone (titre puis rangée de boutons
défilante).

**Vérifié au navigateur (desktop + Pixel 7 + iPhone SE)**
- Import par lien (76 titres) et import groupé depuis un profil (3 playlists d'un coup)
- Chaîne de lecture complète : clic → résolution → videoId chargé → barre de lecture à jour
- Message d'erreur explicite sur playlist privée, profil inexistant, lien d'un autre service
- Pochettes et vignettes affichées, aucun débordement horizontal
- Non-régression des pages artiste/album de l'entrée précédente

**Non testé** : la lecture audio réelle (pas de `server/.env` avec clé YouTube en local).

> ⚠️ Comme l'entrée précédente : **ces routes n'existent que sur le serveur local**
> tant que Render n'est pas redéployé.

---

### 11 septembre 2026 — Navigation artiste & album (façon Spotify)

**Objectif** : pouvoir cliquer sur un artiste ou sur le nom d'une musique pour retrouver
ses œuvres et ses albums.

**Backend — `server/server.js`**
- `GET /api/artist?q=<nom>` → `{ artist, topTracks, albums, related }`. Les trois volets
  (top / albums / similaires) partent en parallèle et échouent indépendamment : un volet
  KO ne vide pas la page.
- `GET /api/album/:id` → `{ album, artist, tracks }` avec la tracklist complète. La
  pochette de l'album est recopiée sur chaque piste (Deezer ne la fournit pas par piste).
- `albumId` ajouté aux résultats de `/api/search` → nom d'album cliquable en recherche.
- Cache `node-cache` 24 h sur les deux nouvelles routes. Aucune clé API requise.

**Frontend — `index.html`**
- Helpers : `cleanArtistName()`, `attrEnc()`, `artistLinkInline()`, `setArtistField()`.
- `fetchArtistData()` interroge Deezer en priorité, retombe sur YouTube + MusicBrainz.
- Nouvelle vue `album` (`#albumView`) enregistrée dans `ALL_VIEWS` + `applyView()`.
- Code mort retiré : `renderArtistCard`, `countryFlag`, `openArtistPageCurrent`,
  `_lastSearchArtist`.

**Pièges rencontrés**
- `encodeURIComponent` n'encode **pas** l'apostrophe → `L'Impératrice` cassait la chaîne JS
  de l'attribut `onclick`. D'où `attrEnc()`.
- Guillemets doubles imbriqués dans `style="background-image:url("…")"` → l'URL était
  perdue et la photo du bandeau ne s'affichait pas. Passé en guillemets simples.
- Deezer trie sa recherche d'artistes par pertinence brute : un homonyme obscur peut
  passer devant. Voir BUG-007.

**Vérifié au navigateur (Playwright, desktop + Pixel 7 + iPhone SE)**
- Liens artiste depuis les 8 points d'entrée, y compris nettoyage `- Topic` / `VEVO`
- Page artiste, page album, rebond vers un artiste similaire, cas avec apostrophe
- `spaBack` / `spaForward` entre artiste et album ; fermeture du lecteur plein écran
  avant navigation ; aucun débordement horizontal en mobile
- Câblage lecture (file d'attente → résolution → `playTrack`) avec résolveur simulé
- Chemin de repli avec `/api/artist` en 404 : dégrade proprement, ne casse rien

**Non testé** : la lecture audio réelle (pas de `server/.env` avec clé YouTube en local).

> ⚠️ **À déployer** : `config.js` pointe vers `https://seven-hjai.onrender.com/api`.
> Tant que Render n'est pas redéployé, les nouvelles routes répondent 404 et l'app
> retombe sur l'ancien chemin : pages artiste sans photo, sans durées, sans singles ni
> similaires, et clic sur un album = simple recherche au lieu de la tracklist.

---

*Récap généré le 22 Juin 2026*  
*Basé sur les audits existants et l'analyse du code `www/index.html` + serveur + Android*  
*Journal tenu à jour à partir du 11 septembre 2026*
