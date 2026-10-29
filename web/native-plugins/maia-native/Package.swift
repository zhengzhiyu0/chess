// swift-tools-version: 5.9
import PackageDescription

// Native engines for the iOS app: Stockfish 19 (full + lite NNUE, C++ with pthreads/NEON) and
// Maia-3 via pre-compiled CoreML ML Programs. Engine data files are not part of this package;
// the native build scripts put them in the app's public/native/ resources.

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
            name: "MaiaNativePlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                "StockfishFull",
                "StockfishLite",
            ],
            path: "ios/Sources/MaiaNativePlugin"
        ),
    ],
    cxxLanguageStandard: .cxx17
)
