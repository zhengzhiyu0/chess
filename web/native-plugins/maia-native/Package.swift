// swift-tools-version: 5.9
import PackageDescription

// Native engines for the iOS app: Stockfish 19 (full + lite NNUE, C++ with pthreads/NEON) and
// Maia-3 via ONNX Runtime (CoreML EP). Engine data files (nn-*.nnue, maia3-*.onnx) are not part of
// this package; scripts/prepare-native.mjs puts them in dist-native/native/, which Capacitor copies to the bundle's public/native/.

let sfCommon: [CXXSetting] = [
    .headerSearchPath("../src"),
    .define("NDEBUG"),
    .define("IS_64BIT"),
    .define("USE_POPCNT"),
    .define("USE_NEON", to: "8"),
    .define("USE_NEON_DOTPROD"),
    .define("NNUE_EMBEDDING_OFF"),
    .define("SF_EMBEDDED"),
    .define("SF_NO_SHM"),
    // A13 is the oldest target device (dotprod); newer chips run this code unchanged. ThinLTO
    // inlines across Stockfish's translation units (as the official Makefile's -flto does); ld64
    // performs the LTO step itself for the bitcode objects when the app links.
    .unsafeFlags(["-O3", "-mcpu=apple-a13", "-flto=thin", "-fno-exceptions", "-w"]),
]

let package = Package(
    name: "MaiaNative",
    platforms: [.iOS(.v17)],
    products: [
        .library(name: "MaiaNative", targets: ["MaiaNativePlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0"),
        .package(url: "https://github.com/microsoft/onnxruntime-swift-package-manager.git", exact: "1.24.2"),
        .package(url: "https://github.com/piper-tts-apps/espeak-ng-spm.git", exact: "2026.09.11"),
    ],
    targets: [
        .target(
            name: "StockfishFull",
            path: "stockfish/full",
            publicHeadersPath: "include",
            cxxSettings: sfCommon + [
                .define("Stockfish", to: "StockfishFull"),
                .define("SF_C_PREFIX", to: "sf_full"),
            ]
        ),
        .target(
            name: "StockfishLite",
            path: "stockfish/lite",
            publicHeadersPath: "include",
            cxxSettings: sfCommon + [
                .define("Stockfish", to: "StockfishLite"),
                .define("SF_C_PREFIX", to: "sf_lite"),
                .define("USE_LITE_NET"),
            ]
        ),
        .target(
            name: "EspeakBridge",
            dependencies: [
                .product(name: "libespeak-ng", package: "espeak-ng-spm"),
                .product(name: "espeak-ng-data", package: "espeak-ng-spm"),
            ],
            path: "ios/Sources/EspeakBridge",
            publicHeadersPath: "include"
        ),
        .binaryTarget(
            name: "PiperPlusBinary",
            url: "https://github.com/ayutaz/piper-plus/releases/download/v2.0.2/libpiper_plus-ios-v2.0.2.xcframework.zip",
            checksum: "7b026f9f0af5b6b6ca56cddf56f75f398a0f3e0c9fc45c3848b8aa470dd30dff"
        ),
        .target(
            name: "MaiaNativePlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                .product(name: "onnxruntime", package: "onnxruntime-swift-package-manager"),
                "PiperPlusBinary",
                "EspeakBridge",
                "StockfishFull",
                "StockfishLite",
            ],
            path: "ios/Sources/MaiaNativePlugin"
        ),
    ],
    cxxLanguageStandard: .cxx17
)
