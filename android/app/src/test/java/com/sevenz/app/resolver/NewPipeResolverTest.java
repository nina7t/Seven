package com.sevenz.app.resolver;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;

import org.junit.Test;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * Tests du scoring pur de NewPipeResolver (pickBestCandidate) avec des
 * candidats neutres mockés en dur : aucune classe NewPipe, aucun réseau.
 * Chaque cas cible une faiblesse précise de l'algo.
 *
 * Filet de sécurité pour ajuster les pondérations sans casser ce qui marche.
 */
public class NewPipeResolverTest {

    /** Construit un candidat neutre mocké (résultat de recherche simulé). */
    private static NewPipeResolver.Candidate candidate(String videoId, String title, String uploader, Integer durationSec) {
        return new NewPipeResolver.Candidate(
            title,
            uploader,
            durationSec,
            "https://www.youtube.com/watch?v=" + videoId
        );
    }

    private static List<NewPipeResolver.Candidate> items(NewPipeResolver.Candidate... candidates) {
        return new ArrayList<>(Arrays.asList(candidates));
    }

    // ────────────────────────────────────────────────────────────────
    // CAS 1 — Le classique noyé sous les reuploads
    // La chaîne Topic doit sortir en tête ; le "sped up" à 3:20 doit être
    // rejeté par le filtre de durée (radio edit officiel = 4:08 = 248s).
    // ────────────────────────────────────────────────────────────────
    @Test
    public void cas1_topicGagne_spedUpRejeteParDuree() {
        NewPipeResolver resolver = new NewPipeResolver("Daft Punk", "Get Lucky", 248);

        NewPipeResolver.ResolvedTrack best = resolver.pickBestCandidate(items(
            candidate("SPEDUP000ID", "Get Lucky (sped up)", "SpeedyEdits", 200),           // 3:20 → rejet durée
            candidate("SLOWED000ID", "Get Lucky (slowed + reverb)", "ChillVibes", 300),    // rejet durée + pénalité
            candidate("LYRICS000ID", "Daft Punk - Get Lucky (Lyrics)", "RandomLyrics", 249),
            candidate("TOPIC0000ID", "Get Lucky (Radio Edit)", "Daft Punk - Topic", 248)
        ));

        assertNotNull("Un match fiable doit être trouvé", best);
        assertEquals("La chaîne Topic doit gagner", "TOPIC0000ID", best.videoId);
    }

    @Test
    public void cas1bis_spedUpSeul_rejete() {
        NewPipeResolver resolver = new NewPipeResolver("Daft Punk", "Get Lucky", 248);

        NewPipeResolver.ResolvedTrack best = resolver.pickBestCandidate(items(
            candidate("SPEDUP000ID", "Get Lucky (sped up)", "SpeedyEdits", 200)
        ));

        assertNull("Un sped up à 3:20 pour un titre de 4:08 doit être rejeté", best);
    }

    // ────────────────────────────────────────────────────────────────
    // CAS 2 — Le feat. qui casse la normalisation
    // Sur YouTube le crédit est inversé : "Calvin Harris – We Found Love
    // ft. Rihanna". Le score textuel doit rester haut malgré l'inversion,
    // grâce au retrait des feat./ft. et au matching par tokens.
    // ────────────────────────────────────────────────────────────────
    @Test
    public void cas2_featInverse_matchQuandMeme() {
        NewPipeResolver resolver = new NewPipeResolver("Rihanna", "We Found Love (feat. Calvin Harris)", 215);

        NewPipeResolver.ResolvedTrack best = resolver.pickBestCandidate(items(
            candidate("INVERSE00ID", "Calvin Harris - We Found Love ft. Rihanna", "Calvin Harris", 215),
            candidate("KARAOKE00ID", "We Found Love (Karaoke Version)", "Sing King", 216)
        ));

        assertNotNull("L'inversion artiste/feat ne doit pas faire échouer le match", best);
        assertEquals("INVERSE00ID", best.videoId);
    }

    // ────────────────────────────────────────────────────────────────
    // CAS 3 — Le titre ultra-court et générique
    // "Hello" seul donne peu de tokens → le texte est faible. La durée
    // exacte + la chaîne Topic doivent sauver le cas.
    // ────────────────────────────────────────────────────────────────
    @Test
    public void cas3_titreCourt_dureeEtTopicSauvent() {
        NewPipeResolver resolver = new NewPipeResolver("Adele", "Hello", 295);

        NewPipeResolver.ResolvedTrack best = resolver.pickBestCandidate(items(
            candidate("TUTO00000ID", "Hello World - Java Tutorial for Beginners", "CodeAcademy", 300),
            candidate("AUTRE0000ID", "Hello - Lionel Richie", "Lionel Richie - Topic", 254),
            candidate("ADELE0000ID", "Hello", "Adele - Topic", 295)
        ));

        assertNotNull("Un titre court doit se résoudre grâce à durée + Topic", best);
        assertEquals("ADELE0000ID", best.videoId);
    }

    // ────────────────────────────────────────────────────────────────
    // CAS 4 — Le morceau qui n'a PAS de version officielle propre
    // Aucune chaîne Topic, durées toutes fausses, uploads amateurs.
    // Attendu : null. Un faux positif est pire qu'un "pas trouvé".
    // ────────────────────────────────────────────────────────────────
    @Test
    public void cas4_aucuneVersionFiable_retourneNull() {
        NewPipeResolver resolver = new NewPipeResolver("Obscure Netlabel Artist", "Lost Demo Tape", 187);

        NewPipeResolver.ResolvedTrack best = resolver.pickBestCandidate(items(
            candidate("AMATEUR00ID", "lost demo tape maybe??", "randomdude420", 340),
            candidate("RIP000000ID", "Obscure Artist mix (rip from cassette)", "TapeCollector", 3600),
            candidate("WRONG0000ID", "Completely Different Song", "SomeChannel", 187)
        ));

        assertNull("Aucun candidat fiable → l'algo doit dire 'pas trouvé'", best);
    }

    // ────────────────────────────────────────────────────────────────
    // CAS 5 — Le piège du cover mieux référencé que l'original
    // Une cover de 4:30 SANS le mot "cover" dans le titre doit être écartée
    // par la durée (l'original fait 6:53 = 413s, très distinctif).
    // ────────────────────────────────────────────────────────────────
    @Test
    public void cas5_coverSansLeMotCover_ecarteeParDuree() {
        NewPipeResolver resolver = new NewPipeResolver("Jeff Buckley", "Hallelujah", 413);

        NewPipeResolver.ResolvedTrack best = resolver.pickBestCandidate(items(
            candidate("COVER0000ID", "Hallelujah", "Popular Singer", 270),                  // cover 4:30, mot absent
            candidate("COHEN0000ID", "Hallelujah", "Leonard Cohen - Topic", 274),           // autre version, durée off
            candidate("BUCKLEY00ID", "Hallelujah", "Jeff Buckley - Topic", 413)
        ));

        assertNotNull(best);
        assertEquals("La durée 6:53 doit départager les versions", "BUCKLEY00ID", best.videoId);
    }

    @Test
    public void cas5bis_coverSeule_dureeOff_retourneNull() {
        NewPipeResolver resolver = new NewPipeResolver("Jeff Buckley", "Hallelujah", 413);

        NewPipeResolver.ResolvedTrack best = resolver.pickBestCandidate(items(
            candidate("COVER0000ID", "Hallelujah", "Popular Singer", 270)
        ));

        assertNull("Une cover à 4:30 sans le mot 'cover' doit quand même être rejetée", best);
    }

    // ────────────────────────────────────────────────────────────────
    // CAS 6 — Le live vs studio
    // La version Live Aid a une durée PROCHE (dans la tolérance ±4s) et un
    // score textuel identique. C'est la pénalité "live" qui doit trancher,
    // pas la durée.
    // ────────────────────────────────────────────────────────────────
    @Test
    public void cas6_liveProcheEnDuree_penaliseParLexique() {
        NewPipeResolver resolver = new NewPipeResolver("Queen", "Bohemian Rhapsody", 355);

        NewPipeResolver.ResolvedTrack best = resolver.pickBestCandidate(items(
            candidate("LIVE00000ID", "Queen - Bohemian Rhapsody (Live Aid)", "Queen Official", 357), // diff 2s : durée OK
            candidate("STUDIO000ID", "Bohemian Rhapsody (Remastered 2011)", "Queen - Topic", 355)
        ));

        assertNotNull(best);
        assertEquals("Le mot 'live' doit pénaliser même à durée proche", "STUDIO000ID", best.videoId);
    }

    @Test
    public void cas6bis_liveSeul_sousLeSeuil() {
        NewPipeResolver resolver = new NewPipeResolver("Queen", "Bohemian Rhapsody", 355);

        NewPipeResolver.ResolvedTrack best = resolver.pickBestCandidate(items(
            candidate("LIVE00000ID", "Queen - Bohemian Rhapsody (Live Aid)", "Queen Official", 357)
        ));

        assertNull("Un live seul, sans version studio disponible, ne doit pas passer le seuil", best);
    }

    @Test
    public void cas6ter_liveDemandeExplicitement_pasDePenalite() {
        // Si l'utilisateur cherche explicitement le live, le mot ne doit PAS pénaliser.
        NewPipeResolver resolver = new NewPipeResolver("Queen", "Bohemian Rhapsody Live Aid", 357);

        NewPipeResolver.ResolvedTrack best = resolver.pickBestCandidate(items(
            candidate("LIVE00000ID", "Queen - Bohemian Rhapsody (Live Aid)", "Queen Official", 357)
        ));

        assertNotNull("'live' présent dans la requête d'origine → pas de pénalité", best);
        assertEquals("LIVE00000ID", best.videoId);
    }

    // ────────────────────────────────────────────────────────────────
    // CAS 7 — Edge case technique : durée manquante côté candidat
    // NewPipe peut renvoyer duration = 0 ou -1. Pas de crash, candidat
    // traité en score dégradé (durée invérifiable ≠ bonus durée).
    // ────────────────────────────────────────────────────────────────
    @Test
    public void cas7_dureeManquanteCandidat_pasDeCrash() {
        NewPipeResolver resolver = new NewPipeResolver("Daft Punk", "Get Lucky", 248);

        // Ne doit surtout pas lever d'exception
        NewPipeResolver.ResolvedTrack best = resolver.pickBestCandidate(items(
            candidate("NODUR0000ID", "Get Lucky (Radio Edit)", "Daft Punk - Topic", null), // durée manquante (null)
            candidate("NEGDUR000ID", "Get Lucky (Radio Edit)", "Daft Punk - Topic", -1),   // durée invalide
            candidate("ZERODUR00ID", "Get Lucky", "RandomUploader", 0),                     // durée zéro
            candidate("GOODDUR00ID", "Get Lucky (Radio Edit)", "Daft Punk - Topic", 248)   // durée vérifiée
        ));

        assertNotNull(best);
        assertEquals("À qualité égale, le candidat à durée vérifiée doit gagner",
            "GOODDUR00ID", best.videoId);
    }

    @Test
    public void cas7bis_dureeMetadonneesManquante_pasDeCrash() {
        // durationSec absent côté métadonnées (null) : le matching de durée est
        // désactivé mais le reste du scoring fonctionne.
        NewPipeResolver resolver = new NewPipeResolver("Daft Punk", "Get Lucky", null);

        NewPipeResolver.ResolvedTrack best = resolver.pickBestCandidate(items(
            candidate("TOPIC0000ID", "Get Lucky (Radio Edit)", "Daft Punk - Topic", 248)
        ));

        assertNotNull("durationSec null ne doit pas empêcher un match Topic solide", best);
        assertEquals("TOPIC0000ID", best.videoId);
    }

    // ────────────────────────────────────────────────────────────────
    // Robustesse générale
    // ────────────────────────────────────────────────────────────────
    @Test
    public void listeVide_retourneNull() {
        NewPipeResolver resolver = new NewPipeResolver("Adele", "Hello", 295);
        assertNull(resolver.pickBestCandidate(new ArrayList<>()));
        assertNull(resolver.pickBestCandidate(null));
    }

    @Test
    public void candidatChampsNull_pasDeCrash() {
        // Titre/uploader null ne doivent jamais faire crasher le scoring.
        NewPipeResolver resolver = new NewPipeResolver("Adele", "Hello", 295);
        NewPipeResolver.ResolvedTrack best = resolver.pickBestCandidate(items(
            new NewPipeResolver.Candidate(null, null, null, null)
        ));
        assertNull("Un candidat vide ne doit ni matcher ni crasher", best);
    }

    // ════════════════════════════════════════════════════════════════
    // CAS DE NON-RÉGRESSION ajoutés après l'audit du scoring.
    // Chacun ÉCHOUAIT avec l'algorithme précédent.
    // ════════════════════════════════════════════════════════════════

    /** L'artiste était testé par SOUS-CHAÎNE : "airplane".contains("air") suffisait
     *  à décrocher le bonus artiste. Chercher Air donnait un mix de chillout. */
    @Test
    public void artisteCourt_neDoitPasMatcherParSousChaine() {
        NewPipeResolver resolver = new NewPipeResolver("Air", "La Femme d'Argent", 429);

        NewPipeResolver.ResolvedTrack best = resolver.pickBestCandidate(items(
            candidate("AIRPLANE01X", "La Femme d'Argent", "Airplane Chillout Mix", 429),
            candidate("AIRTOPIC01X", "La Femme d'Argent", "Air - Topic", 429)
        ));

        assertNotNull(best);
        assertEquals("AIRTOPIC01X", best.videoId);
    }

    /** Le bonus "chaîne officielle" était accordé à N'IMPORTE quelle chaîne Topic,
     *  y compris celle d'un autre artiste ayant un morceau homonyme. */
    @Test
    public void chaineTopicDunAutreArtiste_neDoitPasGagner() {
        NewPipeResolver resolver = new NewPipeResolver("Sia", "Alive", 264);

        NewPipeResolver.ResolvedTrack best = resolver.pickBestCandidate(items(
            candidate("PEARLJAM01X", "Alive", "Pearl Jam - Topic", 264),
            candidate("SIATOPIC01X", "Alive", "Sia - Topic", 264)
        ));

        assertNotNull(best);
        assertEquals("SIATOPIC01X", best.videoId);
    }

    /** Le couperet à 4s rendait des morceaux introuvables : un master officiel
     *  qui diffère de 5s du référentiel Deezer renvoyait null. */
    @Test
    public void ecartDureeDeQuelquesSecondes_doitResterTrouvable() {
        NewPipeResolver resolver = new NewPipeResolver("Radiohead", "Creep", 238);

        NewPipeResolver.ResolvedTrack best = resolver.pickBestCandidate(items(
            candidate("CREEPTOPIC1", "Creep", "Radiohead - Topic", 233) // 5s d'écart
        ));

        assertNotNull(best);
        assertEquals("CREEPTOPIC1", best.videoId);
    }

    /** Un écart de durée VRAIMENT grand reste un rejet : ce n'est pas le même
     *  enregistrement (album entier, version accélérée, clip avec intro). */
    @Test
    public void ecartDureeEnorme_doitToujoursEtreRejete() {
        NewPipeResolver resolver = new NewPipeResolver("Radiohead", "Creep", 238);

        NewPipeResolver.ResolvedTrack best = resolver.pickBestCandidate(items(
            candidate("ALBUMFULL01", "Creep", "Radiohead - Topic", 2800) // album entier
        ));

        assertNull(best);
    }

    /** normalizeBasic() faisait [^a-z0-9] : tout script non latin devenait une
     *  chaîne vide, donc ces catalogues étaient structurellement irrésolvables. */
    @Test
    public void titreNonLatin_doitEtreResolvable() {
        NewPipeResolver resolver = new NewPipeResolver("\u7c73\u6d25\u7384\u5e2b", "Lemon", 256);

        NewPipeResolver.ResolvedTrack best = resolver.pickBestCandidate(items(
            candidate("LEMONTOPIC1", "Lemon", "\u7c73\u6d25\u7384\u5e2b - Topic", 256)
        ));

        assertNotNull(best);
        assertEquals("LEMONTOPIC1", best.videoId);
    }

    /** "Radio Edit" / "Explicit" sont les tags de la version CANONIQUE. Les
     *  pénaliser faisait perdre l'officiel face à un réupload sans tag. */
    @Test
    public void tagsDeVersionOfficielle_neDoiventPasPenaliser() {
        NewPipeResolver resolver = new NewPipeResolver("Daft Punk", "Get Lucky", 248);

        NewPipeResolver.ResolvedTrack best = resolver.pickBestCandidate(items(
            candidate("REUPLOAD01X", "Daft Punk - Get Lucky", "Top Music FR", 248),
            candidate("OFFICIEL01X", "Get Lucky (Radio Edit)", "Daft Punk - Topic", 248)
        ));

        assertNotNull(best);
        assertEquals("OFFICIEL01X", best.videoId);
    }

    /** Un item du catalogue YouTube Music n'a PAS le suffixe " - Topic" : sans le
     *  drapeau fromMusicCatalog, il perdrait le bonus de source officielle. */
    @Test
    public void itemDuCatalogueMusic_estTraiteCommeSourceOfficielle() {
        NewPipeResolver resolver = new NewPipeResolver("Stromae", "Alors on danse", 205);

        NewPipeResolver.Candidate reupload = new NewPipeResolver.Candidate(
            "Stromae - Alors on danse", "Top Music FR", 205,
            "https://www.youtube.com/watch?v=REUPLOADXXX", false, 900000L);
        NewPipeResolver.Candidate music = new NewPipeResolver.Candidate(
            "Alors on danse", "Stromae", 205,
            "https://music.youtube.com/watch?v=MUSICCATXXX", true, 500000L);

        NewPipeResolver.ResolvedTrack best = resolver.pickBestCandidate(items(reupload, music));

        assertNotNull(best);
        assertEquals("MUSICCATXXX", best.videoId);
    }

    /** Une reprise par un autre artiste ne doit jamais l'emporter, même avec un
     *  titre parfaitement écrit et une durée exacte. */
    @Test
    public void repriseParAutreArtiste_doitPerdre() {
        NewPipeResolver resolver = new NewPipeResolver("Jeff Buckley", "Hallelujah", 414);

        NewPipeResolver.ResolvedTrack best = resolver.pickBestCandidate(items(
            candidate("COVERAMAT01", "Hallelujah (Cover)", "Sarah Sings", 414),
            candidate("BUCKLEYTOP1", "Hallelujah", "Jeff Buckley - Topic", 414)
        ));

        assertNotNull(best);
        assertEquals("BUCKLEYTOP1", best.videoId);
    }
}
