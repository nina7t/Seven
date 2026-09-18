const { LRUCache } = require('lru-cache');
const CONFIG = require('./config');

function createCache({ max, ttlMs }) {
  return new LRUCache({
    max,
    ttl: ttlMs,
    updateAgeOnGet: false,
    allowStale: false
  });
}

const caches = {
  similar: createCache(CONFIG.cache.similar),
  search:  createCache(CONFIG.cache.search),
  token:   createCache(CONFIG.cache.token)
};

function cacheKey(type, id, source) {
  return `${source}:${type}:${String(id).toLowerCase().trim()}`;
}

function get(type, id, source) {
  return caches[type].get(cacheKey(type, id, source));
}

function set(type, id, source, value, options = {}) {
  caches[type].set(cacheKey(type, id, source), value, options);
  return value;
}

function stats() {
  return {
    similar: caches.similar.size,
    search: caches.search.size,
    token: caches.token.size
  };
}

module.exports = { caches, get, set, stats };
