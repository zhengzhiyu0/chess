# Each pod is a separate compilation target. Subspecs of one pod would share
# preprocessor settings and cannot isolate the two NNUE architectures.
def maia_stockfish_spec(spec, flavour)
  name = flavour == 'full' ? 'StockfishFull' : 'StockfishLite'
  spec.name = name
  spec.version = '0.1.0'
  spec.summary = "Stockfish 19 #{flavour} NNUE, embedded with an isolated C ABI."
  spec.homepage = 'https://github.com/official-stockfish/Stockfish'
  spec.license = { :type => 'GPL-3.0-or-later', :file => 'EngineSources/Copying.txt' }
  spec.author = { 'Stockfish developers' => 'maintainers@localhost' }
  spec.source = { :path => '.' }
  spec.platform = :ios, '17.0'
  spec.static_framework = true
  spec.requires_arc = false
  spec.source_files = "EngineSources/#{flavour}/*.cpp", "EngineSources/#{flavour}/include/*.h"
  spec.public_header_files = "EngineSources/#{flavour}/include/*.h"
  spec.header_mappings_dir = "EngineSources/#{flavour}/include"
  spec.preserve_paths = 'EngineSources/src/**/*', 'EngineSources/bridge/**/*'
  spec.libraries = 'c++'
  flags = '$(inherited) -O3 -fno-exceptions -w'
  defines = "$(inherited) NDEBUG=1 IS_64BIT=1 USE_POPCNT=1 NNUE_EMBEDDING_OFF=1 SF_EMBEDDED=1 SF_NO_SHM=1 Stockfish=#{name} SF_C_PREFIX=sf_#{flavour}"
  defines += ' USE_LITE_NET=1' if flavour == 'lite'
  spec.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++17',
    'CLANG_CXX_LIBRARY' => 'libc++',
    'GCC_PREPROCESSOR_DEFINITIONS' => defines,
    'GCC_OPTIMIZATION_LEVEL' => '3',
    'OTHER_CPLUSPLUSFLAGS' => flags,
    # Baseline arm64 NEON works on devices AND Apple Silicon simulators. Do not
    # force apple-a13/dotprod (or NEON at all on Intel simulators).
    'OTHER_CPLUSPLUSFLAGS[arch=arm64]' => "#{flags} -DUSE_NEON=8",
    'OTHER_CPLUSPLUSFLAGS[arch=x86_64]' => "#{flags} -DUSE_SSE2 -msse2",
  }
end
