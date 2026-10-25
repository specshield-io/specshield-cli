#!/usr/bin/env bash
# Generates the Spring Boot version layer for test-harness/spring-compat with
# `specshield fix --spring`, then compiles it into a real Spring Boot app and
# runs the old-client / new-client tests. Needs Java 17+ and Maven.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
H="$ROOT/test-harness/spring-compat"
rm -rf "$H/src/main/java/com/example/payments/compat"
set +e
node "$ROOT/bin/specshield.js" fix "$H/specs/base.yaml" "$H/specs/target.yaml" \
  --spring "$H/src/main/java" --package com.example.payments.compat --out "$H/target/target.fixed.yaml" > /dev/null
code=$?
set -e
# 1 = some breaking changes need the version layer rather than a spec edit; that's expected here.
if [ "$code" -gt 1 ]; then exit "$code"; fi
cd "$H" && mvn -q ${MVN_FLAGS:-} test
echo "Spring compat layer: generated, compiled and tested."
