param(
  [string]$OutputPath = (Join-Path $PSScriptRoot 'UCSD_EZPLAN-extension.zip')
)

$runtimeFiles = @(
  'manifest.json',
  'background.js',
  'reauth-content.js',
  'content.js',
  'popup.js',
  'popup.html',
  'planner.html',
  'popup.css',
  'theme-boot.js',
  'icon.png'
)

if (Test-Path -LiteralPath $OutputPath) {
  throw "Package already exists: $OutputPath"
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::Open($OutputPath, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($name in $runtimeFiles) {
    $source = Join-Path $PSScriptRoot $name
    if (-not (Test-Path -LiteralPath $source)) { throw "Missing extension file: $name" }
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
      $archive, $source, $name, [System.IO.Compression.CompressionLevel]::Optimal
    ) | Out-Null
  }
} finally {
  $archive.Dispose()
}

Write-Output $OutputPath
