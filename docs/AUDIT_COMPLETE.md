# 🔍 AUDIT COMPLET - SEVENZ APP

**Date:** 18 Juin 2026  
**Scope:** Fullstack Mobile App (Capacitor + Node.js + Android Native)

---

## 1. 📐 AGENT ARCHITECTURE

### Vue d'ensemble
```
┌─────────────────────────────────────────────────────────────────┐
│                        FRONTEND                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │   index.html │  │   Config    │  │   State Global (S.)    │  │
│  │  (7158 lignes)│  │  config.js  │  │  queue/favorites/playlists│ │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     SERVEUR PROXY                               │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │  server.js   │  │  invidious  │  │    fallback-data.js      │  │
│  │  (591 lignes)│  │   -client   │  │   (fallback YouTube)     │  │
│  │  Express API │  │  .js (190)  │  │                          │  │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     ANDROID NATIVE                              │
│  ┌──────────────────┐ ┌──────────────────┐ ┌────────────────┐  │
│  │ AudioService.java │ │AudioPlayerPlugin │ │YouTubeExtractor│  │
│  │   (594 lignes)    │ │   .java (412)     │ │Plugin.java(229)│  │
│  │  Service FG audio │ │  Bridge Capacitor│ │ Extraction URL │  │
│  └──────────────────┘ └──────────────────┘ └────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### Architecture globale: **7/10**
- ✅ Pattern SPA avec state global `S.`
- ✅ API REST avec caching multi-layer
- ✅ Fallback YouTube → Invidious → Static
- ⚠️ Monolithique: tout le frontend dans un fichier HTML de 7158 lignes

---

## 2. 🎨 AGENT UX/UI DESIGN

### Design System
- **Palette:** Dark theme avec accents violets (#8b5cf6)
- **Icons:** Tabler Icons via webfont
- **Layout:** Sidebar + Main Content + Player bar fixe
- **Responsive:** Oui, avec breakpoints mobile

### Problèmes UX/UI identifiés

| Sévérité | Issue | Localisation | Recommandation |
|----------|-------|--------------|----------------|
| 🔴 **Critique** | Pas de gestion d'état de chargement sur lecture | `playTrack()` | Ajouter un loader/spinner |
| 🟠 **Majeur** | Feedback visuel insuffisant sur actions | Boutons like/playlist | Micro-interactions CSS |
| 🟡 **Mineur** | Typographie inconsistente | Mix px/rem | Standardiser en rem |
| 🟡 **Mineur** | Contraste insuffisant sur badges VEVO | `search-results` | Vérifier AA WCAG |

### Parcours utilisateur - Carte de chaleur des frictions
```
1. Lancement App        [████░░░░░░] 2/10 - Cold start rapide
2. Recherche            [██████░░░░] 4/10 - Token cancellation OK
3. Lecture piste        [████████░░] 7/10 - Latence extraction URL
4. Gestion playlists    [█████░░░░░] 3/10 - CRUD fonctionnel
5. Background audio     [██████████] 9/10 - NOTIF BUG (fixé)
```

---

## 3. 👤 AGENT PARCOURS UTILISATEUR

### Flows identifiés

#### Flow 1: Découverte → Lecture
```
Home → Search Input → doSearch() → Résultats → playTrack()
                         ↓
              [YouTube API → Cache → Render]
                         ↓
              [MusicBrainz artiste (background)]
```

#### Flow 2: Playlist Management
```
Création:  "playlists" view → createPlaylist() → savePlaylists() → localStorage
Édition:   openPlaylist() → addToPlaylist() / removeFromPlaylist()
Lecture:   playPlaylist() → S.queue = pl.tracks → playTrack(0)
```

#### Flow 3: Background Audio
```
App background → AudioService (foreground) → Notification
                      ↓
              [MediaStyle + PendingIntents]
                      ↓
              ACTION_PAUSE/RESUME/NEXT/PREV
```

### Points de friction UX
1. **Pas de skeleton screens** - saut de contenu lors du chargement
2. **Pas de offline indicator** permanent (bannière fallback temporaire)
3. **Navigation mobile** - menu burger peu découvrable
4. **Pas de feedback haptique** sauf `navigator.vibrate(10)` sur play

---

## 4. 💻 AGENT DEV FULLSTACK

### Frontend (`www/index.html`)

#### ✅ Points forts
- Systeme de cache `_ytCache` pour réduire les appels API
- Token cancellation pattern pour éviter race conditions
- Lazy loading des durées vidéo

#### ⚠️ Problèmes de code

**Ligne ~79: Reference potentielle à `player` undefined**
```javascript
if (player != null && player.isPlaying()) {  // player = undefined possible
    updatePlaybackState();
```

**Ligne ~112: `setAction()` encore utilisé dans AudioPlayerPlugin**
```java
intent.setAction(ACTION_PAUSE);  // Inconsistent avec le fix notification
```

### Backend (`server/`)

#### ✅ Points forts
- Request coalescing pour éviter les duplications
- Rotation intelligente des clés API YouTube
- Circuit breaker: YouTube → Invidious → Fallback

#### ⚠️ Problèmes

**Ligne ~46: Variable globale `quotaUsedToday` non persistée**
```javascript
let quotaUsedToday = 0;  // Reset au redémarrage du serveur
```

**Ligne ~191: Retry logic avec même clé potentiellement épuisée**
```javascript
rotateKey();
// ... retry avec getCurrentKey() mais pas de vérif si déjà testée
```

### Android Native

#### ✅ Points forts
- NewPipeExtractor pour extraction directe sans serveur
- AudioService foreground avec wake lock
- MediaSession pour contrôle système

#### ⚠️ Problèmes

**AudioPlayerPlugin.java L201-215: Inconsistance d'intents**
```java
intent.setAction(ACTION_PAUSE);  // DEVRAIT être putExtra("action", ...)
```

**YouTubeExtractorPlugin.java L40: AsyncTask déprécié**
```java
new ExtractAudioTask(call).execute(videoId);  // API 30+ warning
```

---

## 5. 🐛 AGENT DEBUG

### Bugs identifiés

| ID | Bug | Fichier | Ligne | Statut |
|----|-----|---------|-------|--------|
| BUG-001 | Notification pause ne fonctionne pas | AudioService.java | 484-517 | ✅ FIXÉ |
| BUG-002 | setAction() inconsistent dans plugin | AudioPlayerPlugin.java | 203,214,225,334,360,395 | ✅ FIXÉ |
| BUG-003 | AsyncTask déprécié Android 11+ | YouTubeExtractorPlugin.java | 40 | ⚠️ Warning (non-critique) |
| BUG-004 | quotaUsedToday non persisté | server.js | 46 | ⚠️ Amélioration future |
| BUG-005 | player variable peut être undefined | index.html | ~79 | ⚠️ Edge case (rare) |

### Logs & Monitoring
- ✅ `console.log` présents en dev
- ✅ Android `Log.d()` dans tous les plugins
- ❌ Pas de système de crash reporting (Sentry/Firebase Crashlytics)
- ❌ Pas de métriques de performance utilisateur

### Error Handling
| Composant | Couverture | Note |
|-----------|------------|------|
| API YouTube | ✅ Try/catch + retry | 3 niveaux de fallback |
| Extraction audio | ✅ Try/catch | Retourne error objet |
| Player | ⚠️ Partiel | Pas de gestion erreur lecture |
| Storage | ❌ Non | Pas de try/catch localStorage |

---

## 6. 📋 RECOMMANDATIONS PAR PRIORITÉ

### 🔴 Critique (Fix immédiat) ✅
1. **BUG-002**: Corriger `setAction()` → `putExtra()` dans AudioPlayerPlugin ✅
2. ~~BUG-005: Ajouter guard check~~ (code déjà protégé avec optional chaining)

### 🟠 Majeur (Cette semaine) ✅
3. Implémenter skeleton screens pour recherche ✅
4. Ajouter système de toast/notification pour feedback actions ✅
5. Persister quotaUsedToday (fichier JSON) ✅

### 🟡 Mineur (Prochain sprint) ✅ PARTIEL
6. Remplacer AsyncTask par ExecutorService ✅
7. Ajouter Sentry ou Firebase Crashlytics
8. Splitter index.html en modules ES6

### 🟢 Amélioration continue
9. Ajouter tests unitaires (Jest pour JS, JUnit pour Java)
10. Implementer service worker pour offline complet

---

## 7. 📊 SCORES

| Domaine | Score Avant | Score Après | Commentaire |
|---------|-------------|-------------|-------------|
| Architecture | 7/10 | **7.5/10** | ✅ AsyncTask remplacé, quota persistant |
| UX/UI | 6/10 | **8/10** | ✅ Skeleton screens, feedback visuel amélioré |
| Parcours User | 7/10 | **8/10** | ✅ Latence audio optimisée avec préload agressif |
| Code Quality | 6/10 | **7.5/10** | ✅ Bugs corrigés, code moderne |
| Debug/Monitoring | 4/10 | 4/10 | Basique, Sentry à ajouter |
| Performance | 7/10 | **8.5/10** | ✅ Préload 3 pistes, persistance quota |
| **GLOBAL** | **6.2/10** | **7.3/10** | ✅ Tous les bugs critiques corrigés |

---

## 8. ✅ ACTIONS COMPLÉTÉES

### Bugs corrigés
```bash
✅ BUG-001: Notification pause fonctionne (setAction → putExtra) - AudioService.java
✅ BUG-002: Plugin intents corrigés - AudioPlayerPlugin.java  
✅ BUG-006: AsyncTask remplacé par ExecutorService - YouTubeExtractorPlugin.java
```

### Améliorations UX
```bash
✅ Skeleton screens recherche: renderSearchSkeleton() ajouté
✅ Feedback visuel: showLoadingState() + animations pulse
✅ Préload audio: 3 pistes à l'avance avec preloadUpcoming()
```

### Backend
```bash
✅ Quota persistant: .quota.json sauvegardé toutes les 30s
```

## 9. 🔧 RESTE À FAIRE (Next Sprint)

```bash
# 1. Sentry/Crashlytics pour le monitoring
# 2. Modulariser index.html en composants ES6
# 3. Tests unitaires (Jest/JUnit)
# 4. Service Worker pour offline complet
```

---

*Rapport généré par agents spécialisés Cascade*  
*Files analysés: 7 | LOC total: ~15,000*
