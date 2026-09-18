// Authentification Client Credentials TIDAL.
// Les credentials restent dans les variables d'environnement, jamais dans le code.
const axios = require('axios');
const CONFIG = require('../config');
const cache = require('../cache');

const CLIENT_ID = process.env.TIDAL_CLIENT_ID;
const CLIENT_SECRET = process.env.TIDAL_CLIENT_SECRET;

function isConfigured() {
  return Boolean(CLIENT_ID && CLIENT_SECRET);
}

/**
 * Récupère un token d'accès TIDAL, depuis le cache ou en le demandant.
 * Renouvelé avant expiration (TTL du cache = 10h pour un token de 4h).
 */
async function getAccessToken() {
  if (!isConfigured()) {
    throw new Error('TIDAL_CLIENT_ID / TIDAL_CLIENT_SECRET manquants');
  }

  const cached = cache.get('token', 'tidal', 'global');
  if (cached) return cached;

  const response = await axios.post(
    CONFIG.endpoints.tidal.auth,
    'grant_type=client_credentials',
    {
      auth: { username: CLIENT_ID, password: CLIENT_SECRET },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10000
    }
  );

  const token = response.data?.access_token;
  const expiresIn = response.data?.expires_in || 14400;
  if (!token) throw new Error('Réponse TIDAL OAuth invalide');

  // On met en cache avec une marge de sécurité de 10 minutes
  cache.set('token', 'tidal', 'global', token, { ttl: (expiresIn - 600) * 1000 });
  return token;
}

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.api+json'
  };
}

module.exports = { isConfigured, getAccessToken, authHeaders };
