Pod::Spec.new do |s|
  s.name           = 'NearbyMesh'
  s.version        = '1.0.0'
  s.summary        = 'Google Nearby Connections transport for Expo (cluster strategy).'
  s.description    = 'Local Expo module exposing Google Nearby Connections as a raw byte pipe.'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '16.4'
  }
  s.source         = { git: '' }
  s.static_framework = true
  s.swift_version  = '5.9'

  s.dependency 'ExpoModulesCore'
  # Google's official Swift Nearby Connections SDK.
  s.dependency 'NearbyConnections', '~> 1.1'

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
