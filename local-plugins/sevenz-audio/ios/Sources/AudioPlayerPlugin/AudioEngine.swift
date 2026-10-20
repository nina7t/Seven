import Foundation
import AVFoundation
import YouTubeKit
import MediaPlayer
import UIKit

// MARK: - Modèles

struct TrackMeta {
    var videoId: String = ""
    var title: String = ""
    var artist: String = ""
    var thumb: String = ""
}

struct UpcomingTrack {
    let videoId: String
    let title: String
    let artist: String
    let thumb: String
}

private struct CachedUrl {
    let url: String
    let expiresAt: Date
}

// MARK: - AudioEngine
//
// Port iOS du AudioService Android : deux AVPlayer, crossfade equal-power
// (cos/sin), file d'avance native pour la lecture écran éteint, Now Playing +
// Remote Command Center. Tous les callbacks tournent sur le main thread ;
// la session audio .playback + le background mode "audio" gardent le process
// vivant pendant la lecture.

final class AudioEngine: NSObject {

    static let shared = AudioEngine()

    /// Callback vers le plugin Capacitor : (eventName, payload)
    var eventSink: ((_ event: String, _ data: [String: Any]) -> Void)?

    // MARK: Constantes (reprises d'AudioService.java)
    private let fadeInMs: Double = 1200
    private let fadeStepSec: Double = 0.040          // FADE_STEP_MS = 40
    private let requestNextLeadSec: Double = 14.0    // REQUEST_NEXT_LEAD_MS = 14000
    private let checkIntervalSec: Double = 0.3       // CROSSFADE_CHECK_INTERVAL_MS = 300
    private let urlTtlFallbackSec: TimeInterval = 90 * 60
    private let urlSafetyMarginSec: TimeInterval = 5 * 60
    private let urlCacheMax = 200

    // MARK: État
    private var player: AVPlayer?
    private var nextPlayer: AVPlayer?
    private var current = TrackMeta()
    private var nextMeta = TrackMeta()

    private(set) var crossfadeMs: Int = 0
    private var crossfadeRunning = false
    private var fadeOutStarted = false
    private var nextTrackRequested = false
    private var pendingFadeIn = false
    private var fadeGen = 0
    private var playGen = 0

    private var timeObserver: Any?
    private var itemEndObserver: NSObjectProtocol?
    private var itemStatusObs: NSKeyValueObservation?
    private var nextItemStatusObs: NSKeyValueObservation?
    private var rateObs: NSKeyValueObservation?
    private var fadeTimer: Timer?

    private var urlCache: [String: CachedUrl] = [:]
    private var upcoming: [UpcomingTrack] = []

    /// URL primaire + fallback proxy pour l'item courant et le prochain.
    private var currentFallbackUrl: String?
    private var nextFallbackUrl: String?
    private var retriedWithProxy = false

    // Valeurs lues par getPosition() (pollé ~1/s par le JS)
    private var lastPosSec: Double = 0
    private var lastDurSec: Double = 0
    private var lastIsPlaying = false

    private lazy var proxyBase: String = AudioEngine.loadProxyBase()

    private override init() {
        super.init()
        setupAudioObservers()
        setupRemoteCommands()
    }

    // MARK: - Config

    /// Base du backend lue depuis public/config.js embarqué (même valeur que le JS).
    static func resolutionProxyBase() -> String { loadProxyBase() }

    /// Lit `proxyUrl` depuis public/config.js embarqué (même valeur que le JS).
    private static func loadProxyBase() -> String {
        if let url = Bundle.main.url(forResource: "config", withExtension: "js", subdirectory: "public"),
           let text = try? String(contentsOf: url, encoding: .utf8),
           let range = text.range(of: "proxyUrl\\s*:\\s*'([^']+)'", options: .regularExpression) {
            let match = text[range]
            if let q1 = match.firstIndex(of: "'"), let q2 = match.lastIndex(of: "'"), q2 > q1 {
                return String(match[match.index(after: q1)..<q2])
            }
        }
        return "https://seven-hjai.onrender.com/api"
    }

    func setCrossfade(durationMs: Int) {
        crossfadeMs = max(0, durationMs)
        if crossfadeMs <= 0 {
            abortCrossfade()
        }
        debug("[xfade] setCrossfade=\(crossfadeMs)ms")
    }

    func setUpcoming(tracks: [UpcomingTrack]) {
        upcoming = tracks
    }

    func consumeUpcoming(_ videoId: String) {
        if let idx = upcoming.firstIndex(where: { $0.videoId == videoId }) {
            upcoming.remove(at: idx)
        }
    }

    // MARK: - Lecture principale

    /// Joue un videoId : résout l'URL audio via le backend puis lance AVPlayer.
    /// Retourne l'erreur via completion (nil = succès). `gen` protège des appels
    /// obsolètes ("Superseded" côté JS).
    func play(videoId: String, title: String, artist: String, thumb: String,
              completion: @escaping (String?) -> Void) -> Int {
        playGen += 1
        let gen = playGen
        abortCrossfade()
        stopCurrent()

        current = TrackMeta(videoId: videoId, title: title, artist: artist, thumb: thumb)
        retriedWithProxy = false

        resolveAudio(videoId: videoId) { [weak self] primary, fallback, err in
            guard let self = self else { return }
            guard gen == self.playGen else { completion("Superseded"); return }
            if let primary = primary {
                guard gen == self.playGen else { completion("Superseded"); return }
                self.currentFallbackUrl = fallback
                self.startPlayback(urlString: primary, autoplay: true)
                completion(nil)
            } else {
                completion(err ?? "Résolution impossible")
            }
        }
        return gen
    }

    /// Lecture directe d'une URL (méthode `play` legacy).
    func play(url: String, title: String, artist: String, thumb: String) {
        playGen += 1
        abortCrossfade()
        stopCurrent()
        current = TrackMeta(videoId: "", title: title, artist: artist, thumb: thumb)
        currentFallbackUrl = nil
        retriedWithProxy = true
        startPlayback(urlString: url, autoplay: true)
    }

    func pause() {
        player?.pause()
        updateNowPlayingRate()
        lastIsPlaying = false
        emit("playbackStateChanged", ["isPlaying": false])
    }

    func resume() {
        guard let p = player else { return }
        p.play()
        if crossfadeMs > 0 { startFadeInIfNeeded() }
        updateNowPlayingRate()
    }

    func stop() {
        playGen += 1
        abortCrossfade()
        stopCurrent()
        lastIsPlaying = false
        lastPosSec = 0
        lastDurSec = 0
        emit("playbackStateChanged", ["isPlaying": false])
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    }

    func seekTo(seconds: Double) {
        let t = CMTime(seconds: max(0, seconds), preferredTimescale: 600)
        player?.seek(to: t, toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
            self?.refreshCachedPosition()
            self?.updateNowPlayingRate()
        }
        // Un seek annule un fondu en cours (comportement Android).
        if fadeOutStarted || crossfadeRunning { abortCrossfade() }
        nextTrackRequested = false
    }

    func isPlaying() -> Bool { lastIsPlaying }

    func getPosition() -> (position: Double, duration: Double, isPlaying: Bool) {
        refreshCachedPosition()
        return (lastPosSec, lastDurSec, lastIsPlaying)
    }

    // MARK: - Préload / prochaine piste

    func preload(videoId: String, completion: @escaping (Bool) -> Void) {
        if cachedUrl(for: videoId) != nil { completion(true); return }
        resolveAudio(videoId: videoId) { primary, _, _ in
            completion(primary != nil)
        }
    }

    func getPreloadedUrl(videoId: String) -> String? { cachedUrl(for: videoId) }

    func clearPreloadCache() { urlCache.removeAll() }

    /// Prépare le prochain player pour le crossfade (action LOAD_NEXT).
    func loadNextTrack(videoId: String, title: String, artist: String, thumb: String,
                       completion: @escaping (String?) -> Void) {
        guard crossfadeMs > 0, !crossfadeRunning else {
            completion("Crossfade désactivé ou déjà en cours")
            return
        }
        let gen = playGen
        nextMeta = TrackMeta(videoId: videoId, title: title, artist: artist, thumb: thumb)

        resolveAudio(videoId: videoId) { [weak self] primary, fallback, err in
            guard let self = self else { return }
            guard gen == self.playGen else { completion("Superseded"); return }
            if let primary = primary {
                self.nextFallbackUrl = fallback
                self.prepareNextPlayer(urlString: primary)
                completion(nil)
            } else {
                completion(err ?? "Résolution impossible")
            }
        }
    }

    func cancelCrossfade() { abortCrossfade() }

    // MARK: - Moteur interne

    private func makePlayer(urlString: String) -> AVPlayer? {
        guard let url = URL(string: urlString) else { return nil }
        let item = AVPlayerItem(url: url)
        let p = AVPlayer(playerItem: item)
        p.automaticallyWaitsToMinimizeStalling = true
        return p
    }

    private func startPlayback(urlString: String, autoplay: Bool) {
        guard let p = makePlayer(urlString: urlString) else {
            emitPlaybackError(name: "INVALID_URL", videoId: current.videoId)
            return
        }
        player = p
        p.volume = 1.0
        pendingFadeIn = false

        // Fin de piste
        if let tok = itemEndObserver { NotificationCenter.default.removeObserver(tok) }
        if let item = p.currentItem {
            itemEndObserver = NotificationCenter.default.addObserver(
                forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main
            ) { [weak self] _ in self?.onTrackEnded() }
        }

        // État de l'item (ready / failed)
        itemStatusObs = p.currentItem?.observe(\.status, options: [.new]) { [weak self] item, _ in
            self?.onItemStatus(item)
        }
        // Play/pause effectif
        rateObs = p.observe(\.timeControlStatus, options: [.new]) { [weak self] pl, _ in
            self?.onTimeControlStatus(pl)
        }

        if autoplay {
            // Fade-in si crossfade configuré (comportement mono-player Android).
            if crossfadeMs > 0 {
                p.volume = 0
                pendingFadeIn = true
            }
            p.play()
        }

        startProgressObserver()
        updateNowPlaying()
        refreshCachedPosition()
    }

    private func stopCurrent() {
        if let tok = itemEndObserver { NotificationCenter.default.removeObserver(tok); itemEndObserver = nil }
        itemStatusObs = nil
        rateObs = nil
        if let obs = timeObserver, let p = player { p.removeTimeObserver(obs) }
        timeObserver = nil
        player?.pause()
        player?.replaceCurrentItem(with: nil)
        player = nil
    }

    private func prepareNextPlayer(urlString: String) {
        guard crossfadeMs > 0, !crossfadeRunning else { return }
        releaseNextPlayer()
        guard let p = makePlayer(urlString: urlString) else { return }
        p.volume = 0
        nextPlayer = p
        nextItemStatusObs = p.currentItem?.observe(\.status, options: [.new]) { [weak self] item, _ in
            if item.status == .failed {
                // Le prochain player a échoué : on le libère → le déclencheur
                // retombera sur le fondu mono-player.
                self?.releaseNextPlayer()
            }
        }
        debug("[xfade] next player prepared")
    }

    private func releaseNextPlayer() {
        nextItemStatusObs = nil
        nextPlayer?.pause()
        nextPlayer?.replaceCurrentItem(with: nil)
        nextPlayer = nil
    }

    // MARK: - Crossfade

    private func onPeriodicTick() {
        guard let p = player, let item = p.currentItem else { return }
        let pos = item.currentTime().seconds
        let dur = item.duration.seconds
        guard pos.isFinite, dur.isFinite, dur > 0 else { return }

        lastPosSec = pos
        lastDurSec = dur

        // Détection de fin via durée (didPlayToEndTime reste le signal principal)
        let remaining = dur - pos
        guard crossfadeMs > 0, !fadeOutStarted, p.timeControlStatus != .paused else { return }

        let effectiveCf = min(Double(crossfadeMs) / 1000.0, dur / 2.0)

        // Demande anticipée du prochain titre à JS (extraction ~1-3 s côté serveur).
        if !nextTrackRequested && remaining <= effectiveCf + requestNextLeadSec {
            nextTrackRequested = true
            emit("requestNextTrack", [:])
            debug("[xfade] requestNextTrack (reste \(Int(remaining))s)")
        }

        if remaining <= effectiveCf {
            if let np = nextPlayer, let nitem = np.currentItem, nitem.status == .readyToPlay {
                startRealCrossfade(remainingSec: remaining)
            } else {
                startFadeOutFallback(remainingSec: remaining)
            }
        }
    }

    private func startRealCrossfade(remainingSec: Double) {
        let durSec = max(0.5, min(Double(crossfadeMs) / 1000.0, remainingSec))
        crossfadeRunning = true
        fadeOutStarted = true
        nextPlayer?.play()
        startVolumeRamp(out: player, in: nextPlayer, durSec: durSec) { [weak self] in
            self?.promoteNextPlayer()
        }
        debug("[xfade] crossfade démarré (\(Int(durSec))s)")
    }

    private func startFadeOutFallback(remainingSec: Double) {
        let durSec = max(0.5, min(Double(crossfadeMs) / 1000.0, remainingSec))
        fadeOutStarted = true
        debug("[xfade] fallback fade-out (next pas prêt)")
        startVolumeRamp(out: player, in: nil, durSec: durSec) { }
    }

    private func startFadeInIfNeeded() {
        guard pendingFadeIn else { return }
        pendingFadeIn = false
        startVolumeRamp(out: nil, in: player, durSec: fadeInMs / 1000.0) { }
    }

    /// Rampe equal-power : sortie cos(t·π/2), entrée sin(t·π/2), phase-lockée
    /// dans un seul timer — identique à startVolumeRamp() Android.
    private func startVolumeRamp(out outP: AVPlayer?, in inP: AVPlayer?, durSec: Double,
                                 onComplete: @escaping () -> Void) {
        fadeTimer?.invalidate()
        fadeGen += 1
        let gen = fadeGen
        let startAt = ProcessInfo.processInfo.systemUptime
        let outFrom = outP?.volume ?? 1.0

        fadeTimer = Timer.scheduledTimer(withTimeInterval: fadeStepSec, repeats: true) { [weak self] timer in
            guard let self = self, gen == self.fadeGen else { timer.invalidate(); return }
            let t = min(1.0, (ProcessInfo.processInfo.systemUptime - startAt) / durSec)
            let angle = t * .pi / 2.0
            outP?.volume = Float(max(0, min(1, Double(outFrom) * cos(angle))))
            inP?.volume = Float(max(0, min(1, sin(angle))))
            if t >= 1.0 {
                timer.invalidate()
                self.fadeTimer = nil
                outP?.volume = 0
                inP?.volume = 1
                onComplete()
            }
        }
        if let timer = fadeTimer { RunLoop.main.add(timer, forMode: .common) }
    }

    private func abortCrossfade() {
        fadeGen += 1
        fadeTimer?.invalidate()
        fadeTimer = nil
        crossfadeRunning = false
        fadeOutStarted = false
        nextTrackRequested = false
        pendingFadeIn = false
        releaseNextPlayer()
        player?.volume = 1.0
    }

    private func promoteNextPlayer() {
        guard let np = nextPlayer else { return }
        let wasPlaying = np.rate > 0 || (player?.rate ?? 0) > 0

        // Bascule : le prochain devient le courant.
        if let tok = itemEndObserver { NotificationCenter.default.removeObserver(tok); itemEndObserver = nil }
        itemStatusObs = nil
        rateObs = nil
        if let obs = timeObserver { player?.removeTimeObserver(obs); timeObserver = nil }
        player?.pause()
        player?.replaceCurrentItem(with: nil)

        player = np
        nextPlayer = nil
        nextItemStatusObs = nil
        current = nextMeta
        currentFallbackUrl = nextFallbackUrl
        retriedWithProxy = false
        consumeUpcoming(current.videoId)

        player?.volume = 1.0
        if let item = player?.currentItem {
            itemEndObserver = NotificationCenter.default.addObserver(
                forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main
            ) { [weak self] _ in self?.onTrackEnded() }
            itemStatusObs = item.observe(\.status, options: [.new]) { [weak self] it, _ in
                self?.onItemStatus(it)
            }
        }
        rateObs = player?.observe(\.timeControlStatus, options: [.new]) { [weak self] pl, _ in
            self?.onTimeControlStatus(pl)
        }
        if !wasPlaying { player?.pause() }

        crossfadeRunning = false
        fadeOutStarted = false
        nextTrackRequested = false
        pendingFadeIn = false

        startProgressObserver()
        updateNowPlaying()
        refreshCachedPosition()
        emit("playbackStateChanged", ["isPlaying": lastIsPlaying])
        emit("trackChanged", ["videoId": current.videoId])
        debug("[xfade] piste promue: \(current.videoId)")
    }

    // MARK: - Fin de piste / avance

    private func onTrackEnded() {
        if crossfadeRunning { return } // la rampe gère la promotion
        if let np = nextPlayer, np.currentItem?.status == .readyToPlay {
            promoteNextPlayer()
            return
        }
        releaseNextPlayer()
        fadeOutStarted = false
        nextTrackRequested = false

        // Avance native si la file a des titres (JS endormi possible).
        if let next = upcoming.first {
            upcoming.removeFirst()
            let vid = next.videoId
            current = TrackMeta(videoId: vid, title: next.title, artist: next.artist, thumb: next.thumb)
            debug("[queue] avance native → \(vid)")
            resolveAudio(videoId: vid) { [weak self] primary, fallback, _ in
                guard let self = self else { return }
                if let primary = primary {
                    self.currentFallbackUrl = fallback
                    self.retriedWithProxy = false
                    self.stopCurrent()
                    self.startPlayback(urlString: primary, autoplay: true)
                    self.emit("trackChanged", ["videoId": vid])
                } else {
                    self.emit("trackEnded", [:])
                }
            }
        } else {
            emit("trackEnded", [:])
        }
    }

    // MARK: - Observers

    private func onItemStatus(_ item: AVPlayerItem) {
        switch item.status {
        case .readyToPlay:
            if pendingFadeIn { startFadeInIfNeeded() }
            refreshCachedPosition()
            updateNowPlaying()
        case .failed:
            onPlaybackFailure(item)
        default:
            break
        }
    }

    private func onPlaybackFailure(_ item: AVPlayerItem) {
        // Un échec sur l'URL directe googlevideo retente via le proxy une fois.
        if !retriedWithProxy, let fb = currentFallbackUrl, !fb.isEmpty {
            retriedWithProxy = true
            debug("[audio] échec URL directe, retry via proxy")
            startPlayback(urlString: fb, autoplay: true)
            return
        }
        emitPlaybackError(
            name: item.error.map { String(describing: $0) } ?? "SOURCE",
            videoId: current.videoId
        )
    }

    private func onTimeControlStatus(_ p: AVPlayer) {
        let playing = p.timeControlStatus == .playing || (p.timeControlStatus == .waitingToPlayAtSpecifiedRate && p.rate != 0)
        // timeControlStatus .waitingToPlayAtSpecifiedRate = buffering → ne pas basculer "paused"
        if p.timeControlStatus == .waitingToPlayAtSpecifiedRate { return }
        if playing != lastIsPlaying {
            lastIsPlaying = playing
            emit("playbackStateChanged", ["isPlaying": playing])
        }
        updateNowPlayingRate()
    }

    private func refreshCachedPosition() {
        if let item = player?.currentItem {
            let pos = item.currentTime().seconds
            let dur = item.duration.seconds
            if pos.isFinite { lastPosSec = pos }
            if dur.isFinite { lastDurSec = dur }
        }
        lastIsPlaying = (player?.rate ?? 0) > 0 || player?.timeControlStatus == .playing
    }

    private func startProgressObserver() {
        if let obs = timeObserver, let p = player { p.removeTimeObserver(obs) }
        timeObserver = player?.addPeriodicTimeObserver(
            forInterval: CMTime(seconds: checkIntervalSec, preferredTimescale: 30),
            queue: .main
        ) { [weak self] _ in self?.onPeriodicTick() }
    }

    // MARK: - Résolution d'URL (backend)

    private func cachedUrl(for videoId: String) -> String? {
        guard let entry = urlCache[videoId] else { return nil }
        if entry.expiresAt <= Date() { urlCache.removeValue(forKey: videoId); return nil }
        return entry.url
    }

    private func storeUrl(_ url: String, for videoId: String) {
        if urlCache.count >= urlCacheMax { urlCache.removeAll() }
        // Expiration : param `expire=` (unix ts) de l'URL googlevideo, sinon 90 min.
        var ttl = urlTtlFallbackSec
        if let comps = URLComponents(string: url),
           let exp = comps.queryItems?.first(where: { $0.name == "expire" })?.value,
           let ts = TimeInterval(exp) {
            ttl = max(0, ts - Date().timeIntervalSince1970 - urlSafetyMarginSec)
        }
        urlCache[videoId] = CachedUrl(url: url, expiresAt: Date().addingTimeInterval(ttl))
    }

    /// Résout videoId → (URL directe, URL proxy de secours, erreur).
    private func resolveAudio(videoId: String, completion: @escaping (String?, String?, String?) -> Void) {
        let proxyFallback = "\(proxyBase)/audio/\(videoId)?format=m4a"
        if let cached = cachedUrl(for: videoId) {
            completion(cached, proxyFallback, nil)
            return
        }
        // Extraction sur l'iPhone (IP résidentielle, comme NewPipe sur Android) ;
        // le serveur, bloqué par YouTube depuis l'hébergeur, ne sert plus que de secours.
        Task { [weak self] in
            guard let self = self else { return }
            if let local = await AudioEngine.extractLocally(videoId: videoId) {
                DispatchQueue.main.async {
                    self.storeUrl(local, for: videoId)
                    completion(local, proxyFallback, nil)
                }
            } else {
                DispatchQueue.main.async {
                    self.debug("[audio] extraction locale KO, repli serveur")
                    self.resolveViaProxy(videoId: videoId, completion: completion)
                }
            }
        }
    }

    /// Meilleur flux audio seul en m4a (AAC) : AVPlayer ne lit ni opus ni webm.
    private static func extractLocally(videoId: String) async -> String? {
        do {
            let streams = try await YouTube(videoID: videoId, methods: [.local]).streams
            let best = streams.filterAudioOnly()
                .filter { $0.fileExtension == .m4a }
                .highestAudioBitrateStream()
            return best?.url.absoluteString
        } catch {
            return nil
        }
    }

    private func resolveViaProxy(videoId: String, completion: @escaping (String?, String?, String?) -> Void) {
        guard let url = URL(string: "\(proxyBase)/stream/\(videoId)?format=m4a") else {
            completion(nil, nil, "Bad proxy URL")
            return
        }
        URLSession.shared.dataTask(with: url) { [weak self] data, _, err in
            guard let self = self else { return }
            guard let data = data, err == nil,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                DispatchQueue.main.async { completion(nil, nil, "Résolution audio impossible: \(err?.localizedDescription ?? "réponse invalide")") }
                return
            }
            let audioUrl = json["audioUrl"] as? String ?? ""
            let proxyUrl = json["proxyUrl"] as? String ?? ""
            let proxyAbsolute = proxyUrl.hasPrefix("http") ? proxyUrl : "\(self.proxyBase.replacingOccurrences(of: "/api$", with: ""))\(proxyUrl)"
            let primary = !audioUrl.isEmpty ? audioUrl : (proxyAbsolute.isEmpty ? nil : proxyAbsolute)
            let fallback = proxyAbsolute.isEmpty ? nil : proxyAbsolute
            guard let primary = primary else {
                DispatchQueue.main.async { completion(nil, nil, "Aucune URL audio retournée") }
                return
            }
            self.storeUrl(primary, for: videoId)
            DispatchQueue.main.async { completion(primary, fallback, nil) }
        }.resume()
    }

    // MARK: - Now Playing + Remote commands

    private func updateNowPlaying() {
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: current.title.isEmpty ? "Sevenz" : current.title,
            MPMediaItemPropertyArtist: current.artist,
            MPMediaItemPropertyMediaType: MPMediaType.music.rawValue
        ]
        if lastDurSec > 0 { info[MPMediaItemPropertyPlaybackDuration] = lastDurSec }
        if lastPosSec > 0 { info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = lastPosSec }
        info[MPNowPlayingInfoPropertyPlaybackRate] = lastIsPlaying ? 1.0 : 0.0
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info

        // Pochette async
        if !current.thumb.isEmpty, let url = URL(string: current.thumb) {
            let capturedThumb = current.thumb
            URLSession.shared.dataTask(with: url) { data, _, _ in
                guard let data = data, let img = UIImage(data: data) else { return }
                DispatchQueue.main.async {
                    guard self.current.thumb == capturedThumb else { return }
                    let artwork = MPMediaItemArtwork(boundsSize: img.size) { _ in img }
                    var ni = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
                    ni[MPMediaItemPropertyArtwork] = artwork
                    MPNowPlayingInfoCenter.default().nowPlayingInfo = ni
                }
            }.resume()
        }
    }

    private func updateNowPlayingRate() {
        refreshCachedPosition()
        var ni = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
        ni[MPNowPlayingInfoPropertyElapsedPlaybackTime] = lastPosSec
        ni[MPNowPlayingInfoPropertyPlaybackRate] = lastIsPlaying ? 1.0 : 0.0
        ni[MPMediaItemPropertyPlaybackDuration] = lastDurSec
        MPNowPlayingInfoCenter.default().nowPlayingInfo = ni
    }

    private func setupRemoteCommands() {
        let cc = MPRemoteCommandCenter.shared()
        cc.playCommand.addTarget { [weak self] _ in self?.resume(); return .success }
        cc.pauseCommand.addTarget { [weak self] _ in self?.pause(); return .success }
        cc.togglePlayPauseCommand.addTarget { [weak self] _ in
            guard let s = self else { return .commandFailed }
            s.lastIsPlaying ? s.pause() : s.resume()
            return .success
        }
        cc.nextTrackCommand.addTarget { [weak self] _ in
            self?.emit("skipNext", [:]); return .success
        }
        cc.previousTrackCommand.addTarget { [weak self] _ in
            self?.emit("skipPrevious", [:]); return .success
        }
        cc.changePlaybackPositionCommand.addTarget { [weak self] ev in
            guard let s = self, let e = ev as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            s.seekTo(seconds: e.positionTime)
            return .success
        }
        // ±10 s comme la notification Android
        cc.skipBackwardCommand.preferredIntervals = [10]
        cc.skipBackwardCommand.addTarget { [weak self] _ in
            guard let s = self else { return .commandFailed }
            s.seekTo(seconds: max(0, s.lastPosSec - 10)); return .success
        }
        cc.skipForwardCommand.preferredIntervals = [10]
        cc.skipForwardCommand.addTarget { [weak self] _ in
            guard let s = self else { return .commandFailed }
            s.seekTo(seconds: s.lastPosSec + 10); return .success
        }
    }

    private func setupAudioObservers() {
        let nc = NotificationCenter.default
        nc.addObserver(self, selector: #selector(onInterruption(_:)),
                       name: AVAudioSession.interruptionNotification, object: nil)
        nc.addObserver(self, selector: #selector(onRouteChange(_:)),
                       name: AVAudioSession.routeChangeNotification, object: nil)
    }

    @objc private func onInterruption(_ note: Notification) {
        guard let info = note.userInfo,
              let typeRaw = info[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: typeRaw) else { return }
        if type == .began {
            pause()
        } else if type == .ended {
            let optRaw = info[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
            if AVAudioSession.InterruptionOptions(rawValue: optRaw).contains(.shouldResume) {
                resume()
            }
        }
    }

    /// Casque débranché / route perdue → pause (handleAudioBecomingNoisy Android).
    @objc private func onRouteChange(_ note: Notification) {
        guard let info = note.userInfo,
              let reasonRaw = info[AVAudioSessionRouteChangeReasonKey] as? UInt,
              let reason = AVAudioSession.RouteChangeReason(rawValue: reasonRaw),
              reason == .oldDeviceUnavailable else { return }
        pause()
    }

    // MARK: - Events / helpers

    private func emit(_ name: String, _ data: [String: Any]) {
        DispatchQueue.main.async { self.eventSink?(name, data) }
    }

    private func emitPlaybackError(name: String, videoId: String) {
        emit("playbackError", [
            "name": name,
            "videoId": videoId,
            "nativeRetry": false,
            "nativeSkipped": false
        ])
    }

    private func debug(_ msg: String) {
        emit("crossfadeDebug", ["msg": msg])
    }
}
