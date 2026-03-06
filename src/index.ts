import { loadConfig } from './utils/config.js';
import { runPlatform } from './orchestrator/platform-orchestrator.js';

async function main(): Promise<void> {
  const configPath = parseConfigPath(process.argv.slice(2));
  const config = await loadConfig(configPath);

  const report = await runPlatform(config);

  const successCount = report.results.filter((item) => item.success).length;
  const failedCount = report.results.length - successCount;

  console.log('\n=== totalcover run summary ===');
  console.log(`generatedAt: ${report.generatedAt}`);
  console.log(`checkpointFile: ${report.checkpointFile}`);
  console.log(`resumedFromCheckpoint: ${report.resumedFromCheckpoint}`);
  console.log(`interrupted: ${report.interrupted}`);
  console.log(`unitCommandsRun: ${report.unitCommandsRun}`);
  console.log(`e2eCommandsRun: ${report.e2eCommandsRun}`);
  console.log(`skillCommandsExtracted: ${report.skillCommandsExtracted}`);
  console.log(`coverageDiscoveryNotes: ${report.coverageDiscoveryNotes.length}`);
  for (const note of report.coverageDiscoveryNotes) {
    console.log(`- ${note}`);
  }
  console.log(`totalUncoveredSegments: ${report.totalUncoveredSegments}`);
  console.log(`scoredSegments: ${report.scoredSegments}`);
  console.log(`queuedSegments: ${report.queuedSegments}`);
  console.log(`remainingSegments: ${report.remainingSegments}`);
  console.log(`generatedSuccess: ${successCount}`);
  console.log(`generatedFailed: ${failedCount}`);
}

function parseConfigPath(args: string[]): string | undefined {
  const index = args.findIndex((arg) => arg === '--config' || arg === '-c');
  if (index >= 0 && args[index + 1]) {
    return args[index + 1];
  }
  return undefined;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
