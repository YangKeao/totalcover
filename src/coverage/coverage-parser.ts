import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { CoverageBlock, FunctionBoundary, UncoveredSegment } from '../types.js';

interface LineState {
  appeared: boolean;
  covered: boolean;
}

const FUNC_DECLARATION_REGEX = /^func\s*(?:\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/;

/**
 * Parses a Go coverage profile (`mode: xxx` + blocks) into normalized blocks.
 */
export async function parseCoverageProfile(profilePath: string): Promise<CoverageBlock[]> {
  const raw = await readFile(profilePath, 'utf8');
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);

  if (lines.length === 0 || !lines[0].startsWith('mode:')) {
    throw new Error(`Invalid coverage profile format: ${profilePath}`);
  }

  const blocks: CoverageBlock[] = [];
  for (const line of lines.slice(1)) {
    const parsed = parseCoverageLine(line);
    if (!parsed) {
      continue;
    }

    blocks.push({
      filePath: parsed.filePath,
      startLine: parsed.startLine,
      endLine: parsed.endLine,
      executionCount: parsed.executionCount,
    });
  }

  return blocks;
}

/**
 * Merges multiple coverage profiles and returns line segments that stayed uncovered in all profiles.
 */
export async function extractCompletelyUncoveredSegments(
  repoPath: string,
  profilePaths: string[],
): Promise<UncoveredSegment[]> {
  const fileCoverage = new Map<string, Map<number, LineState>>();

  for (const profilePath of profilePaths) {
    const blocks = await parseCoverageProfile(profilePath);
    for (const block of blocks) {
      const absoluteFilePath = normalizeCoverageFilePath(repoPath, block.filePath);
      const lineMap = getOrCreateMap(fileCoverage, absoluteFilePath, () => new Map<number, LineState>());
      for (let line = block.startLine; line <= block.endLine; line += 1) {
        const state = getOrCreateMap(lineMap, line, () => ({ appeared: false, covered: false }));
        state.appeared = true;
        if (block.executionCount > 0) {
          state.covered = true;
        }
      }
    }
  }

  const segments: UncoveredSegment[] = [];

  for (const [absoluteFilePath, lineMap] of fileCoverage.entries()) {
    const uncoveredLines = [...lineMap.entries()]
      .filter(([, state]) => state.appeared && !state.covered)
      .map(([line]) => line)
      .sort((a, b) => a - b);

    if (uncoveredLines.length === 0) {
      continue;
    }

    let fileRaw: string;
    try {
      fileRaw = await readFile(absoluteFilePath, 'utf8');
    } catch {
      // Skip unresolved coverage entries (for example external paths) and keep
      // processing remaining files.
      continue;
    }
    const fileLines = fileRaw.split(/\r?\n/);
    const functionBoundaries = computeFunctionBoundaries(fileLines);
    const contiguousGroups = groupContiguousLines(uncoveredLines);

    for (const group of contiguousGroups) {
      const functionBoundary = findFunctionBoundary(functionBoundaries, group[0]);
      const snippetStart = Math.max(group[0] - 3, 1);
      const snippetEnd = Math.min(group[group.length - 1] + 3, fileLines.length);
      const snippet = fileLines
        .slice(snippetStart - 1, snippetEnd)
        .map((text, idx) => `${snippetStart + idx}: ${text}`)
        .join('\n');

      const packagePath = path.dirname(path.relative(repoPath, absoluteFilePath)).replace(/\\/g, '/');
      const functionName = functionBoundary?.name ?? '(outside function)';

      segments.push({
        id: `${path.relative(repoPath, absoluteFilePath)}:${group[0]}-${group[group.length - 1]}`,
        filePath: path.relative(repoPath, absoluteFilePath).replace(/\\/g, '/'),
        packagePath,
        functionName,
        startLine: group[0],
        endLine: group[group.length - 1],
        lines: group,
        snippet,
      });
    }
  }

  return segments;
}

function parseCoverageLine(
  line: string,
): { filePath: string; startLine: number; endLine: number; executionCount: number } | null {
  // Example:
  // path/to/file.go:12.3,19.2 4 0
  const match = line.match(/^(.*):(\d+)\.(\d+),(\d+)\.(\d+)\s+(\d+)\s+(\d+)$/);
  if (!match) {
    return null;
  }

  const [, filePath, startLineRaw, _startColRaw, endLineRaw, _endColRaw, _numStmtsRaw, executionCountRaw] =
    match;
  const startLine = Number(startLineRaw);
  const endLine = Number(endLineRaw);
  const executionCount = Number(executionCountRaw);

  if (!Number.isFinite(startLine) || !Number.isFinite(endLine) || !Number.isFinite(executionCount)) {
    return null;
  }

  return {
    filePath,
    startLine,
    endLine,
    executionCount,
  };
}

function normalizeCoverageFilePath(repoPath: string, rawPath: string): string {
  const slashNormalized = rawPath.replace(/\\/g, '/');
  if (path.isAbsolute(slashNormalized)) {
    return path.resolve(slashNormalized);
  }

  // TiDB coverage frequently uses module-qualified filenames like:
  // github.com/pingcap/tidb/pkg/.../file.go
  for (const modulePrefix of ['github.com/pingcap/tidb/', 'pingcap/tidb/']) {
    if (slashNormalized.startsWith(modulePrefix)) {
      return path.resolve(repoPath, slashNormalized.slice(modulePrefix.length));
    }
  }

  return path.resolve(repoPath, slashNormalized);
}

function computeFunctionBoundaries(lines: string[]): FunctionBoundary[] {
  const starts: Array<{ name: string; line: number }> = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    const match = line.match(FUNC_DECLARATION_REGEX);
    if (!match) {
      continue;
    }
    starts.push({
      name: match[1],
      line: i + 1,
    });
  }

  const boundaries: FunctionBoundary[] = [];
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i];
    const next = starts[i + 1];
    boundaries.push({
      name: start.name,
      startLine: start.line,
      endLine: next ? next.line - 1 : lines.length,
    });
  }

  return boundaries;
}

function findFunctionBoundary(
  boundaries: FunctionBoundary[],
  lineNumber: number,
): FunctionBoundary | undefined {
  return boundaries.find((boundary) => lineNumber >= boundary.startLine && lineNumber <= boundary.endLine);
}

function groupContiguousLines(lines: number[]): number[][] {
  if (lines.length === 0) {
    return [];
  }
  const groups: number[][] = [];
  let current: number[] = [lines[0]];

  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === current[current.length - 1] + 1) {
      current.push(line);
    } else {
      groups.push(current);
      current = [line];
    }
  }
  groups.push(current);

  return groups;
}

function getOrCreateMap<K, V>(map: Map<K, V>, key: K, create: () => V): V {
  let value = map.get(key);
  if (!value) {
    value = create();
    map.set(key, value);
  }
  return value;
}
