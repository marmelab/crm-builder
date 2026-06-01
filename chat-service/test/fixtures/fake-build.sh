#!/bin/bash
# Fake `npm run build` for deploy-routes.test.js. Stands in for the real Vite
# build so runBuildPhase can be exercised without compiling the CRM. Invoked as
# `<bin> run build`. Echoes a recognizable line and exits 0 (override the exit
# code with FAKE_BUILD_EXIT to simulate a compile failure).
set -e
echo "vite build $* (fake)"
# When asked, snapshot src/App.tsx (cwd is the app dir) so a test can assert the
# Supabase variant was swapped in before the build ran.
[ -n "${FAKE_BUILD_APPTSX_OUT:-}" ] && cp src/App.tsx "$FAKE_BUILD_APPTSX_OUT" 2>/dev/null || true
exit "${FAKE_BUILD_EXIT:-0}"
