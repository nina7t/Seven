# 🎵 SEVENZ — RECAPITULATIF DU PROJET

**Date du récap :** 19 septembre 2026  
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
- ~~Paroles synchronisées~~ ✅ fait (karaoke LRCLib, seek au tap)
- ~~File d'attente modifiable~~ ✅ fait (drag & drop dans le drawer)
- ~~Mode Radio~~ ✅ fait (`openRadio()` Last.fm + radio Deezer)
- ~~Partage de piste~~ ✅ fait (`navigator.share` + presse-papier)
- ~~Batch download~~ ✅ fait (« Télécharger tout » par playlist)
- ~~Gestion des doublons~~ ✅ fait (toast « Déjà dans cette playlist »)
- ~~Smart playlists automatiques~~ ✅ fait (« ✨ Découvertes de la semaine »)
- ~~Stats d'écoute~~ ✅ fait (vue Stats : top artistes/titres, temps d'écoute)
- ~~Nouveautés / sorties récentes~~ ✅ fait (`/api/new-releases` + section page artiste)

### Améliorations futures
- Égaliseur (Web Audio API — ⚠️ impossible côté web avec l'iframe YouTube cross-origin ; envisageable uniquement côté natif Android)
- Drag & drop de la file sur tactile (actuellement desktop uniquement)
- Playlists collaboratives / partage par lien (voir `PLAN-collab-playlist.md`)
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

### 19 septembre 2026 — Radio Spotify-like, personnalisation réelle et recherche contextuelle

**Objectif** : rendre la radio consultable comme une playlist Spotify, puis connecter
réellement les réglages et les données personnelles au nouveau moteur backend.

#### Vue playlist de la radio

- Nouvelle vue SPA `radioView`, enregistrée dans `ALL_VIEWS` et `applyView('radio')`.
- En-tête « Radio de [artiste] », pochette de la piste en cours, compteur de titres et
  description indiquant que la sélection évolue pendant l’écoute.
- Liste complète de `S.queue` avec vignette, titre, artiste cliquable, durée et
  surlignage de la piste active.
- Actions Lire/Reprendre, Aléatoire et File d’attente.
- Navigation clavier des pistes et artistes (`Entrée` / `Espace`) et scroll vers la
  piste active.
- État explicite si l’utilisateur revient sur une ancienne vue radio après avoir lancé
  un autre contexte de lecture.
- Bouton contextuel « Voir la radio » dans le gestionnaire de file lorsque
  `S.radioMode` est actif.
- `maybeExtendRadio()` rafraîchit la vue après avoir ajouté un nouveau lot.
- `openRadio()` délègue désormais à `startRadio(track.channel, track.title)` : la
  radio Deezer / le moteur titre-based est utilisé au lieu de l’ancien chemin
  Last.fm + YouTube obsolète.

#### Nouveau moteur radio connecté au frontend

- Le moteur `/api/radio/start`, `/api/radio/next` et `/api/radio/feedback`, initialement
  présent uniquement dans `www/index.html`, a été reporté chirurgicalement dans
  `index.html` sans recopier tout le fichier ni écraser les différences de la version
  Capacitor.
- Les réponses backend sont adaptées au player par `mapRadioTrack()` et la session
  est conservée dans `S.radioId`.
- Le curseur **Rassurant ↔ Aventureux** est présent dans les deux variantes et sa
  valeur `S.radioAdventurousness` est transmise à `/radio/start` puis `/radio/next`.
- Les boutons pouce haut / pouce bas envoient le feedback de la piste courante à la
  session radio.
- En cas d’échec du moteur titre-based, le fallback radio artiste Deezer reste actif.

#### Personnalisation envoyée au backend

- Ajout de `getRadioPersonalization()` :
  - `userHistory` transmet les artistes des 30 dernières écoutes ;
  - `recentKeys` transmet leurs clés normalisées afin d’éviter les répétitions ;
  - `dislikedKeys` transmet les morceaux rejetés dans le format attendu par le backend.
- `radioKeyPart()` / `radioTrackKey()` reproduisent côté client la normalisation
  `artiste|titre` du moteur de découverte.
- `dislikeCurrentTrack()` conserve désormais l’identifiant de lecture **et** la clé
  normalisée. Les anciens dislikes sous forme d’ID sont rapprochés des métadonnées
  encore disponibles dans l’historique, les favoris ou la file.

#### Recherche récente plus discrète

- « Recherches récentes » est caché au repos.
- Le panneau apparaît uniquement lorsque l’utilisateur clique/focalise la barre de
  recherche vide.
- Il disparaît dès que du texte est saisi et réapparaît si le champ est vidé tout en
  restant actif.
- Il se referme à la perte de focus, sans empêcher le clic sur un terme récent.

#### Corrections CSS

- Suppression de la propriété obsolète `speak: none` sur les icônes Tabler.
- Ajout de la propriété standard `line-clamp: 2` à côté de
  `-webkit-line-clamp: 2` pour supprimer les avertissements de compatibilité.

#### Vérifications

- **41/41 tests backend passent** (`npm test` dans `server/`).
- Les 7 blocs `<script>` de `index.html` et `www/index.html` passent l’analyse
  JavaScript (`new Function`) sans erreur.
- Vérification de présence des cinq intégrations dans les deux variantes :
  `/radio/start`, `/radio/next`, `/radio/feedback`, `getRadioPersonalization` et
  `radioAdventure`.
- Test Playwright mobile 390 × 844 : vue visible, titre de radio correct, liste rendue,
  piste active surlignée, lecture clavier fonctionnelle et accès « Voir la radio ».
- `git diff --check` propre.

---

### 18 septembre 2026 — Onboarding Spotify-style + Home « Mes artistes »

**Objectif** : quand on sélectionne des artistes lors de la première connexion, la home
 doit les montrer en bulles à la place des tendances, et proposer des radios basées
 sur ces artistes.

**Fichier principal : `www/index.html`**

- **Onboarding artistes similaires** :
  - `obRevealRelated()` utilise maintenant toute la base (`ARTIST_DB` + `ARTIST_DB_EXTRA`)
    pour que les genres « extra » (rock, metal, jazz, chanson, pop internationale, etc.)
    génèrent aussi des recommandations.
  - Choix aléatoire : jusqu’à 2 artistes du **même genre** + 1 artiste d’un genre
    proche, mélangés pour la variété.
  - Les nouvelles bulles s’insèrent **juste après l’artiste cliqué** au lieu d’être
    ajoutées en bas de la grille.
  - Badge `NEW` agrandi et animé (`obNewBadgePop`).

- **Section Home « Mes artistes »** :
  - Remplacement du titre et du contenu de `#bubbleSection` : « Tendances » →
    « Mes artistes ».
  - Nouvelle fonction `loadMyArtists()` qui lit `sevenz_liked_artists` et affiche
    les artistes en bulles rondes (photo / gradient / initiales).
  - Nouvelle fonction `playMyArtistRadio(i)` : clic sur une bulle = radio infinie
    de cet artiste.
  - Nouveaux styles `.my-artist-card`, `.my-artist-cover`, `.my-artist-play`,
    `.my-artist-name`.

- **Radios recommandées basées sur les artistes likés** :
  - `buildRadioStations()` donne une forte pondération (+5) aux artistes choisis
    en onboarding, en plus de l’historique d’écoute.
  - La section « Radios recommandées » s’affiche dès qu’il existe au moins une radio
    (ancienne condition `history.length >= 5` supprimée).

- **Rafraîchissement automatique** :
  - `finishOnboarding()` appelle `loadMyArtists()` + `loadHomeExtras()` au lieu de
    l’ancien `loadTrending()`.
  - `applyView('home')` appelle `loadMyArtists()` à chaque retour sur l’accueil.

**Autres ajustements du jour**
- États `:hover` conditionnés par `@media (hover: hover)` sur les résultats de
  recherche, la bibliothèque, les boutons ronds, la page artiste, etc. pour éviter
  qu’un tap mobile reste figé visuellement après le clic.

**Vérifié au navigateur (Playwright)** :
- Clic sur Nirvana → apparition de `Téléphone` et `Noir Désir` (rock FR).
- Clic sur NTM → apparition de `Tiakola`, `PLK`, `Orelsan` (hip-hop FR / proches).
- Fin de l’onboarding avec 5 artistes → home affiche « Mes artistes » + « Radios
  recommandées » correspondantes, sans section Tendances.

---

### 18 septembre 2026 — Sprint « app optimale » (6 chantiers en parallèle)

Toutes les entrées de la section « Ce qui manque » soldées en une passe :

- **Queue réordonnable** — drag & drop HTML5 dans le drawer (poignée `ti-grip-vertical`,
  indicateur de drop accentué). `S.currentIndex` est réajusté dans les 3 cas de figure
  pour que la piste en cours reste la bonne. Tactile non couvert (DnD natif
  navigateur-dépendant).
- **Toast doublon** — `doAddToPlaylist` affiche « Déjà dans cette playlist ».
- **Paroles synchronisées** — `parseSyncedLyrics()` (LRC `[mm:ss.xx]`, tags
  métadonnées filtrés), ligne active surlignée + scroll centré, timer 250 ms sur
  `getPlayerTime()`, seek au tap via `seekPlayer()`, re-fetch au changement de piste,
  fallback `plainLyrics` conservé.
- **Batch download** — bouton « Télécharger tout » dans les deux vues playlist ;
  boucle séquentielle qui réutilise `resolveVideoId()` + `saveTrackOffline()` +
  `isTrackOffline()` ; toast de progression `n/total`, bilan « X réussis · Y déjà
  présents · Z échecs », verrou anti-double-clic.
- **Découvertes de la semaine** — `generateDiscoverWeekly()` : top 5 artistes des 7
  derniers jours d'historique → radio Deezer (repli Last.fm + YouTube), filtrage des
  titres déjà likés/écoutés via `trackTitleKey`, 30 titres max, matérialisée en
  playlist `smart: true` persistée comme les autres + bouton « Régénérer ». Régénérée
  au startup, après login et après sync cloud si > 7 jours.
- **Stats d'écoute** — `S.stats` agrégé (`sevenz_stats`) : compteurs par artiste et
  par titre + secondes d'écoute réelles (tick ~10 s, pauses exclues, sauts bornés).
  Nouvelle vue SPA `stats` (top 5 artistes, top 10 titres, temps total, nb likes)
  accessible depuis le menu profil et le menu mobile.
- **Nouveautés** — `GET /api/new-releases?artist=` (Deezer `/artist/{id}/albums` trié
  par `release_date`, 8 plus récentes, résolution d'homonymes via
  `rankArtistMatches`, cache 1 h) + section « Nouveautés » en tête de la page
  artiste avec badge Album/Single/EP ; dégrade silencieusement si l'endpoint 404.

**Vérifié** : `node --check` sur `server.js` + les 7 blocs `<script>` de
`index.html` (0 erreur), `git diff --check` propre.

> ⚠️ **À déployer** : la route `/api/new-releases` n'existe que localement tant que
> Render n'est pas redéployé — sans elle la section Nouveautés ne s'affiche pas,
> sans casser le reste.

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

### 18 septembre 2026 — Moteur de radio à partir d’un titre

**Objectif** : à partir d’un titre choisi par l’utilisateur, générer une file continue,
cohérente, avec une part de découverte ajustable.

**Fichiers créés dans `server/discovery/`**
- `seed.js` — caractérise la graine (Deezer + MusicBrainz + tags Last.fm, BPM, année,
  IDs normalisés).
- `candidates.js` — constitue le vivier : `track.getSimilar`, artistes proches,
  `tag.getTopTracks` et voisins des voisins ; dédoublonnage par MBID puis clé normalisée.
- `filters.js` — écarte reprises, live, karaokés, remasters redondants, déjà écoutés
  et titres rejetés.
- `scoring.js` — score combiné (match source, Jaccard tags, popularité log,
  nouveauté artiste, proximité tempo/époque) + pondérations dans `weights.js`.
- `sequencer.js` — ordonnancement avec contraintes : max 2 titres/artiste sur 20,
  pas 2 consécutifs, pas 3 du même album, pas de saut brutal de tempo,
  répartition des époques, lots de 20, curseur `adventurousness`.
- `feedback.js` — sessions radio en mémoire, signaux skip/listen80/like/dislike,
  poids par tag et par artiste, exclusion après 2 rejets.
- `routes/radio.js` — `POST /api/radio/start` et `POST /api/radio/next`
  (retournent `strategy` + `degradedSources`).

**Fichiers modifiés**
- `server/discovery/config.js` — section `radio` (timeouts, limites, pondérations).
- `server/discovery/providers/lastfm.js` — export de `call` + ajout de
  `track.getInfo`, `track.getTopTags`, `artist.getTopTags`, `track.getSimilar`,
  `artist.getTopTracks`, `tag.getTopTracks`.
- `server/discovery/providers/deezer.js` — ajout de `fetchTopTracks`.
- `server/discovery/index.js` — montage de `routes/radio.js`.
- `server/server.js` — montage de `/api/radio` à la racine.
- `www/index.html` — `startRadio()` utilise `/api/radio/start` quand un titre est
  fourni ; `maybeExtendRadio()` utilise `/api/radio/next` si `S.radioId` existe ;
  ajout du slider Rassurant/Aventureux et des pouces haut/bas dans `#radioView`.

**Tests**
- `server/discovery/tests/seed.test.js`
- `server/discovery/tests/candidates.test.js`
- `server/discovery/tests/filters.test.js`
- `server/discovery/tests/scoring.test.js`
- `server/discovery/tests/sequencer.test.js`
- `server/discovery/tests/feedback.test.js`
- `server/discovery/tests/eval-radio.js` — script d’évaluation simulé sur 10 graines.

**Commandes vérifiées**
```bash
curl -s -X POST http://localhost:3001/api/radio/start \
  -H 'Content-Type: application/json' \
  -d '{"title":"One More Time","artist":"Daft Punk"}' | jq .radioId

curl -s -X POST http://localhost:3001/api/radio/next \
  -H 'Content-Type: application/json' \
  -d '{"radioId":"<uuid>"}' | jq '.tracks | length'
```

**Exemples de requêtes sources**
```bash
# Deezer (public, sans clé)
curl "https://api.deezer.com/search/track?q=Daft%20Punk%20One%20More%20Time&limit=1"
# → {"data":[{"id":3135553,"title":"One More Time",...}]}

# Last.fm (nécessite LASTFM_API_KEY)
curl "https://ws.audioscrobbler.com/2.0/?method=track.getsimilar&artist=Daft+Punk&track=One+More+Time&api_key=$LASTFM_API_KEY&format=json"

# TIDAL similar artists (nécessite TIDAL_CLIENT_ID/SECRET)
# OAuth client_credentials → access_token
# curl "https://openapi.tidal.com/v2/artists/<id>?countryCode=FR&include=similarArtists" -H "Authorization: Bearer ..."
```

> ✅ Requêtes réelles exécutées le 19 septembre avec les clés fournies :
> Last.fm (`track.getSimilar`, `track.getTopTags`, `artist.getTopTags`,
> `tag.getTopTracks`) et Deezer OK ; OAuth TIDAL OK mais la recherche d’artiste
> par `handle` ne retourne rien → TIDAL reste une source secondaire expérimentale.
> MusicBrainz répond parfois 503 → traité comme source dégradée.
> `/api/radio/start` renvoie `"track-similar-tags"` + 20 titres en local.

**Variables d’environnement à ajouter sur Render**
- `LASTFM_API_KEY` — obligatoire pour les tags/similarités
- `TIDAL_CLIENT_ID` / `TIDAL_CLIENT_SECRET` — optionnel (source de similaires)
- `YOUTUBE_API_KEY` — déjà requis par le serveur

---

### 19 septembre 2026 — La radio mélange enfin le connu et la découverte

Demande de Nina : « comme Spotify — j'ai des musiques que je connais et des
musiques que je découvre ». Le moteur faisait l'inverse, par trois mécanismes
qui poussaient tous vers l'inconnu :

- `filters.js` retirait du vivier les 30 derniers titres écoutés. Les classiques
  les plus joués ne pouvaient jamais revenir.
- `scoring.js` / `noveltyScore` notait 0.3 un artiste connu contre 1.0 un
  inconnu, soit −0,105 sur tout ce qui est familier.
- `sequencer.js` faisait du curseur une profondeur de classement : « Rassurant »
  = haut du classement, or ce classement était déjà biaisé vers l'inconnu.
  Glisser vers « Rassurant » donnait donc *plus* d'inconnu — le curseur était à
  l'envers de ses propres étiquettes.

**Correctif** — le familier n'est plus pénalisé, il est dosé par un quota.

- `filters.js` n'exclut plus que la graine, les rejets et ce qui a déjà été joué
  dans la radio en cours (`excludeKeys`). L'historique d'écoute ne sort plus du
  vivier.
- `scoring.js` — `tagFamiliarity()` marque chaque candidat `familiar` : titre
  déjà écouté, ou artiste déjà écouté. L'artiste de la graine compte comme connu.
- `sequencer.js` — `buildQueue` remplit un quota entier
  (`discoveries < Math.round(adv * (added.length + 1))`) : le curseur Aventure
  pilote directement la part de découverte. Si un bassin est vide, on prend dans
  l'autre plutôt que de rendre un lot court.
- Défaut passé de 0.35 à **0.5** (moitié connu, moitié découverte), curseur du
  front aligné. `formatTrack` expose `familiar` pour que le front puisse afficher
  la distinction.

**Mesuré** — 47 tests passent. Sur un lot de 20, en simulation : curseur 0 → 0
découverte, 0.25 → 5, 0.5 → 10, 0.75 → 15, 1 → 20. En conditions réelles (graine
Daft Punk, historique French touch, vivier 166) : 16/20 connus à 0, 10/20 à 0.5,
0/20 à 1.

**Arête connue** : `isValid` refuse un candidat si 3 des 5 derniers titres sont
de sa décennie. Sur un vivier concentré sur une seule époque, le lot peut se
terminer court — vu en test avec un vivier artificiel 100 % même année (3 titres
sur 20 demandés). Non rencontré sur des viviers réels, qui sont assez étalés.

---

### 19 septembre 2026 — Revue + passe de corrections du moteur radio

Revue complète du moteur (4 agents en parallèle sur des fichiers disjoints),
puis corrections. **42/42 tests passent**, éval : 50 titres/graine,
découverte moyenne **35 %** (cible 30–40 %).

**Backend**
- `providers/*` + nouveau `retry.js` — gestion des 429 : respect de
  `Retry-After` (secondes ou date HTTP) sinon backoff exponentiel
  (~750 ms / ~1,5 s, 2 retries max, compatible avec le timeout source de 4 s).
- `sequencer.js` — bug corrigé : les candidats choisis sont exclus via
  `usedKeys` (plus de doublon possible dans un lot) ; les plafonds
  artiste/album ne comptent plus que le lot courant, l’historique ne sert
  qu’à l’adjacence et la continuité BPM/époque.
- `candidates.js` — `neighborsOfNeighbors` passait `a.name` sur une string
  (voisins toujours vides) ; `safeCall` capture désormais aussi les
  exceptions synchrones ; bloc TIDAL mort retiré ; nouvelle fonction
  `fetchMoreCandidates()` (tags 4-5 + voisins depuis les derniers artistes
  du pool).
- `routes/radio.js` — `/next` réapprovisionne le vivier sous 40 candidats
  (`CONFIG.radio.replenishThreshold`) → la radio ne s’arrête plus après
  ~15 lots ; `userHistory` normalisé avec `normalizeForDedupe` ;
  `degradedSources` signale Deezer/Last.fm quand ils ne produisent rien ;
  imports morts retirés.
- `feedback.js` — `recordFeedback` valide le type avant d’écrire l’historique.
- `filters.js` — fonction morte `parseIsoWeekAgo` supprimée.

**Front (`www/index.html`)**
- `/radio/start` et `/radio/next` envoient `adventurousness` — le slider a
  un effet réel ; `/radio/next` envoie des `playedKeys` au format
  `normalizedKey` (avant : clés titre-only qui ne matchaient jamais →
  titres déjà joués pouvaient revenir).
- Signaux automatiques : `listen80` à 80 % d’écoute (hook `updateProgress`),
  `skip` si passage au suivant avant 20 s (avec garde fins naturelles),
  via `sendRadioFeedback()` sans toast.
- `radioFeedback` utilise `Capacitor.Plugins.Haptics.impact({style:'LIGHT'})`
  avec fallback `navigator.vibrate`.
- Le slider régénère toute la file à venir via `regenerateRadioQueue()`
  (splice après `currentIndex` + push des nouveaux titres, référence de
  queue conservée).
- `getRadioPersonalization()` : `/radio/start` envoie aussi l’historique
  (`userHistory`, `recentKeys`) et les dislikes (`dislikedKeys`) au bon
  format clé `artiste|titre`.

**Reste à faire / limites connues**
- Pas de persistance utilisateur des poids feedback (session mémoire 24 h).
- Pas de filtre « audio disponible » côté backend (résolu à la lecture
  via la recherche YouTube).
- ~~Endpoint TIDAL catalogue par `handle` peu fiable → source expérimentale.~~
  → Résolu le 19/09/2026, voir « TIDAL devient une vraie source » plus bas.

---

### 19 septembre 2026 — TIDAL devient une vraie source (et n'était pas cassé)

La review qualifiait TIDAL de « fragile : la recherche par handle ne retourne
rien pour daftpunk ». Après sondage direct de l'API, le diagnostic était inversé :
l'API va très bien, c'est notre code qui visait le mauvais endpoint.

**Deux bugs empilés, aucun côté TIDAL**

1. `filter[handle]` était condamné d'avance. Le `handle` n'existe que pour les
   profils d'artistes *revendiqués* — Daft Punk a `handle: undefined`. Même
   `jayz`, l'exemple officiel de la doc TIDAL, renvoie 0 résultat. On slugifiait
   le nom en espérant tomber sur un handle : ça ne pouvait marcher que par hasard.
2. Le parsing visait `res.data.relationships`. L'API est JSON:API : les relations
   sont dans `res.data.data.relationships`. Même avec un bon ID, la fonction
   renvoyait donc un tableau vide.

Par ailleurs `/searchResults/{query}` (recherche texte) répond 400 sur les 9
variantes d'encodage testées : elle n'est **pas ouverte** à nos credentials
client-credentials. Ce n'est pas contournable, il faut entrer par un identifiant.

**La solution : le pont ISRC**

Deezer donne l'ISRC sur `/track/{id}` (pas sur la recherche), et TIDAL sait
résoudre un ISRC. D'où la chaîne :

```
Deezer search → track.id → /track/{id}.isrc → TIDAL filter[isrc] → artistId
```

Validé 5/5 sur des titres variés (FR, AU, UK, US).

**Ce que TIDAL apporte maintenant**

| Capacité | Endpoint | Note |
|---|---|---|
| Résoudre un titre | `/tracks?filter[isrc]=…&include=artists` | seul point d'entrée fiable |
| Artistes similaires | `/artists/{id}?include=similarArtists` | 20 artistes + popularité |
| Top tracks | `/artists/{id}/relationships/tracks?collapseBy=NONE` | `collapseBy=NONE` obligatoire, sinon 400 |
| Radio curatée | `/artists/{id}/relationships/radio` | playlist TIDAL — **pas encore exploitée** |

La qualité est nettement supérieure à Last.fm sur les répertoires de niche :
similaires de Daft Punk = Justice, Stardust, Cassius, Modjo, Etienne de Crécy.
La `popularity` TIDAL (0–1) alimente directement `popularityScore()`.

**Deux bugs trouvés en chemin**

- `mergeCandidates` gardait les champs de la première entrée rencontrée. TIDAL
  arrivant après Last.fm, ses durées étaient systématiquement écrasées par `null`.
  La fusion complète désormais les trous (Last.fm n'a ni durée ni année, TIDAL a
  la durée, Deezer le BPM).
- Rate limit TIDAL : 8 appels parallèles → 429 → backoff → dépassement du budget
  de 4 s. Seuil mesuré à 150 ms entre appels, requêtes sérialisées. Piège suivant :
  `withRetry` reculait *à l'intérieur* du verrou et bloquait toute la file — les
  deux ont été inversés.

**Mesures**

| Graine | Candidats | dont TIDAL | Temps |
|---|---|---|---|
| Daft Punk — Around the World | 237 | 19 | 3,2 s |
| Aya Nakamura — Djadja | 231 | 18 | 3,9 s |
| Radiohead — Creep | 243 | 24 | 2,6 s |
| Tame Impala — The Less I Know | 201 | 24 | 2,3 s |
| Artiste inexistant | 0 | — | 0,5 s (dégradation propre) |

Avant correction : 5,3 s et 3 timeouts par appel. Après : 2,4 s, zéro timeout
sur les artistes courants. 60 tests passent (dont 5 ajoutés sur la conversion de
durée ISO 8601 et la fusion inter-sources).

**Fichiers touchés**
- `server/discovery/providers/tidal.js` — réécrit (ISRC, JSON:API, top tracks, sérialisation)
- `server/discovery/providers/deezer.js` — `fetchTrackIsrc()`
- `server/discovery/seed.js` — expose `ids.deezerTrack` (`ids.deezer` retombait
  sur l'ID *artiste* quand le titre n'était pas résolu)
- `server/discovery/candidates.js` — bloc TIDAL productif, fusion corrigée,
  `safeCall` étiqueté par source (les timeouts étaient anonymes et indébuggables)
- `server/discovery/config.js` — `tidalSimilarArtists`, `tidalCallTimeoutMs`
- `server/discovery/tests/tidal.test.js` — nouveau

**Reste à faire / limites connues**
- ~~La radio TIDAL native est identifiée mais pas branchée.~~ → faite, voir la
  section suivante.
- ~~Timeouts occasionnels sur des artistes obscurs.~~ → disparus avec la radio,
  qui demande moins d'appels sérialisés.
- **Le séquenceur n'exploite pas les bons scores** : les titres TIDAL sortent en
  tête au scoring (0,675 / 0,655 / 0,618) mais la file finale démarre sur du 0,258
  et n'en garde que 2 sur 20. Le mélange connu/découverte prend le dessus. Ce n'est
  pas un bug, c'est un arbitrage de design — mais c'est là qu'il faut regarder si
  les radios semblent molles, pas du côté des sources.

---

### 19 septembre 2026 — La radio curatée TIDAL devient la source principale

Suite directe de la section précédente. `/artists/{id}/relationships/radio`
renvoie une playlist éditorialisée par TIDAL : elle mêle déjà les titres phares
de l'artiste et des voisins pertinents, soit exactement ce que le moteur
fabriquait à la main avec « similaires × top tracks ».

**Ce que ça change**

Le fan-out demandait 7 appels TIDAL sérialisés (1 résolution + 1 similaires +
5 top tracks) et les derniers de la file épuisaient leur budget de timeout. La
radio en demande 5 (1 résolution + 1 relation + 3 pages de 20 titres) et rend
trois fois plus de candidats.

Le fan-out reste en repli si un artiste n'a pas de radio — la bascule est
automatique et testée.

| Graine | Candidats TIDAL avant → après | Total | Temps |
|---|---|---|---|
| Daft Punk | 19 → **57** | 270 | 2,8 s |
| Aya Nakamura | 18 → **59** | 258 | 2,1 s |
| Radiohead | 24 → **59** | 256 | 2,3 s |
| Tame Impala | 24 → **59** | 272 | 2,7 s |

Et surtout : **plus aucun timeout**, sur aucune graine. Les traînards
mentionnés dans la section précédente (Awa Imani, Pond, GUM) venaient du
fan-out ; ils disparaissent avec lui.

La radio remonte aussi les titres de l'artiste de départ (Daft Punk — One More
Time, Get Lucky), ce qui sert directement le « connu + découverte » demandé.
100 titres et 53 artistes distincts disponibles sur 5 pages ; on en prend 3 par
défaut (`tidalRadioPages`), réglable.

**Fichiers touchés**
- `server/discovery/providers/tidal.js` — `fetchArtistRadio()` + `parseRadioItems()`
  (parsing extrait en fonction pure pour être testable sans réseau)
- `server/discovery/candidates.js` — radio en voie principale, fan-out en repli
- `server/discovery/config.js` — `tidalRadioPages`, `tidalRadioTimeoutMs`
- `server/discovery/tests/tidal.test.js` — 5 tests de parsing (recollage des
  artistes depuis `included`, rangs paginés, titre orphelin, document malformé)

65 tests passent.

**Limite inchangée** : le séquenceur continue de ne pas exploiter ces scores
(cf. section précédente). Les titres TIDAL de la radio scorent jusqu'à 0,601
mais la file démarre toujours sur du 0,26–0,31. → traité dans la section
suivante.

---

### 19 septembre 2026 — Le séquenceur exploite enfin les scores

Symptôme : les meilleurs candidats scoraient 0,60–0,64, mais les lots démarraient
sur du 0,26–0,31. Tout le travail de scoring (tags, popularité, multi-source,
nouveauté) semblait ignoré.

**Diagnostic** — il ne l'était pas *ignoré*, il était *dilué*. `weightedRandomPick`
tirait proportionnellement au score brut. Or les scores réels tiennent dans une
plage étroite (0,17 à 0,64, soit un rapport de 3,7) répartie sur 250 candidats :
un tirage proportionnel y revient à du quasi-hasard.

Mesuré sur 600 sélections : **26,8 % des titres retenus venaient du top 20 % du
vivier — contre 20 % pour un tirage purement aléatoire.** Un gain de 1,34×, pour
tout un pipeline de scoring. Le score moyen des lots (0,352) était celui du
vivier (0,340).

**Correctif** — un exposant sur le poids de tirage (`pickSharpness: 3`).

Quatre stratégies ont été comparées sur 40 lots réels :

| Stratégie | Score moyen | Part du top 20 % | Titres distincts / 40 lots |
|---|---|---|---|
| actuel (score¹) | 0,347 | 28,1 % | 200 |
| score² | 0,365 | 32,8 % | 191 |
| **score³** | **0,383** | **40,4 %** | **198** |
| score⁵ | 0,414 | 52,6 % | 164 |
| top 40 + score² | 0,409 | 62,4 % | 85 |
| top 25 + score¹ | 0,415 | 63,8 % | 70 |

Les variantes « top N » donnent la meilleure qualité mais **effondrent la
variété** : 70 à 85 titres distincts sur 40 lots, contre 200. Une radio qui se
répète. L'exposant, lui, creuse les écarts sans réduire le vivier — la queue de
distribution reste atteignable. `score³` est le point d'équilibre : qualité
nettement relevée, variété intacte.

Mesure après correction, sur trois graines : part du top 20 % passée de 26,8 % à
**45,3 %** (gain 2,27× sur l'aléatoire au lieu de 1,34×), score moyen des lots
0,39–0,43 pour des viviers à 0,34–0,36, et 200+ titres distincts sur 40 lots.

**Bug secondaire corrigé** — le repli d'un candidat sans score valait `1`, soit
plus que n'importe quel score réel (max ~0,65). Un candidat non scoré raflait
donc la mise. Il est désormais traité comme médiocre (0,01).

**Ce qui n'a pas bougé** — le quota connu/découverte du commit `ec882c7` est
strictement préservé. Vérifié à l'identique avant/après : curseur 0 → 0
découverte, 0,25 → 5, 0,5 → 10, 0,75 → 15, 1 → 20 sur un lot de 20.

**Arête à connaître** (préexistante, pas une régression) : le quota suppose que
chaque bassin puisse remplir un lot à lui seul. Si l'historique de l'auditeur ne
recoupe le vivier que sur quelques artistes, le bassin « connu » s'épuise — le
plafond de 2 titres par artiste exige ~10 artistes distincts pour 20 slots — et
le repli documenté bascule vers la découverte. Un auditeur au profil très étroit
aura donc plus de découverte que le curseur n'en demande. C'est préférable à un
lot tronqué, mais ça explique un curseur qui semble mou sur un compte neuf.

**Fichiers touchés**
- `server/discovery/sequencer.js` — `pickWeight()` extrait, exposant appliqué
- `server/discovery/config.js` + `weights.js` — `pickSharpness`
- `server/discovery/tests/sequencer-pick.test.js` — 9 tests (tirage déterministe
  via `Math.random` figé, et non-régression du quota sur les 5 positions du curseur)

74 tests passent.

---

*Récap généré le 22 Juin 2026*  
*Basé sur les audits existants et l'analyse du code `www/index.html` + serveur + Android*  
*Journal tenu à jour à partir du 11 septembre 2026*
