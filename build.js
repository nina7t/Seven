const fs = require('fs');

const key = process.env.YOUTUBE_API_KEY || '';
if (!key) {
  console.warn('Warning: YOUTUBE_API_KEY non définie — l\'app tournera sans clé API');
}

const proxyUrl = process.env.PROXY_URL || 'http://localhost:3001/api';
fs.writeFileSync('config.js', `window.APP_CONFIG = { youtubeApiKey: '${key}', proxyUrl: '${proxyUrl}' };\n`);
console.log('config.js généré avec succès');
