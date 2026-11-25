// swift-tools-version:5.7
import PackageDescription

let package = Package(
    name: "Paraphe",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "Paraphe",
            path: "Sources/Paraphe"
        )
    ]
)
