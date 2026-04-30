import { execSync } from 'node:child_process';

const defaultRunner = (cmd) => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

export function parseNumstat(raw) {
  const perFile = [];
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const [a, r, ...rest] = line.split('\t');
    const path = rest.join('\t');
    const added = a === '-' ? 0 : parseInt(a, 10) || 0;
    const removed = r === '-' ? 0 : parseInt(r, 10) || 0;
    perFile.push({ added, removed, path });
    linesAdded += added;
    linesRemoved += removed;
  }
  return { filesChanged: perFile.length, linesAdded, linesRemoved, perFile };
}

export function captureDiff(containerName, { runner = defaultRunner } = {}) {
  const wrap = (gitArgs) =>
    `docker exec ${containerName} sh -c "cd /app && git diff ${gitArgs} src/"`;
  const numstatRaw = runner(wrap('--numstat'));
  const namesRaw = runner(wrap('--name-only'));
  const patch = runner(wrap(''));
  return {
    numstat: parseNumstat(numstatRaw),
    files: namesRaw.split('\n').filter(Boolean),
    patch,
  };
}
