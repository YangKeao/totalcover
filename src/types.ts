export interface PlatformConfig {
  repo: {
    url: string;
    branch?: string;
    localPath: string;
    refresh?: boolean;
    cloneDepth?: number;
  };
  coverage: {
    /**
     * Auto-detect TiDB UT/E2E coverage commands from repository files.
     * Enabled by default.
     */
    autoDetectTidbCommands?: boolean;
    /**
     * Whether to run unit test coverage stage.
     */
    runUnit?: boolean;
    /**
     * Whether to run E2E coverage stage.
     */
    runE2E?: boolean;
    /**
     * Optional package scope for TiDB UT auto-discovery, e.g. "pkg/expression".
     */
    scopePackage?: string;
    /**
     * When scopePackage is set, choose scoped runner.
     * - "ut": use tools/bin/ut run <pkg>
     * - "go-test": use go test ./<pkg>/...
     */
    scopeRunner?: 'ut' | 'go-test';
    /**
     * Upper bound for UT parallel workers by setting GOMAXPROCS for tools/bin/ut.
     */
    utMaxProcs?: number;
    /**
     * Optional environment variables applied to coverage commands.
     */
    env?: Record<string, string>;
    /**
     * Optional timeout for each coverage command.
     */
    commandTimeoutMs?: number;
    /**
     * Continue pipeline even when a coverage command exits non-zero.
     * Useful for flaky/full-repo UT runs where a usable profile is still produced.
     */
    allowCommandFailure?: boolean;
    /**
     * Backward-compatible field. If present, treated as unit test coverage commands.
     */
    commands?: string[];
    /**
     * Unit test coverage commands.
     */
    unitCommands?: string[];
    /**
     * E2E/integration coverage commands.
     */
    e2eCommands?: string[];
    profileGlobs: string[];
  };
  scoring: {
    model: string;
    concurrency: number;
    minScore: number;
    chunkSize: number;
  };
  generation: {
    concurrency: number;
    maxRetries: number;
    /**
     * When true, failed generation results from a checkpoint are re-queued for retry.
     */
    retryFailed?: boolean;
  };
  verification: {
    goTestTimeoutMs: number;
    requireCoverageHit: boolean;
  };
  output: {
    scoredTasksFile: string;
    runReportFile: string;
    checkpointFile?: string;
  };
}

export interface CoverageBlock {
  filePath: string;
  startLine: number;
  endLine: number;
  executionCount: number;
}

export interface FunctionBoundary {
  name: string;
  startLine: number;
  endLine: number;
}

export interface UncoveredSegment {
  id: string;
  filePath: string;
  packagePath: string;
  functionName: string;
  startLine: number;
  endLine: number;
  lines: number[];
  snippet: string;
}

export interface ScoredSegment extends UncoveredSegment {
  score: number;
  keep: boolean;
  rationale: string;
}

export interface GeneratedTestPlan {
  testFilePath: string;
  testCode: string;
  testName: string;
  goTestPackage: string;
  reasoning: string;
  sourceFixes?: SourceFix[];
}

export interface SourceFix {
  filePath: string;
  search: string;
  replace: string;
  reason: string;
}

export interface GeneratedTaskResult {
  segmentId: string;
  success: boolean;
  score: number;
  testFilePath?: string;
  testName?: string;
  /**
   * Codex thread id used for this segment's generation attempts.
   * Allows cross-process retries to resume the same conversation.
   */
  threadId?: string;
  attempts: number;
  coverageHit: boolean;
  errors: string[];
}

export interface ScoringDecision {
  segmentId: string;
  score: number;
  keep: boolean;
  rationale: string;
}
