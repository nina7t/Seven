const fs = require('fs');
const path = require('path');

// Copie le fichier source vers le dossier webDir utilisé par Capacitor
const src = path.join(__dirname, 'index.html');
const destDir = path.join(__dirname, 'www');
const dest = path.join(destDir, 'index.html');

if (!fs.existsSync(src)) {
  console.error(`Source not found: ${src}`);
  process.exit(1);
}

fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(src, dest);
console.log(`Built: ${src} -> ${dest} (${fs.statSync(dest).size} bytes)`);
