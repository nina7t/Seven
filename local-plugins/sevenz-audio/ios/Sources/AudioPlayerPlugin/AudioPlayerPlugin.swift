import Foundation
import Capacitor
import UIKit

/**
 * Bridge Capacitor ↔ AudioEngine.
 * Enregistré sous le nom "AudioPlayerPlugin" — le JS appelle
 * window.Capacitor.Plugins.AudioPlayerPlugin (même contrat que le plugin Android).
 */
@objc(AudioPlayerPlugin)
public class AudioPlayerPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AudioPlayerPlugin"
    public let jsName = "AudioPlayerPlugin"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "playVideo", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "play", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pause", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resume", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isPlaying", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getPosition", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "seekTo", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "skipNext", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "skipPrevious", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "preload", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getPreloadedUrl", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearPreloadCache", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setUpcoming", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setCrossfade", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelCrossfade", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "loadNextTrack", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openAudioSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resolveTrack", returnType: CAPPluginReturnPromise)
    ]

    private let engine = AudioEngine.shared

    public override func load() {
        engine.eventSink = { [weak self] event, data in
            self?.notifyListeners(event, data: data)
        }
    }

    // MARK: - Lecture

    @objc func playVideo(_ call: CAPPluginCall) {
        guard let videoId = call.getString("videoId"), !videoId.isEmpty else {
            call.reject("videoId manquant")
            return
        }
        let title = call.getString("title") ?? ""
        let artist = call.getString("artist") ?? ""
        let thumb = call.getString("thumb") ?? ""

        DispatchQueue.main.async {
            self.engine.play(videoId: videoId, title: title, artist: artist, thumb: thumb) { error in
                if let error = error {
                    call.reject(error)
                } else {
                    call.resolve(["success": true])
                }
            }
        }
    }

    /// Lecture d'une URL déjà résolue (legacy).
    @objc func play(_ call: CAPPluginCall) {
        guard let url = call.getString("url"), !url.isEmpty else {
            call.reject("url manquante")
            return
        }
        DispatchQueue.main.async {
            self.engine.play(
                url: url,
                title: call.getString("title") ?? "",
                artist: call.getString("artist") ?? "",
                thumb: call.getString("thumb") ?? ""
            )
            call.resolve(["success": true])
        }
    }

    @objc func pause(_ call: CAPPluginCall) {
        DispatchQueue.main.async { self.engine.pause(); call.resolve(["success": true]) }
    }

    @objc func resume(_ call: CAPPluginCall) {
        DispatchQueue.main.async { self.engine.resume(); call.resolve(["success": true]) }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async { self.engine.stop(); call.resolve(["success": true]) }
    }

    @objc func isPlaying(_ call: CAPPluginCall) {
        call.resolve(["isPlaying": engine.isPlaying()])
    }

    @objc func getPosition(_ call: CAPPluginCall) {
        let (pos, dur, playing) = engine.getPosition()
        call.resolve(["position": pos, "duration": dur, "isPlaying": playing])
    }

    @objc func seekTo(_ call: CAPPluginCall) {
        let seconds = call.getDouble("position") ?? 0
        DispatchQueue.main.async { self.engine.seekTo(seconds: seconds); call.resolve() }
    }

    /// Emet l'évènement vers le JS (utilisé par les contrôles natifs).
    @objc func skipNext(_ call: CAPPluginCall) {
        notifyListeners("skipNext", data: [:])
        call.resolve()
    }

    @objc func skipPrevious(_ call: CAPPluginCall) {
        notifyListeners("skipPrevious", data: [:])
        call.resolve()
    }

    // MARK: - Préload / file

    @objc func preload(_ call: CAPPluginCall) {
        guard let videoId = call.getString("videoId"), !videoId.isEmpty else {
            call.reject("videoId manquant")
            return
        }
        if engine.getPreloadedUrl(videoId: videoId) != nil {
            call.resolve(["cached": true, "videoId": videoId])
            return
        }
        engine.preload(videoId: videoId) { _ in }
        call.resolve(["preloading": true, "videoId": videoId])
    }

    @objc func getPreloadedUrl(_ call: CAPPluginCall) {
        let videoId = call.getString("videoId") ?? ""
        if let url = engine.getPreloadedUrl(videoId: videoId) {
            call.resolve(["videoId": videoId, "hasUrl": true, "url": url])
        } else {
            call.resolve(["videoId": videoId, "hasUrl": false])
        }
    }

    @objc func clearPreloadCache(_ call: CAPPluginCall) {
        engine.clearPreloadCache()
        call.resolve()
    }

    @objc func setUpcoming(_ call: CAPPluginCall) {
        let raw = call.getArray("tracks") ?? []
        let tracks: [UpcomingTrack] = raw.compactMap { item in
            guard let d = item as? [String: Any], let vid = d["videoId"] as? String else { return nil }
            return UpcomingTrack(
                videoId: vid,
                title: d["title"] as? String ?? "",
                artist: d["artist"] as? String ?? "",
                thumb: d["thumb"] as? String ?? ""
            )
        }
        DispatchQueue.main.async {
            self.engine.setUpcoming(tracks: tracks)
            call.resolve()
        }
    }

    // MARK: - Crossfade

    @objc func setCrossfade(_ call: CAPPluginCall) {
        let ms = call.getInt("durationMs") ?? 0
        DispatchQueue.main.async {
            self.engine.setCrossfade(durationMs: ms)
            call.resolve(["durationMs": ms])
        }
    }

    @objc func cancelCrossfade(_ call: CAPPluginCall) {
        DispatchQueue.main.async { self.engine.cancelCrossfade(); call.resolve() }
    }

    @objc func loadNextTrack(_ call: CAPPluginCall) {
        guard let videoId = call.getString("videoId"), !videoId.isEmpty else {
            call.reject("videoId manquant")
            return
        }
        DispatchQueue.main.async {
            self.engine.loadNextTrack(
                videoId: videoId,
                title: call.getString("title") ?? "",
                artist: call.getString("artist") ?? "",
                thumb: call.getString("thumb") ?? ""
            ) { error in
                if let error = error { call.reject(error) } else { call.resolve(["loaded": true]) }
            }
        }
    }

    // MARK: - Divers

    /// Pas d'équivalent des réglages Bluetooth Android : on ouvre les réglages de l'app.
    @objc func openAudioSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if let url = URL(string: UIApplication.openSettingsURLString) {
                UIApplication.shared.open(url)
            }
            call.resolve()
        }
    }

    /// Résolution titre → videoId via le backend (parité avec resolveTrack Android).
    @objc func resolveTrack(_ call: CAPPluginCall) {
        let artist = call.getString("artist") ?? ""
        let title = call.getString("title") ?? ""
        let q = "\(artist) \(title)".trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { call.reject("artist/title manquants"); return }
        let base = AudioEngine.resolutionProxyBase()
        guard let url = URL(string: "\(base)/youtube/search?q=\(q.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? q)&maxResults=1") else {
            call.reject("URL de recherche invalide")
            return
        }
        URLSession.shared.dataTask(with: url) { data, _, err in
            guard let data = data, err == nil,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let items = json["items"] as? [[String: Any]],
                  let first = items.first,
                  let id = (first["id"] as? [String: Any])?["videoId"] as? String else {
                call.reject("Aucun résultat")
                return
            }
            let snippet = first["snippet"] as? [String: Any] ?? [:]
            let thumbs = (snippet["thumbnails"] as? [String: Any])?["high"] as? [String: Any]
            call.resolve([
                "videoId": id,
                "title": snippet["title"] as? String ?? title,
                "uploader": snippet["channelTitle"] as? String ?? artist,
                "durationSec": 0,
                "score": 0,
                "thumb": thumbs?["url"] as? String ?? ""
            ])
        }.resume()
    }
}
