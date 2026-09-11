package com.sevenz.app.resolver;

import android.util.Log;

import com.sevenz.app.plugin.DownloaderImpl;

import org.schabi.newpipe.extractor.InfoItem;
import org.schabi.newpipe.extractor.NewPipe;
import org.schabi.newpipe.extractor.StreamingService;
import org.schabi.newpipe.extractor.linkhandler.SearchQueryHandler;
import org.schabi.newpipe.extractor.search.SearchInfo;
import org.schabi.newpipe.extractor.stream.AudioStream;
import org.schabi.newpipe.extractor.stream.StreamInfo;
import org.schabi.newpipe.extractor.stream.StreamInfoItem;
import org.schabi.newpipe.extractor.stream.StreamType;
import org.schabi.newpipe.extractor.services.youtube.linkHandler.YoutubeSearchQueryHandlerFactory;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.text.Normalizer;

/**
 * Résolveur NewPipeExtractor avec scoring.
 * Prend un objet { artist, title, durationSec } officiel (issue de Deezer/Spotify)
 * et retourne le meilleur candidat YouTube, ou null si aucun ne dépasse le seuil.
 */
public class NewPipeResolver {

    private static final String TAG = "NewPipeResolver";

    // Nombre de candidats scorés. 10 ne suffisait pas : sur un titre noyé sous les
    // reprises, la chaîne officielle peut arriver au-delà du 10e rang YouTube.
    private static final int MAX_CANDIDATES = 20;

    // Filtre de recherche YouTube MUSIC : interroge le catalogue officiel
    // (celui de YouTube Music), où les reprises amateur, karaokés, nightcore et
    // réuploads pirates n'existent tout simplement pas. C'est le même corpus que
    // celui d'un service de streaming classique.
    private static final List<String> MUSIC_FILTER =
        Collections.singletonList(YoutubeSearchQueryHandlerFactory.MUSIC_SONGS);

    // ─── Pondération du score final (0-1) ───
    private static final double W_TEXT_SIMILARITY = 0.40;
    private static final double W_DURATION_MATCH  = 0.25;
    private static final double W_TOPIC_CHANNEL   = 0.20;
    private static final double W_ARTIST_IN_UPLOADER = 0.15;

    // Seuils
    private static final double CONFIDENCE_THRESHOLD = 0.55; // en dessous = pas de match fiable
    // Au-delà, ce n'est plus le même enregistrement (clip avec intro, album entier,
    // version accélérée). En deçà, on dégrade progressivement au lieu de rejeter :
    // un couperet à 4s rendait introuvables des morceaux dont le master officiel
    // diffère de 5s du référentiel Deezer.
    private static final int DURATION_REJECT_SEC = 20;

    // Quand l'artiste n'est attesté NULLE PART, le score est écrasé : un titre qui
    // correspond parfaitement ne doit jamais compenser un artiste absent.
    private static final double NO_ARTIST_PENALTY_FACTOR = 0.35;

    // Variantes RÉDHIBITOIRES : ce n'est pas l'enregistrement demandé.
    private static final Set<String> HARD_VARIANTS = new HashSet<>(Arrays.asList(
        "cover", "remix", "live", "sped up", "slowed", "nightcore", "instrumental",
        "karaoke", "tribute", "parody", "mashup", "bootleg", "acapella", "a capella",
        "unplugged", "en vivo", "ao vivo", "en directo", "en concierto", "reprise",
        "full album", "album completo"
    ));
    // Variantes SUSPECTES mais pas disqualifiantes.
    private static final Set<String> SOFT_VARIANTS = new HashSet<>(Arrays.asList(
        "reverb", "8d", "extended", "chipmunk", "bass boosted", "demo",
        "session", "sesion", "concert", "radio mix"
    ));
    // NOTE : "edit", "clean" et "explicit" ont été RETIRÉS de ces listes. Ce sont
    // les tags de la version CANONIQUE ("Radio Edit", "Explicit") : les pénaliser
    // faisait perdre la version officielle au profit d'un réupload sans tag.
    private static final double HARD_PENALTY = 0.30;
    private static final double SOFT_PENALTY = 0.10;
    private static final double MAX_PENALTY  = 0.60;

    // Mots vides ignorés quand on compare un nom d'artiste.
    private static final Set<String> ARTIST_STOPWORDS = new HashSet<>(Arrays.asList(
        "the", "les", "la", "le", "de", "du", "des", "and", "of", "el", "los",
        "der", "die", "das"
    ));
    // Habillage des noms de chaîne, à retirer avant comparaison avec l'artiste.
    private static final Set<String> CHANNEL_NOISE = new HashSet<>(Arrays.asList(
        "topic", "vevo", "official", "officiel", "music", "musique", "musica",
        "records", "recordings", "channel", "tv", "band", "group", "entertainment"
    ));

    // Les regex de containsWord étaient recompilées à chaque appel (~200 par
    // résolution). Mémoïsées ici.
    private static final Map<String, Pattern> WORD_PATTERNS = new HashMap<>();

    // Featurings déclarés côté métadonnées : "Titre (feat. X)" -> {x}
    private static final Pattern FEAT_PATTERN = Pattern.compile(
        "(?i)(?:feat\\.?|ft\\.?|featuring|avec|with|&|,)\\s*([^()\\[\\]]+)");

    private final String artist;
    private final String title;
    private final Integer durationSec;
    private final String query;
    /** Artistes invités déclarés dans le titre officiel ("feat. X"). */
    private final Set<String> featTokens;

    public NewPipeResolver(String artist, String title, Integer durationSec) {
        this.artist = artist == null ? "" : artist;
        this.title = title == null ? "" : title;
        this.durationSec = durationSec;
        this.query = buildSearchQuery(this.artist, this.title);
        this.featTokens = featuredTokens(this.title);
    }

    /**
     * Lance la recherche, score les N premiers résultats et retourne le meilleur.
     * Retourne null si aucun candidat ne dépasse le seuil de confiance.
     */
    public ResolvedTrack resolve() throws Exception {
        ensureNewPipeInitialized();
        StreamingService service = NewPipe.getService(0); // 0 = YouTube

        // Passe 1 : catalogue officiel YouTube Music. C'est LA réponse au problème
        // des « vieilles reprises pourries » : elles n'y figurent pas.
        List<InfoItem> musicItems = fetchSearchResults(service, query, MUSIC_FILTER);
        ResolvedTrack best = pickBest(musicItems, true);
        if (best != null) {
            Log.i(TAG, "Match trouvé dans le catalogue YouTube Music");
            return best;
        }

        // Passe 2 : recherche YouTube classique (repli). Si la passe 1 échoue ou
        // ne renvoie rien, on retombe EXACTEMENT sur le comportement précédent.
        Log.d(TAG, "Rien dans YouTube Music -> repli recherche classique");
        List<InfoItem> items = fetchSearchResults(service, query, Collections.<String>emptyList());
        if (items.isEmpty()) {
            Log.w(TAG, "Aucun résultat NewPipe pour: " + query);
            return null;
        }
        return pickBest(items, false);
    }

    /**
     * Adaptateur NewPipe → structure neutre : convertit les StreamInfoItem en
     * Candidate puis délègue au scoring pur (pickBestCandidate).
     */
    public ResolvedTrack pickBest(List<InfoItem> items) {
        return pickBest(items, false);
    }

    public ResolvedTrack pickBest(List<InfoItem> items, boolean fromMusicCatalog) {
        if (items == null || items.isEmpty()) return null;

        List<Candidate> candidates = new ArrayList<>();
        for (InfoItem item : items) {
            if (!(item instanceof StreamInfoItem)) continue;
            StreamInfoItem stream = (StreamInfoItem) item;
            // Un direct ou un Short n'est jamais l'enregistrement studio demandé.
            StreamType type = stream.getStreamType();
            if (type == StreamType.LIVE_STREAM || type == StreamType.AUDIO_LIVE_STREAM) continue;
            try { if (stream.isShortFormContent()) continue; } catch (Exception ignored) {}
            candidates.add(new Candidate(
                stream.getName(),
                stream.getUploaderName(),
                stream.getDuration() > 0 ? (int) stream.getDuration() : null,
                stream.getUrl(),
                fromMusicCatalog,
                safeViewCount(stream)
            ));
        }
        return pickBestCandidate(candidates);
    }

    private static long safeViewCount(StreamInfoItem s) {
        try { return Math.max(0L, s.getViewCount()); } catch (Exception e) { return 0L; }
    }

    /**
     * Scoring PUR : prend une liste de candidats neutres (aucune dépendance
     * NewPipe, aucun réseau) et retourne le meilleur, ou null si aucun ne
     * dépasse CONFIDENCE_THRESHOLD. C'est cette méthode qui est couverte par
     * les tests unitaires avec candidats mockés.
     */
    public ResolvedTrack pickBestCandidate(List<Candidate> candidates) {
        if (candidates == null || candidates.isEmpty()) return null;

        // normalize() retire des mots comme "live" ou "deluxe" : pour un groupe qui
        // s'appelle justement ainsi, le nom disparaîtrait entièrement.
        String normalizedArtist = normalize(artist);
        if (normalizedArtist.isEmpty()) normalizedArtist = normalizeBasic(artist);
        String normalizedTitle = normalize(title);
        // Requête "basique" (sans retrait des tags) pour la détection des variantes :
        // si l'utilisateur cherche explicitement un "remix" ou un "live", on ne
        // pénalise pas ces mots.
        String basicQuery = normalizeBasic(artist + " " + title);

        ResolvedTrack best = null;
        double bestScore = 0;
        long bestViews = -1;

        int limit = Math.min(candidates.size(), MAX_CANDIDATES);
        for (int i = 0; i < limit; i++) {
            Candidate candidate = candidates.get(i);
            Scored scored = scoreCandidate(candidate, normalizedArtist, normalizedTitle, basicQuery);

            Log.d(TAG, String.format(Locale.US,
                "Candidat #%d: score=%.3f title=%s uploader=%s duration=%s diff=%d",
                i, scored.score, candidate.videoTitle, candidate.uploaderName,
                String.valueOf(candidate.durationSec), scored.durationDiffSec));

            // À score égal, l'ancien code gardait le premier dans l'ordre YouTube,
            // c'est-à-dire arbitrairement. On départage par audience.
            boolean better = scored.score > bestScore + 1e-9
                || (Math.abs(scored.score - bestScore) < 1e-9 && candidate.viewCount > bestViews);
            if (better) {
                bestScore = scored.score;
                bestViews = candidate.viewCount;
                best = buildResolvedTrack(candidate, scored.score);
            }
        }

        if (best == null || bestScore < CONFIDENCE_THRESHOLD) {
            Log.w(TAG, "Aucun match fiable (meilleur score=" + bestScore + ") pour: " + query);
            return null;
        }

        Log.i(TAG, "Match choisi: " + best.videoId + " score=" + bestScore);
        return best;
    }

    /**
     * Récupère les résultats de recherche via NewPipeExtractor.
     */
    private List<InfoItem> fetchSearchResults(StreamingService service, String q,
                                              List<String> contentFilters) {
        try {
            SearchQueryHandler handler = contentFilters.isEmpty()
                ? service.getSearchQHFactory().fromQuery(q)
                : service.getSearchQHFactory().fromQuery(q, contentFilters, "");
            List<InfoItem> items = SearchInfo.getInfo(service, handler).getRelatedItems();
            return items == null ? Collections.<InfoItem>emptyList() : new ArrayList<>(items);
        } catch (Exception e) {
            // Une passe qui échoue ne doit JAMAIS empêcher la suivante de tourner.
            Log.w(TAG, "Recherche échouée (filtres=" + contentFilters + ")", e);
            return Collections.<InfoItem>emptyList();
        }
    }

    /**
     * Construit une requête de recherche normalisée "{artist} {title}".
     */
    private static String buildSearchQuery(String artist, String title) {
        String a = artist.trim();
        String t = title.trim();
        if (a.isEmpty()) return t;
        if (t.isEmpty()) return a;
        return a + " " + t;
    }

    /**
     * Initialise NewPipe une seule fois.
     */
    private static void ensureNewPipeInitialized() {
        if (NewPipe.getDownloader() == null) {
            NewPipe.init(DownloaderImpl.getInstance());
        }
    }

    /**
     * Calcule le score d'un candidat.
     */
    private Scored scoreCandidate(Candidate candidate,
                                  String normalizedArtist,
                                  String normalizedTitle,
                                  String basicQuery) {
        String videoTitle = candidate.videoTitle == null ? "" : candidate.videoTitle;
        String uploader = candidate.uploaderName == null ? "" : candidate.uploaderName;
        Integer videoDuration = candidate.durationSec;

        String normVideoTitle = normalize(videoTitle);
        String normUploader = normalize(uploader);
        // Version "basique" (tags conservés) pour détecter cover/remix/live/etc.
        // IMPORTANT : ne pas utiliser normalize() ici, car elle retire justement
        // ces mots -> la pénalité ne se déclencherait jamais.
        String basicCombined = normalizeBasic(uploader + " " + videoTitle);

        // 1. Score textuel (artiste + titre)
        double textScore = combinedTextScore(normalizedArtist, normalizedTitle, normVideoTitle, normUploader);

        // ── Verrou ARTISTE ────────────────────────────────────────────────
        // Avant, le test était `normUploader.contains(normalizedArtist)` : une
        // SOUS-CHAÎNE. Chercher « Air » acceptait donc « Airplane Chillout Mix ».
        // On compare maintenant des TOKENS, et on exige l'égalité stricte quand le
        // nom d'artiste est court et ambigu (Air, Yes, Muse, Eve...).
        Set<String> artistTokens = significant(tokenSet(normalizedArtist));
        Set<String> channelTokens = channelTokens(uploader);
        Set<String> titleTokens = tokenSet(normVideoTitle);

        boolean ambiguousArtist = artistTokens.size() == 1
            && artistTokens.iterator().next().length() <= 4;

        boolean mainInChannel = !artistTokens.isEmpty() && (ambiguousArtist
            ? channelTokens.equals(artistTokens)
            : channelTokens.containsAll(artistTokens));
        boolean featInChannel = !mainInChannel && intersects(featTokens, channelTokens);
        boolean mainInTitle   = !artistTokens.isEmpty() && titleTokens.containsAll(artistTokens);
        boolean featInTitle   = !mainInTitle && intersects(featTokens, titleTokens);

        double artistScore = mainInChannel ? 1.00
                           : featInChannel ? 0.85
                           : mainInTitle   ? 0.60
                           : featInTitle   ? 0.40 : 0.0;
        boolean artistMatchesChannel = mainInChannel || featInChannel;

        // 2. Matching de durée : dégradation progressive, rejet au-delà du seuil
        // Trois cas distincts :
        //  a) durée métadonnées ET candidat connues -> matching strict
        //  b) durée métadonnées absente -> critère NON APPLICABLE : on retire
        //     son poids du total (renormalisation), sinon un match parfait
        //     plafonnerait à 0.70 et raterait le seuil à tort
        //  c) durée métadonnées connue mais candidat sans durée -> candidat
        //     INVÉRIFIABLE : score dégradé (durationScore = 0, poids conservé)
        boolean metadataHasDuration = durationSec != null && durationSec > 0;
        double durationScore = 0.0;
        double applicableWeight = 1.0;
        double unknownDurationMalus = 0.0;
        int durationDiff = Integer.MAX_VALUE;
        if (metadataHasDuration && videoDuration != null && videoDuration > 0) {
            durationDiff = Math.abs(videoDuration - durationSec);
            if (durationDiff > DURATION_REJECT_SEC) {
                return new Scored(0.0, durationDiff); // autre enregistrement
            }
            if (durationDiff <= 3) {
                durationScore = 1.0;
            } else if (durationDiff <= 10) {
                durationScore = 1.0 - 0.50 * (durationDiff - 3) / 7.0;
            } else {
                durationScore = 0.50 - 0.35 * (durationDiff - 10) / 10.0;
            }
        } else if (!metadataHasDuration) {
            applicableWeight = 1.0 - W_DURATION_MATCH; // critère non applicable
        } else {
            // Candidat sans durée : invérifiable. On retire le critère mais on
            // préfère, à égalité, un candidat dont la durée est vérifiable.
            applicableWeight = 1.0 - W_DURATION_MATCH;
            unknownDurationMalus = 0.06;
        }

        // 3. Source officielle : chaîne « - Topic » OU item du catalogue YouTube
        //    Music (dont les uploaders n'ont pas le suffixe « - Topic »).
        //    Le bonus n'est accordé que si c'est la chaîne du BON artiste : avant,
        //    « Pearl Jam - Topic » touchait le bonus sur une recherche Sia.
        boolean officialSource = candidate.fromMusicCatalog
            || uploader.trim().endsWith(" - Topic");
        double topicScore = (officialSource && artistMatchesChannel) ? 1.0 : 0.0;

        // 4. Pénalité de variante, en deux niveaux. On ne scanne PAS le nom de la
        //    chaîne quand c'est la source officielle de l'artiste, sinon une chaîne
        //    nommée « ...Live » pénaliserait ses propres uploads légitimes.
        String scanned = officialSource && artistMatchesChannel
            ? normalizeBasic(videoTitle)
            : basicCombined;
        double penalty = 0.0;
        for (String variant : HARD_VARIANTS) {
            if (containsWord(scanned, variant) && !containsWord(basicQuery, variant)) {
                penalty += HARD_PENALTY;
            }
        }
        for (String variant : SOFT_VARIANTS) {
            if (containsWord(scanned, variant) && !containsWord(basicQuery, variant)) {
                penalty += SOFT_PENALTY;
            }
        }
        penalty = Math.min(penalty, MAX_PENALTY);

        double rawScore = (
            W_TEXT_SIMILARITY * textScore +
            W_DURATION_MATCH * durationScore +
            W_TOPIC_CHANNEL * topicScore +
            W_ARTIST_IN_UPLOADER * artistScore
        ) / applicableWeight; // renormalisation si le critère durée est non applicable

        double finalScore = Math.max(0.0, rawScore - penalty - unknownDurationMalus);

        // Artiste attesté nulle part : ce n'est pas « un peu moins bon », c'est
        // un autre morceau. On écrase le score plutôt que de le nuancer.
        if (artistScore == 0.0) finalScore *= NO_ARTIST_PENALTY_FACTOR;

        return new Scored(finalScore, durationDiff);
    }

    /**
     * Score textuel combinant similarité Levenshtein et recouvrement de tokens.
     */
    private double combinedTextScore(String artist, String title, String videoTitle, String uploader) {
        String official = (artist + " " + title).trim();
        String candidate = (videoTitle + " " + uploader).trim();

        if (official.isEmpty() || candidate.isEmpty()) return 0.0;

        double levSim = 1.0 - normalizedLevenshtein(official, candidate);
        double tokenSim = tokenOverlapScore(official, candidate);

        // Pondération 70% tokens (robuste aux réordonnements) + 30% Levenshtein (précis local)
        return 0.7 * tokenSim + 0.3 * levSim;
    }

    /**
     * Normalise une chaîne pour comparaison : minuscule, sans accents, sans ponctuation,
     * sans feat., sans tags "Official Video/Audio", remastered, années, etc.
     */
    public static String normalize(String input) {
        if (input == null) return "";
        return normalizeBasic(input)
            .replaceAll("(?<=^|\\s)(feat(uring)?|ft|with)(?=\\s|$)", " ")
            .replaceAll("(?<=^|\\s)(remastered|remaster|explicit|clean|hd|official video|official audio|audio|video|live|acoustic|instrumental|radio edit|extended|deluxe)(?=\\s|$)", " ")
            .replaceAll("(?<=^|\\s)(sped up|slowed|reverb|8d|nightcore)(?=\\s|$)", " ")
            .replaceAll("\\s+", " ")
            .trim();
    }

    /**
     * Normalisation légère : minuscules, sans accents, sans ponctuation.
     * Conserve les mots comme "cover", "live", "remix" (utilisée pour la
     * détection des variantes alternatives).
     */
    public static String normalizeBasic(String input) {
        if (input == null) return "";
        String s = Normalizer.normalize(input.toLowerCase(Locale.ROOT), Normalizer.Form.NFD)
            .replaceAll("[\\p{InCombiningDiacriticalMarks}]", "");
        // Recompose (le hangul coréen se décompose en jamos isolés en NFD).
        s = Normalizer.normalize(s, Normalizer.Form.NFC);
        return s
            .replaceAll("\\(\\d{4}\\)", " ")
            // [^a-z0-9] vidait entièrement japonais, coréen, cyrillique, grec, arabe :
            // ces catalogues étaient structurellement irrésolvables.
            .replaceAll("[^\\p{L}\\p{N}]", " ")
            .replaceAll("\\s+", " ")
            .trim();
    }

    /** Tokens d'un nom de chaîne, débarrassés de l'habillage : "Daft Punk - Topic"
     *  -> {daft, punk} ; "MGMTVEVO" -> {mgmt}. */
    private static Set<String> channelTokens(String uploader) {
        Set<String> out = new HashSet<>();
        for (String t : normalizeBasic(uploader).split("\\s+")) {
            if (t.isEmpty()) continue;
            if (t.length() > 4 && t.endsWith("vevo")) t = t.substring(0, t.length() - 4);
            if (CHANNEL_NOISE.contains(t) || ARTIST_STOPWORDS.contains(t)) continue;
            out.add(t);
        }
        return out;
    }

    /** Artistes invités déclarés dans le titre officiel : "Titre (feat. X)" -> {x}. */
    private static Set<String> featuredTokens(String title) {
        Matcher m = FEAT_PATTERN.matcher(title == null ? "" : title);
        StringBuilder sb = new StringBuilder();
        while (m.find()) sb.append(' ').append(m.group(1));
        return significant(tokenSet(normalize(sb.toString())));
    }

    /** Retire les mots vides d'un ensemble de tokens d'artiste. */
    private static Set<String> significant(Set<String> tokens) {
        Set<String> out = new HashSet<>();
        for (String t : tokens) {
            if (!t.isEmpty() && !ARTIST_STOPWORDS.contains(t)) out.add(t);
        }
        return out;
    }

    private static boolean intersects(Set<String> a, Set<String> b) {
        if (a == null || b == null || a.isEmpty() || b.isEmpty()) return false;
        for (String t : a) if (b.contains(t)) return true;
        return false;
    }

    private static boolean containsWord(String text, String word) {
        Pattern p;
        synchronized (WORD_PATTERNS) {
            p = WORD_PATTERNS.get(word);
            if (p == null) {
                p = Pattern.compile("(?<=^|\\s)" + Pattern.quote(word) + "(?=\\s|$)");
                WORD_PATTERNS.put(word, p);
            }
        }
        return p.matcher(text).find();
    }

    private static Set<String> tokenSet(String normalized) {
        Set<String> set = new HashSet<>();
        for (String token : normalized.split("\\s+")) {
            if (!token.isEmpty()) set.add(token);
        }
        return set;
    }

    private double tokenOverlapScore(String a, String b) {
        Set<String> tokensA = tokenSet(a);
        Set<String> tokensB = tokenSet(b);
        if (tokensA.isEmpty() || tokensB.isEmpty()) return 0.0;

        Set<String> intersection = new HashSet<>(tokensA);
        intersection.retainAll(tokensB);

        // Dice coefficient
        return (2.0 * intersection.size()) / (tokensA.size() + tokensB.size());
    }

    private double normalizedLevenshtein(String a, String b) {
        int maxLen = Math.max(a.length(), b.length());
        if (maxLen == 0) return 0.0;
        return levenshtein(a, b) / (double) maxLen;
    }

    private int levenshtein(String a, String b) {
        int[] prev = new int[b.length() + 1];
        int[] curr = new int[b.length() + 1];
        for (int j = 0; j <= b.length(); j++) prev[j] = j;

        for (int i = 1; i <= a.length(); i++) {
            curr[0] = i;
            char ca = a.charAt(i - 1);
            for (int j = 1; j <= b.length(); j++) {
                int cost = ca == b.charAt(j - 1) ? 0 : 1;
                curr[j] = Math.min(Math.min(curr[j - 1] + 1, prev[j] + 1), prev[j - 1] + cost);
            }
            int[] swap = prev; prev = curr; curr = swap;
        }
        return prev[b.length()];
    }

    /**
     * Extrait l'ID vidéo d'une URL YouTube.
     */
    private static String extractVideoId(String url) {
        if (url == null || url.isEmpty()) return null;
        Pattern pattern = Pattern.compile("(?:youtube\\.com/watch\\?v=|youtu\\.be/|youtube\\.com/embed/)([a-zA-Z0-9_-]{11})");
        Matcher matcher = pattern.matcher(url);
        return matcher.find() ? matcher.group(1) : null;
    }

    private ResolvedTrack buildResolvedTrack(Candidate candidate, double score) {
        ResolvedTrack t = new ResolvedTrack();
        t.videoId = extractVideoId(candidate.url);
        t.title = candidate.videoTitle;
        t.uploader = candidate.uploaderName;
        t.durationSec = candidate.durationSec == null ? 0 : candidate.durationSec;
        t.score = score;
        t.url = candidate.url;
        return t;
    }

    /**
     * Candidat de recherche neutre : découplé de NewPipe (StreamInfoItem)
     * pour permettre le test unitaire du scoring sans réseau.
     */
    public static class Candidate {
        public final String videoTitle;
        public final String uploaderName;
        public final Integer durationSec; // null = durée inconnue/manquante
        public final String url;
        /** Issu de la passe catalogue YouTube Music : source officielle, même si
         *  l'uploader n'a pas le suffixe « - Topic ». */
        public final boolean fromMusicCatalog;
        public final long viewCount;

        public Candidate(String videoTitle, String uploaderName, Integer durationSec) {
            this(videoTitle, uploaderName, durationSec, null, false, 0L);
        }

        public Candidate(String videoTitle, String uploaderName, Integer durationSec, String url) {
            this(videoTitle, uploaderName, durationSec, url, false, 0L);
        }

        public Candidate(String videoTitle, String uploaderName, Integer durationSec, String url,
                         boolean fromMusicCatalog, long viewCount) {
            this.videoTitle = videoTitle;
            this.uploaderName = uploaderName;
            this.durationSec = durationSec;
            this.url = url;
            this.fromMusicCatalog = fromMusicCatalog;
            this.viewCount = viewCount;
        }
    }

    private static class Scored {
        final double score;
        final int durationDiffSec;
        Scored(double score, int durationDiffSec) {
            this.score = score;
            this.durationDiffSec = durationDiffSec;
        }
    }

    /**
     * Résultat d'une résolution réussie.
     */
    public static class ResolvedTrack {
        public String videoId;
        public String title;
        public String uploader;
        public int durationSec;
        public double score;
        public String url;
        // audioUrl n'est pas rempli ici : il faut appeler StreamInfo.getInfo(url) ensuite.
        public String audioUrl;

        /**
         * Récupère le meilleur flux audio pour ce candidat.
         * Doit être appelé en arrière-plan.
         */
        public String fetchAudioUrl() throws Exception {
            ensureNewPipeInitialized();
            StreamInfo info = StreamInfo.getInfo(url);
            List<AudioStream> audioStreams = info.getAudioStreams();
            if (audioStreams == null || audioStreams.isEmpty()) return null;
            AudioStream best = Collections.max(audioStreams, new Comparator<AudioStream>() {
                @Override
                public int compare(AudioStream a, AudioStream b) {
                    return Integer.compare(a.getAverageBitrate(), b.getAverageBitrate());
                }
            });
            audioUrl = best.getUrl();
            return audioUrl;
        }
    }
}
