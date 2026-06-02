// Names of function secrets the Configure modal collects and the deploy
// script syncs via `supabase secrets set`. One entry per env var an edge
// function in supabase/functions/ expects at runtime.
//
// Add a new entry whenever an edge function starts reading a new env var —
// the Configure form picks it up automatically.
export const EXPECTED_SECRETS = [
  'POSTMARK_WEBHOOK_USER',
  'POSTMARK_WEBHOOK_PASSWORD',
];
