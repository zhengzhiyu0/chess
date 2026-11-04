require_relative 'native_profile'

Pod::Spec.new do |s|
  s.name = 'maia_native'
  s.version = '0.1.0'
  s.summary = 'Flutter iOS offline chess engines and sound.'
  s.description = 'Serialized CoreML inference, independently compiled Stockfish engines and native AVAudioPlayer effects.'
  s.homepage = 'https://github.com/official-stockfish/Stockfish'
  s.license = { :type => 'GPL-3.0-or-later', :file => 'EngineSources/Copying.txt' }
  s.author = { 'Maia Coach' => 'maintainers@localhost' }
  s.source = { :path => '.' }
  s.platform = :ios, '17.0'
  s.swift_version = '5.0'
  s.static_framework = true
  s.source_files = 'Classes/**/*.swift'
  # A prebuilt bundle preserves mlmodelc directories and sound theme directories.
  # Flutter's assets/native/ declaration alone does not recursively include mlmodelc.
  s.resources = 'Resources/MaiaNativeAssets.bundle'
  s.frameworks = 'CoreML', 'AVFoundation', 'UIKit', 'WebKit'
  s.dependency 'Flutter'
  s.dependency 'StockfishFull', '0.1.0'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  if MaiaNativeBuild.profile == '79m-full'
    s.pod_target_xcconfig = {
      'DEFINES_MODULE' => 'YES',
      'SWIFT_ACTIVE_COMPILATION_CONDITIONS' => '$(inherited) MAIA_STOCKFISH_FULL_ONLY',
    }
  else
    s.dependency 'StockfishLite', '0.1.0'
  end
end
