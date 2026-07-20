Pod::Spec.new do |s|
  s.name           = 'BleMesh'
  s.version        = '1.0.0'
  s.summary        = 'CoreBluetooth GATT mesh transport for Expo.'
  s.description    = 'Local Expo module exposing a dual-role (central + peripheral) BLE GATT link as a raw byte pipe, with rotating advertising identifiers.'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '16.4'
  }
  s.source         = { git: '' }
  s.static_framework = true
  s.swift_version  = '5.9'

  # CoreBluetooth and Security ship with the OS. That is the entire point of this
  # module: unlike nearby-mesh it has no third-party dependency, so it cannot be
  # blocked by a vendor declining to publish a CocoaPod.
  s.frameworks     = 'CoreBluetooth', 'Security'

  s.dependency 'ExpoModulesCore'

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
