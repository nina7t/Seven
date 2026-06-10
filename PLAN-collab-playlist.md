# Playlists Collaboratives — Plan

## Contexte

L'app utilise déjà Firebase Auth et Firestore. Les playlists sont actuellement stockées en localStorage (`sevenz_playlists`).

**But :** Permettre à plusieurs utilisateurs d'éditer la même playlist en temps réel, comme sur Spotify.

---

## Ce qu'on va faire

### 1. Migration vers Firestore

**Collections Firestore :**
- `playlists/{playlistId}` — métadonnées (nom, owner, createdAt, shared)
- `playlists/{playlistId}/tracks/{trackId}` — tracks avec ordre

**Champs playlist :**
```js
{
  id: string,          // Firestore doc ID
  name: string,        // "Playlist de Mohamed"
  ownerId: string,     // Firebase UID du créateur
  ownerName: string,   // "Mohamed K."
  shared: boolean,     // true = accessible via lien
  shareCode: string,   // "xyz789" — 6 caractères aléatoires
  createdAt: timestamp,
  updatedAt: timestamp,
  coverImage: string,  // URL thumbnail (optionnel)
  trackCount: number   // pour affichage rapide
}
```

### 2. Système de partage

**Générer un lien :**
- Quand `playlist.shared = true`, générer un `shareCode` unique
- Lien = `sevenz://playlist/{shareCode}` ou via deep link Firebase

**Rejoindre une playlist :**
- L'utilisateur colle le code ou clique le lien
- Firestore vérifie que `shared: true` + `shareCode` valide
- L'utilisateur devient "contributeur" (ajout/suppression de tracks)

**Permissions :**
- Owner : peut supprimer la playlist, modifier le nom, retirer le partage
- Contributeur : peut ajouter/supprimer des tracks (pas le nom)

### 3. Interface utilisateur

**Bouton "Partager"** sur chaque playlist :
- Icône partage + "Inviter un ami"
- Modal avec : lien copiable + code

**Badge sur playlist partagée** :
- Icône cadenas/lien ouvert
- "3 personnes peuvent modifier"

**Nouveaux onglets :**
- "Playlists partagées avec moi" (section dans la vue playlists)

### 4. Sync en temps réel

**Firestore `onSnapshot`** pour écouter les changements :
- Quelqu'un ajoute un track → apparition immédiate chez les autres
- Quelqu'un supprime → disappears chez tous
- Pas de refresh nécessaire

**Conflict handling :**
- Firestore fait le merge automatiquement
- Si deux personnes ajoutent le même track en même temps → pas de dupes (trackId unique)

---

## Fichiers à modifier

| Fichier | Changement |
|---------|------------|
| `index.html` | Logique playlists → Firestore, UI partage, listeners temps réel |
| `firebase.json` | Règles Firestore (permissions) |

---

## Ordre d'implémentation

1. **Service Firestore** — fonctions CRUD pour playlists
2. **Migration data** — copier localStorage → Firestore pour users existants
3. **UI partage** — bouton partager, modal, code
4. **Real-time sync** — onSnapshot sur playlists suivies
5. **Règles de sécurité** — qui peut modifier quoi

---

## Estimation

- **Phase 1 (service + migration)** : 2-3h
- **Phase 2 (UI partage)** : 1-2h
- **Phase 3 (sync temps réel)** : 2h
- **Phase 4 (règles sécurité)** : 1h

---

## Prochaine étape

Valide ce plan et je commence par le service Firestore (fonctions CRUD playlists).