// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "HiveWardComputerUseMacOS",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .library(
            name: "HiveWardComputerUseMacOSCore",
            targets: ["HiveWardComputerUseMacOSCore"]
        ),
        .executable(
            name: "hiveward-computer-use-macos",
            targets: ["HiveWardComputerUseMacOS"]
        )
    ],
    targets: [
        .target(
            name: "HiveWardComputerUseMacOSCore",
            path: "Sources/HiveWardComputerUseMacOSCore"
        ),
        .executableTarget(
            name: "HiveWardComputerUseMacOS",
            dependencies: ["HiveWardComputerUseMacOSCore"],
            path: "Sources/HiveWardComputerUseMacOS"
        ),
        .testTarget(
            name: "HiveWardComputerUseMacOSTests",
            dependencies: ["HiveWardComputerUseMacOSCore"],
            path: "Tests/HiveWardComputerUseMacOSTests"
        )
    ]
)
