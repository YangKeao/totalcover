import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { PlatformConfig } from '../types.js';

export async function loadConfig(configPathArg?: string): Promise<PlatformConfig> {
  const configPath = path.resolve(configPathArg ?? 'platform.config.json');
  const configRaw = await readFile(configPath, 'utf8');
  const config = JSON.parse(configRaw) as PlatformConfig;

  validateConfig(config, configPath);
  return {
    ...config,
    repo: {
      ...config.repo,
      localPath: path.resolve(config.repo.localPath),
    },
    output: {
      scoredTasksFile: path.resolve(config.output.scoredTasksFile),
      runReportFile: path.resolve(config.output.runReportFile),
      checkpointFile: config.output.checkpointFile
        ? path.resolve(config.output.checkpointFile)
        : undefined,
    },
  };
}

function validateConfig(config: PlatformConfig, configPath: string): void {
  if (!config.repo?.url || !config.repo?.localPath) {
    throw new Error(`Invalid config at ${configPath}: repo.url and repo.localPath are required`);
  }
  const hasLegacyCommands =
    Array.isArray(config.coverage?.commands) && config.coverage.commands.length > 0;
  const hasUnitCommands =
    Array.isArray(config.coverage?.unitCommands) && config.coverage.unitCommands.length > 0;
  const hasE2ECommands =
    Array.isArray(config.coverage?.e2eCommands) && config.coverage.e2eCommands.length > 0;
  const autoDetectEnabled = config.coverage?.autoDetectTidbCommands !== false;

  if (!hasLegacyCommands && !hasUnitCommands && !hasE2ECommands && !autoDetectEnabled) {
    throw new Error(
      `Invalid config at ${configPath}: provide coverage.commands or coverage.unitCommands/e2eCommands, or keep coverage.autoDetectTidbCommands=true`,
    );
  }
  if (!Array.isArray(config.coverage?.profileGlobs) || config.coverage.profileGlobs.length === 0) {
    throw new Error(`Invalid config at ${configPath}: coverage.profileGlobs must be a non-empty array`);
  }
  if (
    config.coverage?.utMaxProcs !== undefined &&
    (!Number.isFinite(config.coverage.utMaxProcs) || config.coverage.utMaxProcs < 1)
  ) {
    throw new Error(`Invalid config at ${configPath}: coverage.utMaxProcs must be >= 1`);
  }
  if (
    config.coverage?.scopePackage !== undefined &&
    (!config.coverage.scopePackage.trim() || config.coverage.scopePackage.includes('..'))
  ) {
    throw new Error(`Invalid config at ${configPath}: coverage.scopePackage must be a safe relative package path`);
  }
  if (
    config.coverage?.scopeRunner !== undefined &&
    config.coverage.scopeRunner !== 'ut' &&
    config.coverage.scopeRunner !== 'go-test'
  ) {
    throw new Error(`Invalid config at ${configPath}: coverage.scopeRunner must be \"ut\" or \"go-test\"`);
  }
  if (
    config.coverage?.commandTimeoutMs !== undefined &&
    (!Number.isFinite(config.coverage.commandTimeoutMs) || config.coverage.commandTimeoutMs <= 0)
  ) {
    throw new Error(`Invalid config at ${configPath}: coverage.commandTimeoutMs must be > 0`);
  }
}
