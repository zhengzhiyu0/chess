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
        .target(
            name: "PiperOpenJTalk",
            path: "piper1-gpl-runtime",
            sources: [
                "openjtalk/jpcommon/jpcommon.c",
                "openjtalk/jpcommon/jpcommon_label.c",
                "openjtalk/jpcommon/jpcommon_node.c",
                "openjtalk/mecab/src/char_property.cpp",
                "openjtalk/mecab/src/connector.cpp",
                "openjtalk/mecab/src/context_id.cpp",
                "openjtalk/mecab/src/dictionary.cpp",
                "openjtalk/mecab/src/dictionary_compiler.cpp",
                "openjtalk/mecab/src/dictionary_generator.cpp",
                "openjtalk/mecab/src/dictionary_rewriter.cpp",
                "openjtalk/mecab/src/eval.cpp",
                "openjtalk/mecab/src/feature_index.cpp",
                "openjtalk/mecab/src/iconv_utils.cpp",
                "openjtalk/mecab/src/lbfgs.cpp",
                "openjtalk/mecab/src/learner.cpp",
                "openjtalk/mecab/src/learner_tagger.cpp",
                "openjtalk/mecab/src/libmecab.cpp",
                "openjtalk/mecab/src/mecab.cpp",
                "openjtalk/mecab/src/nbest_generator.cpp",
                "openjtalk/mecab/src/param.cpp",
                "openjtalk/mecab/src/string_buffer.cpp",
                "openjtalk/mecab/src/tagger.cpp",
                "openjtalk/mecab/src/tokenizer.cpp",
                "openjtalk/mecab/src/utils.cpp",
                "openjtalk/mecab/src/viterbi.cpp",
                "openjtalk/mecab/src/writer.cpp",
                "openjtalk/mecab2njd/mecab2njd.c",
                "openjtalk/njd/njd.c",
                "openjtalk/njd/njd_node.c",
                "openjtalk/njd2jpcommon/njd2jpcommon.c",
                "openjtalk/njd_set_accent_phrase/njd_set_accent_phrase.c",
                "openjtalk/njd_set_accent_type/njd_set_accent_type.c",
                "openjtalk/njd_set_digit/njd_set_digit.c",
                "openjtalk/njd_set_long_vowel/njd_set_long_vowel.c",
                "openjtalk/njd_set_pronunciation/njd_set_pronunciation.c",
                "openjtalk/njd_set_unvoiced_vowel/njd_set_unvoiced_vowel.c",
                "openjtalk/text2mecab/text2mecab.c",
            ],
            publicHeadersPath: "openjtalk/include",
            cSettings: [
                .define("HAVE_CONFIG_H"),
                .define("DIC_VERSION", to: "102"),
                .define("MECAB_DEFAULT_RC", to: "\"dummy\""),
                .define("MECAB_WITHOUT_SHARE_DIC"),
                .define("PACKAGE", to: "\"open_jtalk\""),
                .define("VERSION", to: "\"1.11\""),
                .define("CHARSET_UTF_8"),
                .define("MECAB_CHARSET", to: "utf-8"),
                .define("MECAB_UTF8_USE_ONLY"),
                .headerSearchPath("openjtalk/jpcommon"),
                .headerSearchPath("openjtalk/mecab/src"),
                .headerSearchPath("openjtalk/mecab2njd"),
                .headerSearchPath("openjtalk/njd"),
                .headerSearchPath("openjtalk/njd2jpcommon"),
                .headerSearchPath("openjtalk/njd_set_accent_phrase"),
                .headerSearchPath("openjtalk/njd_set_accent_type"),
                .headerSearchPath("openjtalk/njd_set_digit"),
                .headerSearchPath("openjtalk/njd_set_long_vowel"),
                .headerSearchPath("openjtalk/njd_set_pronunciation"),
                .headerSearchPath("openjtalk/njd_set_unvoiced_vowel"),
                .headerSearchPath("openjtalk/text2mecab"),
            ],
            cxxSettings: [
                .define("HAVE_CONFIG_H"),
                .define("DIC_VERSION", to: "102"),
                .define("MECAB_DEFAULT_RC", to: "\"dummy\""),
                .define("MECAB_WITHOUT_SHARE_DIC"),
                .define("PACKAGE", to: "\"open_jtalk\""),
                .define("VERSION", to: "\"1.11\""),
                .define("CHARSET_UTF_8"),
                .define("MECAB_CHARSET", to: "utf-8"),
                .define("MECAB_UTF8_USE_ONLY"),
                .headerSearchPath("openjtalk/jpcommon"),
                .headerSearchPath("openjtalk/mecab/src"),
                .headerSearchPath("openjtalk/mecab2njd"),
                .headerSearchPath("openjtalk/njd"),
                .headerSearchPath("openjtalk/njd2jpcommon"),
                .headerSearchPath("openjtalk/njd_set_accent_phrase"),
                .headerSearchPath("openjtalk/njd_set_accent_type"),
                .headerSearchPath("openjtalk/njd_set_digit"),
                .headerSearchPath("openjtalk/njd_set_long_vowel"),
                .headerSearchPath("openjtalk/njd_set_pronunciation"),
                .headerSearchPath("openjtalk/njd_set_unvoiced_vowel"),
                .headerSearchPath("openjtalk/text2mecab"),
            ]
        ),
        .target(
            name: "Piper1GPLRuntime",
            dependencies: [
                .product(name: "libespeak-ng", package: "espeak-ng-spm"),
                .product(name: "onnxruntime", package: "onnxruntime-swift-package-manager"),
                "PiperOpenJTalk",
            ],
            path: "piper1-gpl-runtime",
            sources: [
                "piper1-gpl/libpiper/src/piper.cpp",
                "piper1-gpl/libpiper/src/chinese_phonemizer.cpp",
                "piper1-gpl/libpiper/src/japanese_phonemizer.cpp",
            ],
            publicHeadersPath: "piper-spm/public",
            cxxSettings: [
                .headerSearchPath("piper-spm/headers"),
                .headerSearchPath("piper1-gpl/libpiper/include"),
                .headerSearchPath("openjtalk/jpcommon"),
                .headerSearchPath("openjtalk/mecab/src"),
                .headerSearchPath("openjtalk/mecab2njd"),
                .headerSearchPath("openjtalk/njd"),
                .headerSearchPath("openjtalk/njd2jpcommon"),
                .headerSearchPath("openjtalk/njd_set_accent_phrase"),
                .headerSearchPath("openjtalk/njd_set_accent_type"),
                .headerSearchPath("openjtalk/njd_set_digit"),
                .headerSearchPath("openjtalk/njd_set_long_vowel"),
                .headerSearchPath("openjtalk/njd_set_pronunciation"),
                .headerSearchPath("openjtalk/njd_set_unvoiced_vowel"),
                .headerSearchPath("openjtalk/text2mecab"),
            ]
        ),
        .target(
            name: "MaiaNativePlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                .product(name: "onnxruntime", package: "onnxruntime-swift-package-manager"),
                "Piper1GPLRuntime",
                "EspeakBridge",
                "StockfishFull",
                "StockfishLite",
            ],
            path: "ios/Sources/MaiaNativePlugin"
        ),
    ],
    cxxLanguageStandard: .cxx17
)
