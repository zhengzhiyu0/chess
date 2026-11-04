require 'json'

module MaiaNativeBuild
  def self.profile
    path = File.join(__dir__, 'EngineSources', 'native-profile.json')
    unless File.file?(path)
      raise 'Run node flutter_app/scripts/prepare-ios.mjs before pod install (or --prepare-only for source preparation).'
    end
    prepared = JSON.parse(File.read(path)).fetch('profile')
    unless %w[all 79m-full].include?(prepared)
      raise "Invalid prepared Maia native profile: #{prepared}"
    end
    requested = ENV['NATIVE_PROFILE']
    if requested && requested != prepared
      raise "NATIVE_PROFILE=#{requested} differs from prepared profile #{prepared}; run prepare-ios.mjs again."
    end
    prepared
  end
end
