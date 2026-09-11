#!/usr/bin/env bash
#
# build-apk.sh — Build l'APK debug SEVENZ avec les dernières modifs web.
#
# Enchaîne : index.html -> www/ -> cap copy -> gradle assembleDebug (JDK 21)
# -> remplace Sevenz-debug.apk à la racine.
#
# Usage :  ./build-apk.sh
#
set -euo pipefail

# Racine du projet = dossier de ce script (peu importe d'où on l'appelle)
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

# JDK 21 (Capacitor 7 l'exige). On force JDK 21 même si JAVA_HOME pointe vers 17.
# Surcharge possible : SEVENZ_JAVA_HOME=... ./build-apk.sh
JDK21_DEFAULT="/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home"
export JAVA_HOME="${SEVENZ_JAVA_HOME:-$JDK21_DEFAULT}"

if [ ! -x "$JAVA_HOME/bin/java" ]; then
  echo "❌ JDK introuvable : $JAVA_HOME"
  echo "   Installe-le avec :  brew install openjdk@21"
  echo "   ou exporte JAVA_HOME vers un JDK 21 avant de relancer."
  exit 1
fi

echo "▶ JDK   : $("$JAVA_HOME/bin/java" -version 2>&1 | head -1)"

# 1) Propager le web vers le webDir Capacitor
echo "▶ 1/4  Copie index.html -> www/"
cp index.html www/index.html

# 2) Injecter le web dans le projet Android
echo "▶ 2/4  npx cap copy android"
npx cap copy android

# 3) Builder l'APK debug
echo "▶ 3/4  Build Gradle (assembleDebug)…"
( cd android && ./gradlew assembleDebug )

# 4) Récupérer l'APK à la racine
APK_OUT="android/app/build/outputs/apk/debug/app-debug.apk"
echo "▶ 4/4  Remplacement de Sevenz-debug.apk"
cp "$APK_OUT" Sevenz-debug.apk

echo ""
echo "✅ Terminé — $(ls -lh Sevenz-debug.apk | awk '{print $5}'), $(date '+%H:%M:%S')"
echo "   Installe Sevenz-debug.apk sur ton téléphone (par-dessus l'ancienne)."
