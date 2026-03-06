import type { GeneratedTaskResult, PlatformConfig, ScoringDecision } from '../types.js';
import { pathExists, readJsonFileIfExists, writeJsonFile } from '../utils/report.js';

export type CheckpointStage =
  | 'initialized'
  | 'coverage_collected'
  | 'scoring_in_progress'
  | 'scoring_completed'
  | 'generation_in_progress'
  | 'completed';

export interface RunCheckpoint {
  version: 1;
  updatedAt: string;
  stage: CheckpointStage;
  profilePaths?: string[];
  scoredDecisions?: ScoringDecision[];
  generationResults?: GeneratedTaskResult[];
}

export class CheckpointManager {
  constructor(private readonly checkpointPath: string, config: PlatformConfig) {
    void config;
  }

  async load(): Promise<RunCheckpoint | undefined> {
    const checkpoint = await readJsonFileIfExists<RunCheckpoint>(this.checkpointPath);
    if (!checkpoint) {
      return undefined;
    }
    if (checkpoint.version !== 1) {
      return undefined;
    }
    return checkpoint;
  }

  async save(stage: CheckpointStage, patch: Partial<RunCheckpoint> = {}): Promise<RunCheckpoint> {
    const raw = await readJsonFileIfExists<RunCheckpoint>(this.checkpointPath);
    if (raw && raw.version !== 1) {
      throw new Error(
        `Checkpoint version ${raw.version} is not supported; please confirm before removing or resetting ${this.checkpointPath}.`,
      );
    }
    const current = (await this.load()) ?? {
      version: 1 as const,
      updatedAt: new Date().toISOString(),
      stage: 'initialized' as const,
      generationResults: [],
    };

    const next: RunCheckpoint = {
      ...current,
      ...patch,
      version: 1,
      stage,
      updatedAt: new Date().toISOString(),
    };

    await writeJsonFile(this.checkpointPath, next);
    return next;
  }

  async hasUsableCoverageProfiles(checkpoint: RunCheckpoint | undefined): Promise<boolean> {
    if (!checkpoint?.profilePaths || checkpoint.profilePaths.length === 0) {
      return false;
    }
    for (const profilePath of checkpoint.profilePaths) {
      if (!(await pathExists(profilePath))) {
        return false;
      }
    }
    return true;
  }
}

export function createCheckpointPath(config: PlatformConfig): string {
  return config.output.checkpointFile ?? `${config.output.runReportFile}.checkpoint.json`;
}
