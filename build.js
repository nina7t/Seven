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

// Les polices étaient recopiées à la main dans www/ : une nouvelle police
// manquait alors dans l'APK sans aucun message.
const fontsSrc = path.join(__dirname, 'fonts');
if (fs.existsSync(fontsSrc)) {
  fs.cpSync(fontsSrc, path.join(destDir, 'fonts'), { recursive: true });
  console.log('Fonts copied');
}
