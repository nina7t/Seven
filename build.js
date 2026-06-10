const fs = require('fs');

const key = process.env.YOUTUBE_API_KEY || '';
if (!key) {
  console.warn('Warning: YOUTUBE_API_KEY non définie — l\'app tournera sans clé API');
}

const proxyUrl = process.env.PROXY_URL || 'http://localhost:3001/api';

const config = `window.APP_CONFIG = {
  youtubeApiKey: '${key}',
  proxyUrl: '${proxyUrl}',
  firebase: {
    apiKey: "AIzaSyD6DUc0twRqo5U-f1k6mpDz1pT-3QKrjkc",
    authDomain: "sevenz-7beb7.firebaseapp.com",
    projectId: "sevenz-7beb7",
    storageBucket: "sevenz-7beb7.firebasestorage.app",
    messagingSenderId: "69732113281",
    appId: "1:69732113281:web:6178d65b335b9e2219e680",
    measurementId: "G-BMYJVB7TCS"
  }
};
`;

fs.writeFileSync('config.js', config);
console.log('config.js généré avec succès');
