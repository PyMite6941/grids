#!/usr/bin/env sh
# Build the Grids desktop app: compile, bundle shared/ resources, run the engine fixtures, make build/grids.jar.
#   ./build.sh          build + test
#   ./build.sh --run    build + test + launch
#   ./build.sh --smoke  also run test/DesktopSmoke (needs Python; ~30s)
set -eu
cd "$(dirname "$0")"

CLASSES=build/classes
TEST_OUT=build/test
SEP=:
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) SEP=';' ;; esac

rm -rf build
mkdir -p "$CLASSES" "$TEST_OUT"

find src -name '*.java' > build/sources.txt
javac --release 21 -encoding UTF-8 -Xlint:all -Xlint:-serial -d "$CLASSES" @build/sources.txt

# Shared assets the app loads from the classpath (one source of truth with the website)
mkdir -p "$CLASSES/grids/shared/python" "$CLASSES/grids/shared/ai"
cp ../shared/python/grid_runtime.py "$CLASSES/grids/shared/python/"
cp ../shared/ai/tools.json ../shared/ai/system-prompt.md ../shared/ai/text-protocol.md "$CLASSES/grids/shared/ai/"

javac --release 21 -encoding UTF-8 -cp "$CLASSES" -d "$TEST_OUT" test/EngineFixtures.java test/DesktopSmoke.java
java -cp "$CLASSES$SEP$TEST_OUT" EngineFixtures ../shared/fixtures/formulas.json

if [ "${1:-}" = "--smoke" ]; then java -cp "$CLASSES$SEP$TEST_OUT" DesktopSmoke; fi

jar --create --file build/grids.jar --main-class grids.Main -C "$CLASSES" .
echo "Built build/grids.jar"

if [ "${1:-}" = "--run" ]; then java -jar build/grids.jar; fi
