// swift-tools-version:5.9
import PackageDescription

// Copie de YouTubeKit 0.4.9 (MIT, alexeichhorn) avec un seul changement :
// le solveur de signatures garde le lecteur YouTube déjà analysé
// (Sources/YouTubeKit/SignatureSolver.swift, Extraction.applySignature).
let package = Package(
    name: "YouTubeKit",
    products: [
        .library(name: "YouTubeKit", targets: ["YouTubeKit"]),
    ],
    targets: [
        .target(name: "YouTubeKit", resources: [.process("Resources")]),
    ]
)
