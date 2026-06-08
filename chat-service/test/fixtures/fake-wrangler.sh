#!/bin/bash
# Fake `wrangler` CLI for deploy-routes.test.js. Stands in for the real binary so
# runCloudflarePhase can be exercised without a Cloudflare account. Invoked as
# `<bin> deploy --config <file>`. Echoes a recognizable line and exits 0
# (override the exit code with FAKE_WRANGLER_EXIT to simulate a failed deploy).
set -e
echo "wrangler $* (fake)"
exit "${FAKE_WRANGLER_EXIT:-0}"
