# Build the Grids desktop app: compile, bundle shared/ resources, run the engine fixtures, make build/grids.jar.
#   .\build.ps1          build + test
#   .\build.ps1 -Run     build + test + launch
#   .\build.ps1 -Smoke   also run test/DesktopSmoke (needs Python; ~30s)
param([switch]$Run, [switch]$Smoke)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$classes = 'build/classes'
$testOut = 'build/test'
if (Test-Path build) { Remove-Item -Recurse -Force build }
New-Item -ItemType Directory -Force $classes, $testOut | Out-Null

# Relative paths: javac mangles non-ASCII absolute paths (this repo lives under ドキュメント)
$sources = Get-ChildItem -Recurse -Filter *.java src | ForEach-Object { Resolve-Path -Relative $_.FullName }
javac --release 21 -encoding UTF-8 -Xlint:all -Xlint:-serial -d $classes @sources
if ($LASTEXITCODE -ne 0) { throw 'javac failed' }

# Shared assets the app loads from the classpath (one source of truth with the website)
$res = "$classes/grids/shared"
New-Item -ItemType Directory -Force "$res/python", "$res/ai" | Out-Null
Copy-Item ../shared/python/grid_runtime.py "$res/python/"
Copy-Item ../shared/ai/tools.json, ../shared/ai/system-prompt.md, ../shared/ai/text-protocol.md "$res/ai/"

javac --release 21 -encoding UTF-8 -cp $classes -d $testOut test/EngineFixtures.java test/DesktopSmoke.java
if ($LASTEXITCODE -ne 0) { throw 'javac (tests) failed' }
java -cp "$classes;$testOut" EngineFixtures ../shared/fixtures/formulas.json
if ($LASTEXITCODE -ne 0) { throw 'engine fixtures failed' }

if ($Smoke) {
    java -cp "$classes;$testOut" DesktopSmoke
    if ($LASTEXITCODE -ne 0) { throw 'desktop smoke test failed' }
}

jar --create --file build/grids.jar --main-class grids.Main -C $classes .
if ($LASTEXITCODE -ne 0) { throw 'jar failed' }
Write-Host 'Built build/grids.jar'

if ($Run) { java -jar build/grids.jar }
