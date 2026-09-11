# 🎵 AUDIT COMPARATIF — SEVENZ vs SPOTIFY

**Date:** 21 Juin 2026  
**Méthode:** Analyse complète du code `index.html` (7325 lignes), backend, Android natif

---

## 1. ✅ CE QUE TON APP A DÉJÀ

### 🎧 Lecture & Player
| Feature | Sevenz | Spotify |
|---------|--------|---------|
| Lecture audio | ✅ | ✅ |
| Play / Pause | ✅ | ✅ |
| Skip Next / Prev | ✅ | ✅ |
| Barre de progression cliquable | ✅ | ✅ |
| Shuffle | ✅ | ✅ |
| Repeat | ✅ (1 mode) | ✅ (3 modes) |
| Crossfade | ✅ Android natif | ✅ |
| Contrôle volume | ✅ (UI présente) | ✅ |
| Notification media Android | ✅ | ✅ |
| Now Playing overlay (plein écran) | ✅ | ✅ |
| Préchargement pistes (preload) | ✅ 3 pistes | ✅ |
| Lecture offline (IndexedDB) | ✅ | ✅ (premium) |
| Restauration état après fermeture | ✅ (10 min) | ✅ |

### 🔍 Recherche & Découverte
| Feature | Sevenz | Spotify |
|---------|--------|---------|
| Recherche par titre/artiste | ✅ | ✅ |
| Skeleton loading résultats | ✅ | ✅ |
| Catégories de genres | ✅ (bubbles) | ✅ |
| Carte artiste (MusicBrainz) | ✅ | ✅ |
| Albums par artiste | ✅ | ✅ |
| Recommandations basées sur piste | ✅ | ✅ |
| "Basé sur tes écoutes" (smart playlists) | ✅ | ✅ |
| Résultats filtrés (pas de clips) | ✅ filterAI | ❌ |
| Fallback Invidious (quota dépassé) | ✅ | N/A |

### 📚 Bibliothèque & Playlists
| Feature | Sevenz | Spotify |
|---------|--------|---------|
| Créer playlist | ✅ | ✅ |
| Ajouter/retirer piste d'une playlist | ✅ | ✅ |
| Playlist avec cover custom | ✅ | ✅ |
| Titres likés (favoris) | ✅ | ✅ |
| Vue détail playlist | ✅ | ✅ |
| Import playlists Spotify | ✅ (OAuth) | N/A |
| Historique d'écoute | ✅ | ✅ |
| Vue Artistes | ✅ | ✅ |
| Vue Albums | ✅ | ✅ |
| Filtres bibliothèque | ✅ (Tout/Playlists) | ✅ |

### 🔐 Compte & Sync
| Feature | Sevenz | Spotify |
|---------|--------|---------|
| Authentification (Firebase) | ✅ | ✅ |
| Sync cloud (Firestore) | ✅ | ✅ |
| Profil utilisateur | ✅ | ✅ |
| Onboarding (sélection artistes) | ✅ | ✅ |

### 📱 Mobile & UX
| Feature | Sevenz | Spotify |
|---------|--------|---------|
| Dark theme | ✅ | ✅ |
| Navigation SPA (back/forward) | ✅ | ✅ |
| Bottom nav mobile | ✅ | ✅ |
| Pull-to-refresh | ✅ | ✅ |
| Vibration au tap | ✅ | ✅ |
| PWA (manifest.json) | ✅ | ❌ |
| Toast notifications | ✅ | ✅ |

---

## 2. ❌ CE QUI MANQUE PAR RAPPORT À SPOTIFY

### 🔴 Manques Critiques (impact fort sur l'expérience)

#### 1. Paroles en temps réel (Lyrics)
- Spotify affiche les paroles synchronisées avec la musique (karaoké)
- Sources disponibles : **Genius API**, **LRCLib** (gratuit)
- Difficulté : Moyenne

#### 2. File d'attente visible et modifiable (Queue Manager)
- Le bouton "File d'attente" existe dans le Now Playing mais **n'affiche rien**
- L'utilisateur ne peut pas voir/réordonner/supprimer des pistes de la queue
- Difficulté : Moyenne

#### 3. Repeat modes : 1 seul vs 3
- Sevenz : repeat on/off seulement
- Spotify : Off → Repeat All → Repeat One (track)
- Difficulté : Facile

#### 4. Volume fonctionnel dans le player
- Le slider volume est présent dans le DOM mais **non connecté**
- Difficulté : Facile (Web Audio API ou MediaSession)

### 🟠 Manques Majeurs

#### 5. Sleep Timer (minuterie d'arrêt)
- Spotify permet de programmer l'arrêt (5 min, 10 min, fin de piste...)
- Très utile pour l'écoute au lit
- Difficulté : Facile

#### 6. Égaliseur (Equalizer)
- Spotify Premium offre un EQ 5 bandes
- Possible via Web Audio API (BiquadFilterNode)
- Difficulté : Moyenne

#### 7. Gestion des doublons dans les playlists
- Sevenz bloque les doublons mais **sans notification claire**
- Spotify dit "Déjà dans la playlist"
- Difficulté : Facile

#### 8. Tri des résultats de recherche
- Spotify permet de trier par pertinence, date, popularité
- Sevenz utilise `getOfficialScore()` uniquement
- Difficulté : Facile

#### 9. Mode Radio (toujours en "à venir")
- `openRadio()` → affiche juste un toast "à venir"
- Spotify génère une radio infinie basée sur une piste/artiste
- Sevenz a déjà `loadRecommendedTracks()` — **suffisant pour le brancher**
- Difficulté : Facile (réutiliser code existant)

#### 10. Vue "Nouveau" / "Sorties récentes"
- Spotify a une section "Nouveautés" pour suivre les artistes
- Difficulté : Moyenne (YouTube trending + MusicBrainz)

### 🟡 Manques Mineurs

#### 11. Téléchargement batch (toute une playlist offline)
- Sevenz : téléchargement piste par piste uniquement
- Spotify : "Télécharger la playlist" en un clic
- Difficulté : Moyenne

#### 12. Smart Playlists automatiques
- "Découvertes de la semaine", "Radar des sorties"
- Sevenz a des smart playlists mais basées sur l'historique utilisateur uniquement
- Difficulté : Moyenne

#### 13. Partage de piste (Share)
- Le bouton partage existe dans le Now Playing mais **non connecté** (`title="Partager"` sans `onclick`)
- `navigator.share()` est déjà utilisé ailleurs dans l'app
- Difficulté : Très facile

#### 14. Stats d'écoute personnelles (Wrapped)
- Spotify Wrapped : artistes/titres les plus écoutés de l'année
- Sevenz a l'historique en localStorage mais pas de visualisation stats
- Difficulté : Facile (données déjà présentes)

#### 15. Gestion des playlists collaboratives
- Partager une playlist avec un lien
- Difficulté : Difficile (nécessite Firestore)

---

## 3. 🎯 FEATURES UNIQUES DE SEVENZ (que Spotify n'a pas)

| Feature | Valeur |
|---------|--------|
| **Gratuit sans abonnement** | ✅ |
| **Pas de publicités** | ✅ |
| **Téléchargement offline sans premium** | ✅ |
| **Filtrage anti-clips vidéo** (filterAI) | ✅ |
| **Fallback Invidious** (pas de quota) | ✅ |
| **Crossfade natif Android** | ✅ |
| **Import playlists depuis Spotify** | ✅ |
| **PWA installable** | ✅ |

---

## 4. 📊 SCORES PAR DOMAINE

| Domaine | Sevenz | Spotify | Gap |
|---------|--------|---------|-----|
| Lecture & Player | 8/10 | 10/10 | Lyrics, Queue, Repeat modes |
| Recherche | 9/10 | 9/10 | Quasi-parité |
| Bibliothèque | 8/10 | 9/10 | Batch download |
| Découverte | 7/10 | 9/10 | Radio, Nouveautés |
| Social | 2/10 | 7/10 | Aucune feature sociale |
| UX Mobile | 8/10 | 10/10 | Quelques boutons non câblés |
| **GLOBAL** | **7.3/10** | **9.2/10** | **Gap de 2 points** |

---

## 5. 🚀 PLAN D'ACTION — Par priorité

### 🔴 Quick wins (< 1h chacun)
1. **Connecter le bouton Partager** → `navigator.share()` dans `openNowPlaying()`
2. **Repeat modes** (off → all → one) → modifier `toggleRepeat()`
3. **Toast "Déjà dans la playlist"** → modifier `doAddToPlaylist()`
4. **Radio** → brancher `openRadio()` sur `loadRecommendedTracks()`
5. **Sleep Timer** → setTimeout + UI simple dans les paramètres

### 🟠 Ce sprint (2-4h chacun)
6. **Queue Manager visible** → drawer latéral avec liste `S.queue`
7. **Volume fonctionnel** → connecter le slider au MediaSession/AudioService
8. **Stats d'écoute** → page "Mes stats" depuis l'historique localStorage
9. **Batch download playlist** → boucle sur les pistes + progression

### 🟡 Prochain sprint (> 4h)
10. **Lyrics (paroles)** → intégration LRCLib API (gratuit, open source)
11. **Égaliseur** → Web Audio API avec BiquadFilterNode
12. **Nouveautés artistes** → page dédiée avec YouTube + MusicBrainz

---

*Rapport généré le 21 Juin 2026*
*Code analysé: 7325 lignes (index.html) + AudioService.java + server.js*
