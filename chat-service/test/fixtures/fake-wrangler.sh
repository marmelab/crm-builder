#!/bin/bash
# Fake `wrangler` CLI for deploy-routes.test.js. Stands in for the real binary so
# runCloudflarePhase can be exercised without a Cloudflare account. Invoked as
# `<bin> deploy --config <file>`. Echoes a recognizable line and exits 0
# (override the exit code with FAKE_WRANGLER_EXIT to simulate a failed deploy).
#
# FAKE_WRANGLER_URL: if set, also echoes that line so the orchestrator's
# workers.dev URL scraper (parseWorkerUrl) has something to find. Real wrangler
# prints the deployed Worker URL on its own line; this mimics that.
set -e
echo "wrangler $* (fake)"
[ -n "${FAKE_WRANGLER_URL:-}" ] && echo "  ${FAKE_WRANGLER_URL}" || true
exit "${FAKE_WRANGLER_EXIT:-0}"
