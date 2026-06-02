#!/bin/bash
# Fake `supabase` CLI for deploy-routes.test.js. Stands in for the real binary
# so the Node deploy orchestrator (runDeploy) can be exercised without touching
# a project. Invoked once per phase: `link`, `db push`, `functions deploy`,
# `secrets set`.
#
# Behaviour driven by env vars (so a test can shape any single run):
#   FAKE_SUPABASE_EXIT      exit code (default 0)
#   FAKE_SUPABASE_STDERR    if set, echoes "stderr: <value>" to stderr
#   FAKE_SUPABASE_DELAY_MS  if set, sleeps this many ms before returning
#   FAKE_SUPABASE_LEAK      if set, echoes "leaked=<value>" on stdout — used to
#                           verify secret redaction in the streamed output.
set -e

[ -n "${FAKE_SUPABASE_DELAY_MS:-}" ] && sleep "$(awk "BEGIN{print ${FAKE_SUPABASE_DELAY_MS}/1000}")" || true

echo "supabase $1 ${2:-} (fake)"
[ -n "${FAKE_SUPABASE_LEAK:-}" ] && echo "leaked=${FAKE_SUPABASE_LEAK}" || true
[ -n "${FAKE_SUPABASE_STDERR:-}" ] && echo "stderr: ${FAKE_SUPABASE_STDERR}" >&2 || true

exit "${FAKE_SUPABASE_EXIT:-0}"
