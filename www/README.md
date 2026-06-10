# 🚀 Proxy YouTube API - Sevenz

Ce serveur proxy résout les problèmes de quota YouTube API en :
- **Cachant les réponses** (1h pour recherches, 24h pour tendances)
- **Rate limiting** côté serveur (10 req/min par IP)
- **Protégeant ta clé API** (côté serveur uniquement)

## 📦 Installation

```bash
cd server
npm install
```

## ⚙️ Configuration

1. **Copier le fichier d'environnement :**
```bash
cp .env.example .env
```

2. **Éditer `.env` avec ta clé API YouTube :**
```env
YOUTUBE_API_KEY=VOTRE_CLE_API_YOUTUBE_ICI
PORT=3001
```

> 🔑 **Obtenir une clé API :** [Google Cloud Console](https://console.cloud.google.com/apis/credentials) → Create Credentials → API Key

3. **Activer l'API YouTube Data v3** dans Google Cloud Console

## 🚀 Démarrage

```bash
npm start
```

Le serveur démarre sur `http://localhost:3001`

## 🧪 Vérification

```bash
curl http://localhost:3001/api/health
```

Réponse attendue :
```json
{
  "status": "ok",
  "cacheStats": {
    "search": { "hits": 0, "misses": 0, ... },
    "trending": { ... },
    "video": { ... }
  }
}
```

## 📊 Cache

- **Recherches** : 1 heure (3600s)
- **Tendances** : 24 heures (86400s)
- **Vidéos (durées)** : 1 heure (3600s)

## 🔒 Sécurité

- Clé API **uniquement côté serveur** (jamais exposée au frontend)
- Rate limiting : 10 requêtes/minute par IP
- Gestion des erreurs 429 (quota dépassé)

## 🛠️ Routes API

| Route | Description |
|-------|-------------|
| `GET /api/health` | Statut du serveur |
| `GET /api/youtube/search?q=...` | Recherche YouTube |
| `GET /api/youtube/trending` | Tendances France |
| `GET /api/youtube/videos?ids=...` | Détails vidéos (durées) |
| `POST /api/admin/clear-cache` | Vider le cache |

## 🚨 Résolution des problèmes

### "Quota exceeded"
- Attendre que le cache se vide (1h)
- Ou vider manuellement : `curl -X POST http://localhost:3001/api/admin/clear-cache`

### "YOUTUBE_API_KEY non définie"
- Vérifier le fichier `.env`
- Redémarrer le serveur

## 📝 Frontend

Le frontend est automatiquement configuré pour utiliser le proxy via `PROXY_URL` dans `config.js`.

Par défaut : `http://localhost:3001/api`
