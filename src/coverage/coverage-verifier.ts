import path from 'node:path';

import { parseCoverageProfile } from './coverage-parser.js';

/**
 * Verifies that all target lines have non-zero execution count in a confirmation profile.
 */
export async function verifyCoverageHit(
  repoPath: string,
  confirmationProfilePath: string,
  targetFilePath: string,
  targetLines: number[],
): Promise<boolean> {
  const blocks = await parseCoverageProfile(confirmationProfilePath);
  const targetAbs = path.resolve(repoPath, targetFilePath);
  const coveredLines = new Set<number>();

  for (const block of blocks) {
    const blockAbs = normalizeCoverageFilePath(repoPath, block.filePath);
    if (blockAbs !== targetAbs) {
      continue;
    }
    if (block.executionCount <= 0) {
      continue;
    }
    for (let line = block.startLine; line <= block.endLine; line += 1) {
      coveredLines.add(line);
    }
  }

  return targetLines.every((line) => coveredLines.has(line));
}

function normalizeCoverageFilePath(repoPath: string, rawPath: string): string {
  const slashNormalized = rawPath.replace(/\\/g, '/');
  if (path.isAbsolute(slashNormalized)) {
    return path.resolve(slashNormalized);
  }

  for (const modulePrefix of ['github.com/pingcap/tidb/', 'pingcap/tidb/']) {
    if (slashNormalized.startsWith(modulePrefix)) {
      return path.resolve(repoPath, slashNormalized.slice(modulePrefix.length));
    }
  }

  return path.resolve(repoPath, slashNormalized);
}
