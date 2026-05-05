// Builds the env object for the `claude -p` spawn.
// Injects CLAUDE_SESSION_ID so the lead's Bash hooks can reference the
// claude session id when doing transcript filesystem cleanup.

export function buildSpawnEnv(baseEnv, claudeSessionId) {
  const env = { ...baseEnv };
  if (claudeSessionId) {
    env.CLAUDE_SESSION_ID = claudeSessionId;
  }
  return env;
}
