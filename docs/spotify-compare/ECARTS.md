# Écarts Spotify ↔ SEVENZ (captures du 20/10/2026, Android 1260×2800, 1 px CSS = 3 px)

Captures : `spotify/`, `sevenz/`, `side/<écran>.png` (Spotify à gauche | SEVENZ à droite, séparateur magenta), vue d'ensemble `side/_all.png`.
Mesures en px CSS, relevées sur les pixels (PIL) et avec les bornes uiautomator. Notation : **Spotify → SEVENZ**.
Légende : 🔧 corrigeable · 🔒 inhérent (contenu absent de SEVENZ, police Albert Sans au lieu de Spotify Mix, état de l'app).

Contexte des captures : Spotify avait un titre en pause (mini-lecteur visible), SEVENZ rien en cours, donc pas de mini-lecteur (🔒 état). SEVENZ a 4 onglets, Spotify 5 avec Premium (🔒).

---

## Écarts transversaux (présents sur presque tous les écrans)

1. 🔧 **Bande de 6 px à droite et barre de défilement visible.** `index.html` l.329 `::-webkit-scrollbar { width: 6px; }`. Dans la WebView Android, une barre de défilement stylée prend de la place dans la mise en page : tout le contenu s'arrête 6 px plus tôt et une barre grise est visible sur x 414–420.
   - Barre de recherche : largeur 387 → 381 (x 16–404 → 16–398)
   - Tuiles de genre : 186 → 182
   - Pochettes de la grille : 118,7 → 116,7, marge droite 16 → 22
   - Icônes d'en-tête (loupe, +) : bord droit 407 → 401
   - Bouton grille : 389–403 → 383–398
   - Carrousels coupés à 398 au lieu de déborder jusqu'au bord de l'écran

   Correctif : sur mobile, `::-webkit-scrollbar{display:none}` ou `scrollbar-width:none`, au moins sur le conteneur principal.
2. 🔧/🔒 **Texte trop maigre partout.** L'encre par surface est 15 à 25 % plus faible pour une largeur de texte identique à ±1 px (corps de police bien calé) :

   | Texte | Spotify | SEVENZ |
   |---|---|---|
   | h1 « Bibliothèque » | 0,41 | 0,32 |
   | titre de ligne | 0,35 | 0,29 |
   | puce | 0,27 | 0,23 |
   | puce « Titres » (recherche) | 0,29 | 0,21 |
   | option de feuille | 0,36 | 0,30 |
   | placeholder de recherche | 0,26 | 0,21 |
   | titre de la boîte « Donnez un nom… » | 0,25 | 0,19 |

   Albert Sans est variable (100–900) : monter d'un cran (400→500 pour les titres de ligne, les puces et les options ; 700→800 pour h1, h2 et le titre de la boîte) rapprocherait le rendu. La hauteur de capitale reste inférieure de 1 à 1,4 px (12,7 → 11,3), ce qui est inhérent à la police (🔒).
3. 🔧 **Barre de navigation.**
   - Libellés : hauteur de capitale 8 → 7, « Accueil » 35,7 → 33 px de large (environ −8 %, soit à peu près −1 px de corps). Libellé actif « Bibliothèque » 63,3 → 56,7.
   - Libellés 3 px trop hauts (haut 872,7 → 869,7), icônes 1,3 px trop hautes (842,3 → 841,0), icônes de 20 px dans les deux cas.
   - Libellé « Recherche » au lieu de « Rechercher ».
   - 🔒 L'icône Bibliothèque diffère (« |||\ » chez Spotify, carrés empilés chez SEVENZ).
4. 🔧 **Fond de l'en-tête de la Bibliothèque.** Spotify est uni #121212 de y=0 à 200. SEVENZ a un dégradé #1f1f1f (y 0) → #191919 (y 100) → #141414 (y 200), plus un filet sombre #0e0e0e à y 156. Spotify n'a qu'une ombre légère vers y 158–160.

---

## lib_list (Bibliothèque, liste)
Géométrie quasi identique : avatar 32 px à 16/62 ; h1 x 65,3–201,3, y 68–91 ; puces 32 px de haut à y 115–147 ; ligne « Récents » y 177–193 ; pochettes 64 px aux mêmes y (209, 289, 369) ; pas de 80.
- 🔧 Fond d'en-tête en dégradé (voir transversal 4). Écart le plus visible de l'écran.
- 🔧 Icônes de droite et bouton grille décalés de 6 px vers la gauche (transversal 1).
- 🔧/🔒 Titres de ligne plus maigres (transversal 2), hauteur de capitale 12,7 → 11,3.
- 🔒 Puce « Podcasts » absente (normal : pas de podcasts) ; contenu différent.
- 🔒 Sous-titre « Playlist • chouchouloveuse » chez Spotify, « Playlist • 28 titres » chez SEVENZ (choix éditorial).

## lib_grid
- 🔧 Pochettes de 118,7 → 116,7 et marge droite 16 → 22 : c'est la gouttière de 6 px.
- 🔧 Écart titre → sous-titre de 9 → 13,7 (bas du titre 353,7 → 349,3 ; haut du sous-titre 362,7 → 363,0). Le titre est 3,6 px trop haut (pochette → titre : 15,6 → 14) et le sous-titre trop bas : réduire d'environ 4 px l'espace entre les deux et ajouter environ 2 px sous la pochette.
- 🔒 Le reste (pas vertical des rangées, sur 2 lignes) est comparable (≈ 215–219).

## lib_filter_playlists
Puce ✕ 32 px et puce verte « Playlists » 66,7 → 66,3, identiques ; vert #1ED760 identique.
- 🔒/🔧 Spotify ajoute les sous-filtres « Par vous », « Par Spotify », « Mixée ». SEVENZ n'en a aucun. Un « Par vous / Importées » serait faisable.
- 🔧 Texte des puces plus maigre (transversal 2).
- 🔒 Sous-titres : Spotify garde « Playlist • … » pour Titres likés ; SEVENZ affiche « 28 titres ».

## lib_sort_sheet (feuille « Trier par »)
- 🔧 **Feuille 6 px trop haute.** Bord haut 593 → 587 ; titre 618,7 → 613,7 ; séparateur 640,3 → 634,3 ; options 666,7 → 661,3. Le bas des deux feuilles tombe au même endroit, donc SEVENZ a environ 6 px de marge basse en trop (ou de padding interne).
- 🔧 Coche verte 20 × 15,7 → 17 × 12,3 (environ 3 px trop petite).
- 🔧/🔒 Options plus maigres : hauteur de capitale 12,7 → 11,3, encre 0,36 → 0,30.
- Le pas entre options (60) est identique.

## lib_longpress (menu contextuel de playlist)
SEVENZ a été capturé avec le filtre Playlists actif, pour viser une playlist utilisateur.
- 🔒/🔧 Entrées manquantes : « Télécharger » (Premium, 🔒), « Modifier la playlist » (🔧 si l'édition existe déjà), « Créer une pochette » (🔒/🔧). La feuille est donc plus basse (haut 380 → 501).
- 🔧 Titre d'en-tête en gras chez SEVENZ, alors que « CREAT_DEV » est en medium chez Spotify : inverser, mettre le titre en ~500.
- 🔒 Sous-titre : « par chouchouloveuse • Playlist publique » chez Spotify, « Playlist • nina.teraluna » chez SEVENZ. La formulation Spotify est reproductible (🔧).
- Identiques : pas de 56 entre entrées, icônes de 20 px à x 18–38, libellés à x 53, pochette d'en-tête de 48 px, séparateur 16 px sous la pochette.
- 🔧 Icônes un peu plus fines et libellés plus maigres (transversal 2).

## search_browse (Rechercher, haut)
h1 x 65,3 → 65,3, hauteur 18,3 ; barre de recherche y 126–174 (48 px) identique ; placeholder #535353 identique.
- 🔒 Il manque les 4 raccourcis (Musique, Podcasts, Livres audio, Événements, tuiles de 68 px), la pub et le carrousel « Découvrez de nouveaux horizons ». SEVENZ démarre directement par les genres (tuiles de 101 px).
- 🔧 Barre de recherche 387 → 381 de large (transversal 1).
- 🔧 Placeholder plus maigre (encre 0,26 → 0,21) : Spotify est en gras.
- 🔒 Icône appareil photo absente à droite du titre ; SEVENZ a un micro dans la barre (choix fonctionnel).
- 🔧 Loupe 21,7 → 20 px.

## search_browse_scrolled
- 🔧 **Bug visible : la barre d'état n'est pas masquée.** Une fois l'écran défilé, l'avatar et « Rechercher » passent sous l'heure et les icônes système (y 0–20). Spotify garde un fond #121212 opaque derrière la barre d'état et la barre collante, et le contenu disparaît sous la barre (le contenu reprend à 118, 8 px sous la barre). La barre collante est bien à y 62–110 dans les deux apps. Il faut un masque opaque de 0 à 62 (`--safe-top` compris) au-dessus de la barre collante.
- 🔧 Tuiles de 186 → 182 de large ; hauteur 101 identique ; écart 16 identique.
- 🔒 Moins de genres (10 contre une vingtaine) ; aucun titre de section « Parcourir tout ».

## search_focused
- 🔧 **Comportement :** un appui sur l'onglet Recherche ouvre directement le mode focalisé avec le clavier. Spotify ouvre la page Parcourir et ne focalise qu'au toucher de la barre.
- 🔧 **La barre de navigation reste affichée au-dessus du clavier** (y ≈ 540–580 sur la capture) ; Spotify la masque quand le clavier est ouvert.
- 🔧/🔒 Récents : Spotify mémorise les **éléments ouverts** (pochette ou avatar de 48 px, titre, type, boutons ⊕/✓ et ✕). SEVENZ mémorise des **requêtes texte** (carré gris avec loupe). Les dimensions sont identiques : vignette 48 px à x 16, ✕ aux mêmes x, pas de 64.
- 🔧 Titre de ligne 10 px trop bas (166,3 → 176) : Spotify a un titre et un sous-titre, SEVENZ une seule ligne centrée. Ça disparaîtra avec l'ajout du sous-titre.
- Identiques : champ x 48–404 → 48–398 (−6), hauteur 32, fond #363636 ; h2 « Récents » y 121,7.

## search_results (« daft punk »)
- 🔧 **Puces de recherche trop larges** : « Titres » 53,7 → 62, « Albums » 65 → 74,3, « Artistes » 66,7 → 75. Le padding horizontal est d'environ 10 → 15,6 px, alors que les puces de la Bibliothèque sont justes. Aligner `.search-chip` sur `.lib-chip` (≈ 10–12 px).
- 🔧 **Barre de défilement horizontale visible** sous le carrousel (3 px, #414141, à y 420), venant de `.albums-row::-webkit-scrollbar{height:3px}`. Spotify n'en a pas.
- 🔧 Titres des cartes du carrousel : Spotify passe sur 2 lignes en gras (« jamesjamesjames' track IDs »), SEVENZ coupe sur 1 ligne avec « … ». Passer à `-webkit-line-clamp:2`.
- 🔧 Carrousel coupé à x 398 au lieu de déborder sous le bord droit (transversal 1).
- 🔒 Puces Playlists, Podcasts et Nouveautés absentes ; badge « vérifié » absent ; section « Avec Daft Punk » remplacée par « Discographie ».
- 🔒/🔧 Lignes : Spotify affiche ⊕ (ajout) à droite, SEVENZ ⋮.
- Bouton « S'abonner » : 94,3 × 34 → 98 × 34, quasi identique. Pochettes de carte 124 identiques.

## search_results_chip (Titres)
- 🔧 Puce « Titres » 53,7 → 62 (même cause que ci-dessus).
- 🔧 Spotify a deux boutons par ligne (⋮ à x ≈ 348, ⊕/✓ à x 389–403). SEVENZ n'a que ⋮ à x ≈ 386. Ajouter le ⊕/✓ « ajouter aux Titres likés » permettrait de reproduire la mise en page.
- 🔧 Écart titre → sous-titre 8 → 6,4 (haut du sous-titre 188,7 → 186,7) : ajouter environ 2 px.
- 🔧/🔒 Titres plus maigres (transversal 2).
- 🔒 Pertinence : SEVENZ mêle des titres de The Weeknd (feat. Daft Punk) ; Spotify n'affiche que des titres de Daft Punk.
- Identiques : pas de 64, vignettes de 48 px, croix d'effacement de 16 px de diamètre (décalée de 6 px).

## create_sheet (bouton Créer)
- 🔒 Une seule option (Playlist) contre trois chez Spotify (Playlist collaborative, Mix à plusieurs).
- 🔧 Sous-titre « Créez une playlist de titres. » : hauteur 12,7 → 10,7, un peu petit et maigre.
- 🔧 Icône de note blanche (#fff) chez SEVENZ, gris clair (#b3b3b3) chez Spotify.
- Identiques : cercle d'icône de 48 px à x 28, titre à x 89, bas de la feuille à y 821,3, bouton ✕ de 40 px (centre x 378 → 367,7, une conséquence des 4 onglets 🔒).

## create_name (« Donnez un nom à votre playlist »)
Quasi parfait : titre x 50–372, y 195,7–219 identique ; boutons Annuler et Créer aux mêmes coordonnées (x 107,7 et 235,7–312,3, y 388) ; soulignement identique.
- 🔧/🔒 Titre, nom saisi et libellés de boutons plus maigres (encre du titre 0,25 → 0,19). Spotify est en gras (≈ 800).
- 🔒 Poignées de sélection natives (gouttes blanches) absentes dans la WebView.
- 🔒 « nº 9 » contre « nº 10 » : chaque app compte ses propres playlists.

## playlist_empty / playlist_add (SEVENZ seul)
Pas de capture Spotify, la consigne était la lecture seule. Ces remarques viennent de la seule capture SEVENZ, sans mesure Spotify :
- 🔧 « Etta James - Topic » dans les recommandations : le suffixe YouTube « - Topic » s'affiche. À retirer.
- 🔧 Une fois la playlist supprimée, l'app atterrit sur l'ancienne page « Mes Playlists » (en-tête avec logo carré, recherche « Cherche puis appuie sur Entrée », menu ☰, tuiles Importer CSV/Deezer). Ce n'est pas le nouveau design : il faudrait revenir à la Bibliothèque.
- Le reste (pochette vide avec note, « Commençons à créer votre playlist », bouton blanc « Ajouter à cette playlist », page « Ajouter à cette playlist » avec recherche et ⊕) suit la structure Spotify.
