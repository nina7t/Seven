const fs = require('fs');

const key = process.env.YOUTUBE_API_KEY || '';
if (!key) {
  console.warn('Warning: YOUTUBE_API_KEY non définie — l\'app tournera sans clé API');
}

fs.writeFileSync('config.js', `window.APP_CONFIG = { youtubeApiKey: '${key}' };\n`);
console.log('config.js généré avec succès');
