// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "NioDashboardNative",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "NioDashboard", targets: ["NioDashboard"]),
    ],
    targets: [
        .executableTarget(
            name: "NioDashboard",
            path: "Sources/NioDashboard",
            swiftSettings: [.enableUpcomingFeature("ExistentialAny")]
        ),
        .testTarget(
            name: "NioDashboardTests",
            dependencies: ["NioDashboard"],
            path: "Tests/NioDashboardTests"
        ),
    ]
)
