Pod::Spec.new do |s|
  s.name = 'HiveWardMobileWebShell'
  s.version = '0.0.1'
  s.summary = 'WebView shell that serves one generation directory from a private origin'
  s.description = s.summary
  s.license = { :type => 'MIT' }
  s.author = 'HiveWard'
  s.homepage = 'https://onhiveward.dev'
  s.source = { :git => 'https://github.com/Chaunyzhang/HiveWard.git' }
  s.platforms = { :ios => '15.1' }
  s.swift_version = '5.9'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.swift'
end
