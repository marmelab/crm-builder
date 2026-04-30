export function matchesGlob(path, pattern) {
  const re = new RegExp(
    '^' +
      pattern
        .split('**')
        .map((part) =>
          part
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '[^/]*')
        )
        .join('.*') +
      '$'
  );
  return re.test(path);
}

function withinTolerance(actual, expected, factor = 2) {
  if (expected === 0) return actual === 0;
  return actual >= expected / factor && actual <= expected * factor;
}

export function evaluateFileSet(diff, expect) {
  const warnings = [];
  const touched = new Set(diff.files || []);

  if (expect.mustModify) {
    for (const path of expect.mustModify) {
      if (!touched.has(path)) {
        warnings.push(`A: expected modification missing — ${path}`);
      }
    }
  }

  if (expect.mustNotModify) {
    for (const path of touched) {
      for (const pattern of expect.mustNotModify) {
        if (matchesGlob(path, pattern)) {
          warnings.push(`A: forbidden file modified — ${path} (matches ${pattern})`);
        }
      }
    }
  }

  if (expect.expectedDiffStats) {
    const e = expect.expectedDiffStats;
    const a = diff.numstat || { filesChanged: 0, linesAdded: 0, linesRemoved: 0 };
    for (const key of ['filesChanged', 'linesAdded', 'linesRemoved']) {
      if (e[key] != null && !withinTolerance(a[key], e[key])) {
        warnings.push(`A: ${key} ${a[key]} outside tolerance of expected ${e[key]} (±100%)`);
      }
    }
  }

  return { warnings };
}
