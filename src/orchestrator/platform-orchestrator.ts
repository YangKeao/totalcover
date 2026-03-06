import { scoreUncoveredSegments } from '../ai/critic.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveCoverageCommands } from '../coverage/coverage-command-resolver.js';
import { extractCompletelyUncoveredSegments } from '../coverage/coverage-parser.js';
import { collectCoverageProfiles, runCoverageCommands } from '../coverage/coverage-runner.js';
import { prepareRepository } from '../repo/repo-manager.js';
import type {
  GeneratedTaskResult,
  PlatformConfig,
  ScoredSegment,
  ScoringDecision,
  UncoveredSegment,
} from '../types.js';
import { readJsonFileIfExists, writeJsonFile } from '../utils/report.js';
import { CodexClient } from '../ai/codex-client.js';
import { AsyncTaskQueue } from './async-task-queue.js';
import { CheckpointManager, createCheckpointPath, type CheckpointStage } from './checkpoint.js';
import { ShutdownController } from './shutdown.js';
import { generateAndVerifyTest } from './test-generator.js';
import { execCommand } from '../utils/exec.js';

export interface PlatformRunReport {
  generatedAt: string;
  interrupted: boolean;
  resumedFromCheckpoint: boolean;
  checkpointFile: string;
  unitCommandsRun: number;
  e2eCommandsRun: number;
  skillCommandsExtracted: number;
  coverageDiscoveryNotes: string[];
  totalUncoveredSegments: number;
  scoredSegments: number;
  queuedSegments: number;
  remainingSegments: number;
  results: GeneratedTaskResult[];
}

/**
 * End-to-end scheduler:
 * 1. Prepare repository and generate fresh coverage profiles.
 * 2. Parse fully-uncovered segments.
 * 3. Ask Codex to score/filter segments.
 * 4. Run high-score segments through parallel generation+verification workers.
 * 5. Persist scored tasks and final run report.
 */
export async function runPlatform(config: PlatformConfig): Promise<PlatformRunReport> {
  const shutdown = new ShutdownController();
  shutdown.onRequest(() => {
    console.log('[orchestrator] received shutdown signal, finishing current in-flight tasks and checkpointing...');
  });

  await prepareRepository(config.repo);

  const checkpointFile = createCheckpointPath(config);
  const checkpointManager = new CheckpointManager(checkpointFile, config);
  const restoredCheckpoint = await checkpointManager.load();
  const resumedFromCheckpoint = Boolean(restoredCheckpoint);

  const resolvedCoverage = await resolveCoverageCommands(config.repo.localPath, config.coverage);
  console.log(
    `[coverage:discover] resolved ${resolvedCoverage.unitCommands.length} unit command(s), ${resolvedCoverage.e2eCommands.length} e2e command(s).`,
  );
  for (const note of resolvedCoverage.discoveryNotes) {
    console.log(`[coverage:discover] ${note}`);
  }

  let profilePaths: string[] = [];
  let generationResults = dedupeResults(restoredCheckpoint?.generationResults ?? []);
  let remainingSegments = 0;
  let totalUncoveredSegments = 0;
  let scoredSegmentsCount = 0;
  let queuedSegmentsCount = 0;

  const hasUsableCoverage =
    restoredCheckpoint &&
    isStageAtLeast(restoredCheckpoint.stage, 'coverage_collected') &&
    (await checkpointManager.hasUsableCoverageProfiles(restoredCheckpoint));
  if (hasUsableCoverage) {
    profilePaths = [...(restoredCheckpoint.profilePaths ?? [])];
    console.log(
      `[checkpoint] resumed coverage profiles from ${checkpointFile} (${profilePaths.length} files).`,
    );
  } else {
    if (
      restoredCheckpoint &&
      isStageAtLeast(restoredCheckpoint.stage, 'coverage_collected') &&
      process.env.TOTALCOVER_ALLOW_CHECKPOINT_OVERWRITE !== '1'
    ) {
      throw new Error(
        `Checkpoint exists but coverage profiles are missing or unusable. Refusing to overwrite without explicit consent. ` +
          `Set TOTALCOVER_ALLOW_CHECKPOINT_OVERWRITE=1 or remove ${checkpointFile} after confirmation.`,
      );
    }
    await checkpointManager.save('initialized');
    if (resolvedCoverage.unitCommands.length > 0) {
      console.log(`[coverage:unit] starting ${resolvedCoverage.unitCommands.length} command(s).`);
    }
    await runCoverageCommands(config.repo.localPath, resolvedCoverage.unitCommands, 'unit', {
      env: config.coverage.env,
      timeoutMs: config.coverage.commandTimeoutMs,
      allowFailure: config.coverage.allowCommandFailure,
    });
    if (resolvedCoverage.unitCommands.length > 0) {
      console.log('[coverage:unit] completed.');
    }
    if (shutdown.isRequested()) {
      return await finalizeReport(config, {
        interrupted: true,
        resumedFromCheckpoint,
        checkpointFile,
        unitCommandsRun: resolvedCoverage.unitCommands.length,
        e2eCommandsRun: resolvedCoverage.e2eCommands.length,
        skillCommandsExtracted: resolvedCoverage.skillCommandsExtracted,
        coverageDiscoveryNotes: resolvedCoverage.discoveryNotes,
        totalUncoveredSegments,
        scoredSegments: scoredSegmentsCount,
        queuedSegments: queuedSegmentsCount,
        remainingSegments,
        results: generationResults,
      });
    }

    if (resolvedCoverage.e2eCommands.length > 0) {
      console.log(`[coverage:e2e] starting ${resolvedCoverage.e2eCommands.length} command(s).`);
    }
    await runCoverageCommands(config.repo.localPath, resolvedCoverage.e2eCommands, 'e2e', {
      env: config.coverage.env,
      timeoutMs: config.coverage.commandTimeoutMs,
      allowFailure: config.coverage.allowCommandFailure,
    });
    if (resolvedCoverage.e2eCommands.length > 0) {
      console.log('[coverage:e2e] completed.');
    }

    console.log('[coverage] collecting coverage profiles...');
    profilePaths = await collectCoverageProfiles(config.repo.localPath, resolvedCoverage.profileGlobs);
    console.log(`[coverage] collected ${profilePaths.length} profile(s).`);
    await checkpointManager.save('coverage_collected', {
      profilePaths,
      generationResults,
    });
  }

  if (shutdown.isRequested()) {
    return await finalizeReport(config, {
      interrupted: true,
      resumedFromCheckpoint,
      checkpointFile,
      unitCommandsRun: resolvedCoverage.unitCommands.length,
      e2eCommandsRun: resolvedCoverage.e2eCommands.length,
      skillCommandsExtracted: resolvedCoverage.skillCommandsExtracted,
      coverageDiscoveryNotes: resolvedCoverage.discoveryNotes,
      totalUncoveredSegments,
      scoredSegments: scoredSegmentsCount,
      queuedSegments: queuedSegmentsCount,
      remainingSegments,
      results: generationResults,
    });
  }

  await enableFailpointIfAvailable(config.repo.localPath, config.coverage.env);

  console.log('[coverage] extracting uncovered segments...');
  const uncoveredSegments = await extractCompletelyUncoveredSegments(config.repo.localPath, profilePaths);
  totalUncoveredSegments = uncoveredSegments.length;
  console.log(`[coverage] extracted ${totalUncoveredSegments} uncovered segment(s).`);

  const codexClient = new CodexClient(config.scoring.model, config.repo.localPath);
  let scoredSegments: ScoredSegment[];
  try {
    console.log('[scoring] scoring uncovered segments...');
    scoredSegments = await loadOrScoreSegments(
      config,
      checkpointManager,
      restoredCheckpoint?.stage,
      codexClient,
      uncoveredSegments,
      profilePaths,
      generationResults,
    );
  } catch (error) {
    if (!shutdown.isRequested()) {
      throw error;
    }
    return await finalizeReport(config, {
      interrupted: true,
      resumedFromCheckpoint,
      checkpointFile,
      unitCommandsRun: resolvedCoverage.unitCommands.length,
      e2eCommandsRun: resolvedCoverage.e2eCommands.length,
      skillCommandsExtracted: resolvedCoverage.skillCommandsExtracted,
      coverageDiscoveryNotes: resolvedCoverage.discoveryNotes,
      totalUncoveredSegments,
      scoredSegments: 0,
      queuedSegments: 0,
      remainingSegments: 0,
      results: generationResults,
    });
  }
  scoredSegmentsCount = scoredSegments.length;
  console.log(`[scoring] completed: ${scoredSegmentsCount} segment(s) scored.`);

  const queuedSegments = scoredSegments.filter(
    (segment) => segment.keep && segment.score >= config.scoring.minScore,
  );
  queuedSegments.sort((a, b) => b.score - a.score);
  queuedSegmentsCount = queuedSegments.length;
  console.log(
    `[generation] queued ${queuedSegmentsCount} segment(s) (minScore=${config.scoring.minScore}).`,
  );
  console.log(`[generation] total filtered for generation: ${queuedSegmentsCount}.`);

  const retryFailed = config.generation.retryFailed === true;
  if (retryFailed) {
    console.log('[generation] retryFailed enabled: failed segments will be re-queued.');
  }
  const threadIdBySegment = new Map<string, string>();
  for (const result of generationResults) {
    if (result.threadId) {
      threadIdBySegment.set(result.segmentId, result.threadId);
    }
  }
  const completedSegmentIds = new Set(
    generationResults
      .filter((result) => result.success || !retryFailed)
      .map((result) => result.segmentId),
  );
  const pendingSegments = queuedSegments.filter((segment) => !completedSegmentIds.has(segment.id));
  remainingSegments = pendingSegments.length;
  const totalGeneration = queuedSegmentsCount;

  if (pendingSegments.length === 0 && !shutdown.isRequested()) {
    await checkpointManager.save('completed', {
      profilePaths,
      generationResults,
    });
    return await finalizeReport(config, {
      interrupted: false,
      resumedFromCheckpoint,
      checkpointFile,
      unitCommandsRun: resolvedCoverage.unitCommands.length,
      e2eCommandsRun: resolvedCoverage.e2eCommands.length,
      skillCommandsExtracted: resolvedCoverage.skillCommandsExtracted,
      coverageDiscoveryNotes: resolvedCoverage.discoveryNotes,
      totalUncoveredSegments,
      scoredSegments: scoredSegmentsCount,
      queuedSegments: queuedSegmentsCount,
      remainingSegments: 0,
      results: orderResults(queuedSegments, generationResults),
    });
  }

  // Ensure failpoints are enabled before generating tests (required by TiDB).
  await enableFailpointIfAvailable(config.repo.localPath, config.coverage.env);

  const queue = new AsyncTaskQueue<ScoredSegment, GeneratedTaskResult>(
    pendingSegments,
    config.generation.concurrency,
  );

  console.log(
    `[generation] starting ${pendingSegments.length} segment(s) with concurrency=${config.generation.concurrency}.`,
  );
  const generationCompleted = new Set(completedSegmentIds);
  if (totalGeneration > 0 && generationCompleted.size > 0) {
    const percent = Math.floor((generationCompleted.size / totalGeneration) * 100);
    console.log(
      `[generation] progress ${generationCompleted.size}/${totalGeneration} (${percent}%) resumed.`,
    );
  }
  await checkpointManager.save('generation_in_progress', {
    profilePaths,
    generationResults,
  });
  let checkpointWriteChain = Promise.resolve();

  const queueRun = await queue.run(
    async (segment) => {
      try {
        return await generateAndVerifyTest(codexClient, config.repo.localPath, segment, {
          maxRetries: config.generation.maxRetries,
          goTestTimeoutMs: config.verification.goTestTimeoutMs,
          requireCoverageHit: config.verification.requireCoverageHit,
          threadId: threadIdBySegment.get(segment.id),
        });
      } catch (error) {
        return {
          segmentId: segment.id,
          success: false,
          score: segment.score,
          threadId: threadIdBySegment.get(segment.id),
          attempts: 0,
          coverageHit: false,
          errors: [error instanceof Error ? error.message : String(error)],
        } satisfies GeneratedTaskResult;
      }
    },
    {
      shouldStop: () => shutdown.isRequested(),
      onResult: async (_segment, result) => {
        generationResults = dedupeResults([...generationResults, result]);
        generationCompleted.add(result.segmentId);
        const completed = generationCompleted.size;
        const percent = totalGeneration === 0 ? 100 : Math.floor((completed / totalGeneration) * 100);
        console.log(
          `[generation] ${completed}/${totalGeneration} (${percent}%) ${result.success ? 'ok' : 'fail'} ${result.segmentId} attempts=${result.attempts} coverageHit=${result.coverageHit}`,
        );
        if (!result.success && result.errors.length > 0) {
          console.log(`[generation] errors for ${result.segmentId}:`);
          result.errors.forEach((error, index) => {
            console.log(`[generation] error ${index + 1}/${result.errors.length}: ${error}`);
          });
        }
        checkpointWriteChain = checkpointWriteChain.then(async () => {
          await checkpointManager.save('generation_in_progress', {
            profilePaths,
            generationResults,
          });
        });
        await checkpointWriteChain;
      },
    },
  );
  await checkpointWriteChain;
  remainingSegments = queueRun.remaining;
  const interrupted = shutdown.isRequested() || queueRun.remaining > 0;
  const orderedResults = orderResults(queuedSegments, generationResults);

  if (!interrupted) {
    await checkpointManager.save('completed', {
      profilePaths,
      generationResults,
    });
  }

  return await finalizeReport(config, {
    interrupted,
    resumedFromCheckpoint,
    checkpointFile,
    unitCommandsRun: resolvedCoverage.unitCommands.length,
    e2eCommandsRun: resolvedCoverage.e2eCommands.length,
    skillCommandsExtracted: resolvedCoverage.skillCommandsExtracted,
    coverageDiscoveryNotes: resolvedCoverage.discoveryNotes,
    totalUncoveredSegments,
    scoredSegments: scoredSegmentsCount,
    queuedSegments: queuedSegmentsCount,
    remainingSegments,
    results: orderedResults,
  });
}

async function persistScoredSegments(outputPath: string, scoredSegments: ScoredSegment[]): Promise<void> {
  await writeJsonFile(outputPath, scoredSegments);
}

async function loadOrScoreSegments(
  config: PlatformConfig,
  checkpointManager: CheckpointManager,
  checkpointStage: CheckpointStage | undefined,
  codexClient: CodexClient,
  uncoveredSegments: UncoveredSegment[],
  profilePaths: string[],
  generationResults: GeneratedTaskResult[],
): Promise<ScoredSegment[]> {
  const checkpoint = await checkpointManager.load();
  if (checkpointStage && isStageAtLeast(checkpointStage, 'scoring_completed')) {
    const restored = await readJsonFileIfExists<ScoredSegment[]>(config.output.scoredTasksFile);
    if (restored) {
      console.log(`[checkpoint] resumed scored segments from ${config.output.scoredTasksFile}.`);
      return restored;
    }
    if (checkpoint?.scoredDecisions && checkpoint.scoredDecisions.length > 0) {
      console.log('[checkpoint] resumed scored decisions from checkpoint payload.');
      const scored = applyScoringDecisions(uncoveredSegments, checkpoint.scoredDecisions);
      await persistScoredSegments(config.output.scoredTasksFile, scored);
      return scored;
    }
    console.log(
      `[checkpoint] scoring stage exists but ${config.output.scoredTasksFile} is missing; rescoring.`,
    );
  }

  const decisionMap = new Map<string, ScoringDecision>();
  for (const decision of checkpoint?.scoredDecisions ?? []) {
    decisionMap.set(decision.segmentId, decision);
  }

  if (decisionMap.size > 0) {
    console.log(`[checkpoint] resumed ${decisionMap.size} scored decision(s) from checkpoint payload.`);
  }

  const remainingSegments = uncoveredSegments.filter((segment) => !decisionMap.has(segment.id));
  if (remainingSegments.length > 0) {
    console.log(
      `[scoring] remaining ${remainingSegments.length} segment(s) to score (checkpoint has ${decisionMap.size}).`,
    );
    let checkpointWriteChain = Promise.resolve();
    let pendingCount = 0;
    let lastFlush = Date.now();

    const flush = async (force = false) => {
      if (!force) {
        if (pendingCount < SCORING_CHECKPOINT_BATCH_SIZE) {
          if (Date.now() - lastFlush < SCORING_CHECKPOINT_INTERVAL_MS) {
            return;
          }
        }
      }
      pendingCount = 0;
      lastFlush = Date.now();
      const scoredDecisions = [...decisionMap.values()];
      checkpointWriteChain = checkpointWriteChain.then(async () => {
        await checkpointManager.save('scoring_in_progress', {
          profilePaths,
          scoredDecisions,
          generationResults,
        });
      });
      await checkpointWriteChain;
    };

    await scoreUncoveredSegments(codexClient, remainingSegments, {
      concurrency: config.scoring.concurrency,
      chunkSize: config.scoring.chunkSize,
      onDecisionBatch: async (batch) => {
        if (batch.length === 0) {
          return;
        }
        for (const decision of batch) {
          decisionMap.set(decision.segmentId, decision);
        }
        pendingCount += batch.length;
        await flush(false);
      },
    });

    await flush(true);
  }

  const scoredDecisions = [...decisionMap.values()];
  const scoredSegments = applyScoringDecisions(uncoveredSegments, scoredDecisions);

  await persistScoredSegments(config.output.scoredTasksFile, scoredSegments);
  await checkpointManager.save('scoring_completed', {
    profilePaths,
    scoredDecisions,
    generationResults,
  });
  return scoredSegments;
}

async function finalizeReport(
  config: PlatformConfig,
  payload: Omit<PlatformRunReport, 'generatedAt'>,
): Promise<PlatformRunReport> {
  const report: PlatformRunReport = {
    generatedAt: new Date().toISOString(),
    ...payload,
  };
  await writeJsonFile(config.output.runReportFile, report);
  return report;
}

function dedupeResults(results: GeneratedTaskResult[]): GeneratedTaskResult[] {
  const bySegment = new Map<string, GeneratedTaskResult>();
  for (const result of results) {
    bySegment.set(result.segmentId, result);
  }
  return [...bySegment.values()];
}

function orderResults(
  queuedSegments: ScoredSegment[],
  results: GeneratedTaskResult[],
): GeneratedTaskResult[] {
  const resultMap = new Map<string, GeneratedTaskResult>();
  for (const result of results) {
    resultMap.set(result.segmentId, result);
  }

  const ordered: GeneratedTaskResult[] = [];
  for (const segment of queuedSegments) {
    const result = resultMap.get(segment.id);
    if (result) {
      ordered.push(result);
    }
  }
  return ordered;
}

function isStageAtLeast(stage: CheckpointStage, required: CheckpointStage): boolean {
  return STAGE_ORDER.indexOf(stage) >= STAGE_ORDER.indexOf(required);
}

const STAGE_ORDER: CheckpointStage[] = [
  'initialized',
  'coverage_collected',
  'scoring_in_progress',
  'scoring_completed',
  'generation_in_progress',
  'completed',
];

function applyScoringDecisions(
  segments: UncoveredSegment[],
  decisions: ScoringDecision[],
): ScoredSegment[] {
  const decisionMap = new Map<string, ScoringDecision>();
  for (const decision of decisions) {
    decisionMap.set(decision.segmentId, decision);
  }

  return segments.map((segment) => {
    const decision = decisionMap.get(segment.id);
    if (!decision) {
      return {
        ...segment,
        score: 0,
        keep: false,
        rationale: 'No scoring decision found in checkpoint.',
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

const SCORING_CHECKPOINT_BATCH_SIZE = 500;
const SCORING_CHECKPOINT_INTERVAL_MS = 30_000;

async function enableFailpointIfAvailable(
  repoPath: string,
  env?: Record<string, string>,
): Promise<void> {
  const makefilePath = path.resolve(repoPath, 'Makefile');
  let makefileText: string | null = null;
  try {
    makefileText = await readFile(makefilePath, 'utf8');
  } catch {
    console.log('[scoring] failpoint-enable skipped (Makefile not found).');
    return;
  }

  if (!/^\s*failpoint-enable:/m.test(makefileText)) {
    console.log('[scoring] failpoint-enable skipped (target not found).');
    return;
  }

  console.log('[scoring] enabling failpoints to keep line numbers aligned...');
  const result = await execCommand('make failpoint-enable', { cwd: repoPath, env });
  if (result.exitCode !== 0) {
    const detail = result.stderr || result.stdout;
    throw new Error(`make failpoint-enable failed (exit ${result.exitCode})${detail ? `: ${detail}` : ''}`);
  }
}
