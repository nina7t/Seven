// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "SevenzAudioPlayer",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "SevenzAudioPlayer",
            targets: ["AudioPlayerPlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0"),
        .package(url: "https://github.com/alexeichhorn/YouTubeKit.git", from: "0.4.9")
    ],
    targets: [
        .target(
            name: "AudioPlayerPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                .product(name: "YouTubeKit", package: "YouTubeKit")
            ],
            path: "ios/Sources/AudioPlayerPlugin")
    ]
)
