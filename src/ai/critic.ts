import pLimit from 'p-limit';

import type { ScoredSegment, ScoringDecision, UncoveredSegment } from '../types.js';
import type { CodexClient } from './codex-client.js';

const SYSTEM_PROMPT = [
  'You are a strict TiDB testing reviewer.',
  'Your job is to prioritize uncovered Go code segments for test generation.',
  'Return only JSON and follow the schema exactly.',
  'Scores must be globally calibrated and directly comparable across different packages.',
  'Use absolute scoring, never relative ranking inside a single package.',
  'Filter out low-value defensive/unreachable branches, especially trivial if err != nil guards with low business impact.',
].join(' ');

export async function scoreUncoveredSegments(
  codexClient: CodexClient,
  segments: UncoveredSegment[],
  options: {
    concurrency: number;
    chunkSize: number;
    onDecisionBatch?: (decisions: ScoringDecision[]) => Promise<void> | void;
    onChunkProgress?: (progress: ScoringProgress) => void;
  },
): Promise<ScoredSegment[]> {
  if (segments.length === 0) {
    return [];
  }

  const groups = buildScoreGroups(segments);
  const totalChunks = groups.reduce(
    (sum, group) => sum + countChunks(group.segments.length, options.chunkSize),
    0,
  );
  let completedChunks = 0;
  const bumpProgress = () => {
    completedChunks += 1;
    const percent =
      totalChunks === 0 ? 100 : Math.floor((completedChunks / totalChunks) * 100);
    return { completedChunks, totalChunks, percent };
  };
  const limit = pLimit(Math.max(1, options.concurrency));
  const packageResults = await Promise.all(
    groups.map((group) =>
      limit(async () =>
        scoreGroup(
          codexClient,
          group,
          options.chunkSize,
          options.onDecisionBatch,
          totalChunks > 0
            ? () => {
                const progress = bumpProgress();
                options.onChunkProgress?.(progress);
                return progress;
              }
            : undefined,
        ),
      ),
    ),
  );

  const decisionMap = new Map<string, ScoringDecision>();
  for (const decisions of packageResults) {
    for (const decision of decisions) {
      decisionMap.set(decision.segmentId, decision);
    }
  }

  return segments.map((segment) => {
    const decision = decisionMap.get(segment.id);
    if (!decision) {
      return {
        ...segment,
        score: 0,
        keep: false,
        rationale: 'Codex did not return a decision for this segment.',
      };
    }
    return {
      ...segment,
      score: decision.score,
      keep: decision.keep,
      rationale: decision.rationale,
    };
  });
}

type ScoreGroup = {
  packagePath: string;
  filePath?: string;
  segments: UncoveredSegment[];
};

type ScoringProgress = {
  completedChunks: number;
  totalChunks: number;
  percent: number;
};

async function scoreGroup(
  codexClient: CodexClient,
  group: ScoreGroup,
  chunkSize: number,
  onDecisionBatch?: (decisions: ScoringDecision[]) => Promise<void> | void,
  onChunkProcessed?: () => ScoringProgress,
): Promise<ScoringDecision[]> {
  const decisions: ScoringDecision[] = [];
  // Chunking avoids oversized prompts for large packages.
  const chunks = chunkArray(group.segments, Math.max(1, chunkSize));
  const label = group.filePath
    ? `${group.packagePath} :: ${group.filePath}`
    : group.packagePath;
  console.log(`[scoring] start ${label} (${group.segments.length} segments, ${chunks.length} chunks)`);

  for (const [index, chunk] of chunks.entries()) {
    console.log(`[scoring] ${label} chunk ${index + 1}/${chunks.length} (${chunk.length} segments)`);
    const userPrompt = [
      `Package: ${group.packagePath}`,
      group.filePath ? `File: ${group.filePath}` : '',
      'Score each uncovered segment from 0 to 100.',
      'Global rubric (cross-package comparable, absolute):',
      '- 95-100: Critical TiDB correctness/safety path with high user impact (transaction correctness, consistency, DDL safety, protocol compatibility, persistent state transitions).',
      '- 85-94: High-impact core path likely in production hot paths (planner/executor/coprocessor/session/metadata) with non-trivial branching.',
      '- 70-84: Meaningful logic with medium impact or complex edge behavior worth regression protection.',
      '- 40-69: Low-to-medium value, mostly plumbing, wrappers, simple passthrough, or rarely triggered edge paths.',
      '- 0-39: Low value or likely unreachable/defensive code (trivial guards, log-only branches, obvious if err != nil with no business semantics).',
      'Rule:',
      '- keep=true for high-value database core logic, state transitions, transaction paths, planner/executor, metadata, protocol handling.',
      '- keep=false for trivial defensive branches or low-value unreachable guards.',
      '- Keep score thresholds stable across packages; do not inflate small/leaf package scores.',
      'JSON schema:',
      '{"decisions":[{"segmentId":"...","score":0,"keep":true,"rationale":"..."}]}',
      'Segments:',
      ...chunk.map((segment) =>
        [
          `segmentId: ${segment.id}`,
          `file: ${segment.filePath}`,
          `function: ${segment.functionName}`,
          `lines: ${segment.startLine}-${segment.endLine}`,
          `snippet:\n${segment.snippet}`,
        ].join('\n'),
      ),
    ].join('\n\n');

    const response = await codexClient.jsonCompletion<{ decisions: ScoringDecision[] }>(
      SYSTEM_PROMPT,
      userPrompt,
    );

    const batch: ScoringDecision[] = [];
    for (const decision of response.decisions ?? []) {
      const normalized: ScoringDecision = {
        segmentId: decision.segmentId,
        score: clampScore(decision.score),
        keep: Boolean(decision.keep),
        rationale: normalizeRationale(decision.rationale ?? ''),
      };
      decisions.push(normalized);
      batch.push(normalized);
    }

    if (onDecisionBatch) {
      await onDecisionBatch(batch);
    }

    if (onChunkProcessed) {
      const progress = onChunkProcessed();
      console.log(
        `[scoring] progress ${progress.completedChunks}/${progress.totalChunks} (${progress.percent}%)`,
      );
    }
  }

  return decisions;
}

function buildScoreGroups(segments: UncoveredSegment[]): ScoreGroup[] {
  const byPackage = groupByPackage(segments);
  const groups: ScoreGroup[] = [];

  for (const [packagePath, packageSegments] of byPackage.entries()) {
    const fileCount = new Set(packageSegments.map((segment) => segment.filePath)).size;
    if (
      packageSegments.length >= LARGE_PACKAGE_SEGMENT_THRESHOLD ||
      fileCount >= LARGE_PACKAGE_FILE_THRESHOLD
    ) {
      const byFile = groupByFile(packageSegments);
      for (const [filePath, fileSegments] of byFile.entries()) {
        groups.push({
          packagePath,
          filePath,
          segments: fileSegments,
        });
      }
      continue;
    }
    groups.push({
      packagePath,
      segments: packageSegments,
    });
  }

  return groups;
}

function groupByPackage(segments: UncoveredSegment[]): Map<string, UncoveredSegment[]> {
  const grouped = new Map<string, UncoveredSegment[]>();
  for (const segment of segments) {
    const list = grouped.get(segment.packagePath) ?? [];
    list.push(segment);
    grouped.set(segment.packagePath, list);
  }
  return grouped;
}

function groupByFile(segments: UncoveredSegment[]): Map<string, UncoveredSegment[]> {
  const grouped = new Map<string, UncoveredSegment[]>();
  for (const segment of segments) {
    const list = grouped.get(segment.filePath) ?? [];
    list.push(segment);
    grouped.set(segment.filePath, list);
  }
  return grouped;
}

function chunkArray<T>(list: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < list.length; i += chunkSize) {
    chunks.push(list.slice(i, i + chunkSize));
  }
  return chunks;
}

function countChunks(segmentCount: number, chunkSize: number): number {
  const size = Math.max(1, chunkSize);
  return Math.ceil(segmentCount / size);
}

function clampScore(score: number): number {
  if (!Number.isFinite(score)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(score)));
}

const LARGE_PACKAGE_SEGMENT_THRESHOLD = 120;
const LARGE_PACKAGE_FILE_THRESHOLD = 20;
const MAX_RATIONALE_CHARS = 200;

function normalizeRationale(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (compact.length <= MAX_RATIONALE_CHARS) {
    return compact;
  }
  return `${compact.slice(0, MAX_RATIONALE_CHARS - 3)}...`;
}
