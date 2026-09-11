# Connexion Google dans l'app Android

Le code est en place et l'APK compile. Il reste **deux étapes dans la console
Firebase** que je ne peux pas faire à ta place : elles demandent l'accès à ton
projet.

## Pourquoi un plugin natif était nécessaire

Google refuse l'OAuth dans une WebView embarquée (erreur `disallowed_useragent`).
`signInWithPopup` et `signInWithRedirect` du SDK web ne peuvent donc pas
fonctionner dans l'APK, quelle que soit la configuration. Seul un passage par le
sélecteur de compte natif Android marche.

## Ce qui est déjà fait

| Élément | État |
|---|---|
| `@capacitor-firebase/authentication` 8.5.1 | installé (`package.json`) |
| `android/variables.gradle` | `rgcfaIncludeGoogle = true` + versions androidx.credentials |
| `capacitor.config.json` | `FirebaseAuthentication` : `skipNativeAuth: true`, provider `google.com` |
| `npx cap sync android` | fait — plugin listé dans `capacitor.plugins.json` |
| Câblage JS (`loginWithGoogle`) | appelle le plugin natif puis ouvre la session côté SDK JS |
| Build `:app:assembleDebug` | **BUILD SUCCESSFUL** (vérifié, JDK 21) |
| Classes dans l'APK | `FirebaseAuthenticationPlugin`, `GoogleAuthProviderHandler`, `androidx.credentials`, `GetGoogleIdOption` — toutes présentes |

`skipNativeAuth: true` est volontaire : la couche native ne produit que le
*credential* Google, et la session est ouverte par le SDK Firebase JS. Tout le
reste de l'app (`onAuthStateChanged`, Firestore, la synchro des playlists) parle
au SDK JS — sans ce réglage on se retrouverait avec deux états d'authentification
à réconcilier.

## Ce qu'il te reste à faire

### 1. Enregistrer l'app Android dans Firebase

Console Firebase → projet `sevenz-7beb7` → Paramètres du projet → **Ajouter une
application** → Android.

- Nom du package : `com.sevenz.app`
- Empreinte SHA-1 de débogage :

```
E7:02:34:71:A7:5C:DB:A8:29:74:97:09:8A:C4:27:15:6B:C4:7A:D3
```

(SHA-256, si le formulaire la demande :
`50:0A:27:06:4C:90:85:B2:18:01:E6:81:BD:7C:B9:43:02:BD:E5:ED:0C:8D:7C:40:23:6D:1D:C3:D1:7A:19:66`)

Puis télécharge `google-services.json` et place-le dans :

```
android/app/google-services.json
```

Le build l'applique automatiquement — `android/app/build.gradle` teste déjà la
présence du fichier, c'est pour ça que la compilation passe sans lui aujourd'hui.
Mais **sans ce fichier, la connexion Google échouera à l'exécution** : c'est lui
qui porte le client ID serveur.

### 2. Activer le fournisseur Google

Console Firebase → Authentication → Sign-in method → **Google** → activé.
(Probablement déjà fait, puisque la connexion Google fonctionne sur le web.)

### 3. Rebuild

```bash
npm run build
npx cap sync android
cd android && ./gradlew assembleDebug
```

Il faut un **JDK 21** (`app/build.gradle` cible Java 21). Sur cette machine seul
le 17 était installé, le build échouait avant même mes changements. J'ai
installé `openjdk@21` via Homebrew ; si `java -version` renvoie 17, lance :

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home
```

## Si tu publies sur le Play Store

Google Play re-signe l'APK. Il faudra ajouter **en plus** l'empreinte SHA-1 de la
clé de signature d'application, visible dans la Play Console (Configuration →
Intégrité de l'application). Sans elle, la connexion Google échoue pour les
installations venant du Store, alors qu'elle marche en debug.

## Comportement actuel selon l'environnement

| Contexte | Chemin utilisé |
|---|---|
| Navigateur | popup OAuth, repli redirection si bloquée |
| WebView tierce (Instagram, Facebook…) | redirection |
| App native **avec** plugin + `google-services.json` | sélecteur de compte natif |
| App native **sans** configuration | bouton Google masqué, connexion par email proposée |

Le dernier cas est délibéré : mieux vaut masquer un bouton que proposer un
chemin qui échoue systématiquement.

## iOS

Non traité. Le même plugin le gère, mais il faut `GoogleService-Info.plist` et un
schéma d'URL inversé dans `Info.plist`. À faire quand tu attaqueras iOS.
