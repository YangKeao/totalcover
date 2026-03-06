import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { CodexClient } from '../ai/codex-client.js';
import { verifyCoverageHit } from '../coverage/coverage-verifier.js';
import type {
  GeneratedTaskResult,
  GeneratedTestPlan,
  ScoredSegment,
  SourceFix,
} from '../types.js';
import { execCommand } from '../utils/exec.js';

const GENERATION_SYSTEM_PROMPT = [
  'You are a TiDB test generation expert.',
  'You must obey repository AGENTS.md and active skills discovered by Codex SDK.',
  'You only return strict JSON and no markdown.',
  'Generate compilable Go tests that focus on meaningful behavior and deterministic assertions.',
  'If your analysis suggests a real product bug, include a minimal source fix and make the test a regression test.',
  'When you include a source fix, the test must contain a clear comment explaining what bug was fixed.',
].join(' ');

export async function generateAndVerifyTest(
  codexClient: CodexClient,
  repoPath: string,
  segment: ScoredSegment,
  options: {
    maxRetries: number;
    goTestTimeoutMs: number;
    requireCoverageHit: boolean;
    threadId?: string;
  },
): Promise<GeneratedTaskResult> {
  const errors: string[] = [];
  const thread = codexClient.createThread(options.threadId);
  let threadId: string | undefined = thread.id ?? options.threadId;

  // Closed-loop repair: generate -> run go test -> if failed send stderr back to Codex.
  for (let attempt = 1; attempt <= options.maxRetries; attempt += 1) {
    const priorError = errors.length > 0 ? errors[errors.length - 1] : '';
    let plan: GeneratedTestPlan | undefined;
    let snapshots = new Map<string, FileSnapshot>();

    try {
      console.log(
        `[generate] segment ${segment.id} package=${segment.packagePath} file=${segment.filePath} attempt=${attempt}/${options.maxRetries}`,
      );
      plan = await requestTestPlan(codexClient, segment, attempt, priorError, thread);
      if (!threadId && thread.id) {
        threadId = thread.id;
      }
      const absoluteTestFile = ensureInsideRepo(repoPath, plan.testFilePath);
      const touchedPaths = [plan.testFilePath, ...(plan.sourceFixes ?? []).map((fix) => fix.filePath)];
      snapshots = await snapshotFiles(repoPath, touchedPaths);

      await applySourceFixes(repoPath, plan.sourceFixes ?? []);
      await mkdir(path.dirname(absoluteTestFile), { recursive: true });
      await writeFile(absoluteTestFile, plan.testCode, 'utf8');

      const runCommand = `go test ${plan.goTestPackage} -run '^${escapeForGoTestRegex(plan.testName)}$' -count=1`;
      console.log(`[generate] running: ${runCommand}`);
      const runResult = await execCommand(runCommand, {
        cwd: repoPath,
        timeoutMs: options.goTestTimeoutMs,
      });

      if (runResult.exitCode !== 0) {
        errors.push(`Attempt ${attempt}: ${runResult.stderr || runResult.stdout}`);
        await restoreFiles(snapshots);
        continue;
      }

      let coverageHit = true;
      if (options.requireCoverageHit) {
        // Confirmation run guarantees we did not only generate a passing test,
        // but actually touched the original uncovered target lines.
        const coverageProfilePath = path.resolve(
          repoPath,
          '.totalcover',
          `${sanitizeFileName(segment.id)}-attempt-${attempt}.out`,
        );
        await mkdir(path.dirname(coverageProfilePath), { recursive: true });

        const coverageCommand = `go test ${plan.goTestPackage} -run '^${escapeForGoTestRegex(plan.testName)}$' -count=1 -covermode=atomic -coverprofile='${coverageProfilePath}'`;
        console.log(`[generate] coverage run: ${coverageCommand}`);
        const coverageResult = await execCommand(coverageCommand, {
          cwd: repoPath,
          timeoutMs: options.goTestTimeoutMs,
        });

        if (coverageResult.exitCode !== 0) {
          errors.push(`Attempt ${attempt} coverage run failed: ${coverageResult.stderr || coverageResult.stdout}`);
          await restoreFiles(snapshots);
          continue;
        }

        coverageHit = await verifyCoverageHit(repoPath, coverageProfilePath, segment.filePath, segment.lines);
        if (!coverageHit) {
          errors.push(
            `Attempt ${attempt}: generated test passed but did not cover target lines ${segment.lines.join(',')} in ${segment.filePath}`,
          );
          await restoreFiles(snapshots);
          continue;
        }
      }

      return {
        segmentId: segment.id,
        success: true,
        score: segment.score,
        testFilePath: plan.testFilePath,
        testName: plan.testName,
        threadId,
        attempts: attempt,
        coverageHit,
        errors,
      };
    } catch (error) {
      if (snapshots.size > 0) {
        await restoreFiles(snapshots);
      }
      errors.push(`Attempt ${attempt}: ${error instanceof Error ? error.message : String(error)}`);
      if (attempt >= options.maxRetries) {
        break;
      }
    }
  }

  return {
    segmentId: segment.id,
    success: false,
    score: segment.score,
    threadId,
    attempts: options.maxRetries,
    coverageHit: false,
    errors,
  };
}

async function requestTestPlan(
  codexClient: CodexClient,
  segment: ScoredSegment,
  attempt: number,
  priorError: string,
  thread: ReturnType<CodexClient['createThread']>,
): Promise<GeneratedTestPlan> {
  const userPrompt = [
    'Use repository-local AGENTS.md and loaded skills as mandatory rules.',
    'If existing behavior suggests a real bug, propose a minimal source fix and add a regression comment in the test.',
    'Regression comment format: // Regression test: <what was broken and why this fix is needed>',
    'Target uncovered segment:',
    `segmentId: ${segment.id}`,
    `filePath: ${segment.filePath}`,
    `packagePath: ${segment.packagePath}`,
    `functionName: ${segment.functionName}`,
    `targetLines: ${segment.lines.join(',')}`,
    `snippet:\n${segment.snippet}`,
    `score rationale: ${segment.rationale}`,
    `attempt: ${attempt}`,
    priorError ? `previous failure:\n${priorError}` : 'previous failure: none',
    '',
    'Output strict JSON schema:',
    '{',
    '  "testFilePath": "relative path under repository, must end with _test.go",',
    '  "testCode": "full go source code",',
    '  "testName": "single generated test function name",',
    '  "goTestPackage": "go package selector, e.g. ./pkg/parser",',
    '  "reasoning": "short summary",',
    '  "sourceFixes": [',
    '    {',
    '      "filePath": "relative non-test go file path to patch",',
    '      "search": "exact old snippet to replace (single replacement)",',
    '      "replace": "new snippet",',
    '      "reason": "why this is a bug fix"',
    '    }',
    '  ]',
    '}',
    'If no source fix is needed, return "sourceFixes": [].',
    'When sourceFixes is non-empty, testCode must contain a regression comment describing the fix.',
    'Do not include markdown fences.',
  ].join('\n');

  const rawPlan = await codexClient.jsonCompletionInThread<GeneratedTestPlan>(
    thread,
    GENERATION_SYSTEM_PROMPT,
    userPrompt,
  );

  validatePlan(rawPlan);
  return rawPlan;
}

function validatePlan(plan: GeneratedTestPlan): void {
  if (!plan.testFilePath || !plan.testFilePath.endsWith('_test.go')) {
    throw new Error(`Invalid testFilePath from Codex: ${plan.testFilePath}`);
  }
  if (!plan.testCode || !plan.testCode.includes('func')) {
    throw new Error('Codex did not return valid Go test source code');
  }
  if (!plan.testName || !plan.testName.startsWith('Test')) {
    throw new Error(`Invalid testName from Codex: ${plan.testName}`);
  }
  if (!plan.goTestPackage || !plan.goTestPackage.startsWith('./')) {
    throw new Error(`Invalid goTestPackage from Codex: ${plan.goTestPackage}`);
  }
  if (!Array.isArray(plan.sourceFixes) && plan.sourceFixes !== undefined) {
    throw new Error('Invalid sourceFixes from Codex: must be an array when provided');
  }
  for (const fix of plan.sourceFixes ?? []) {
    if (!fix.filePath || fix.filePath.endsWith('_test.go')) {
      throw new Error(`Invalid source fix filePath from Codex: ${fix.filePath}`);
    }
    if (!fix.search) {
      throw new Error(`Invalid source fix search from Codex for file: ${fix.filePath}`);
    }
    if (fix.replace === undefined || fix.replace === null) {
      throw new Error(`Invalid source fix replace from Codex for file: ${fix.filePath}`);
    }
    if (!fix.reason) {
      throw new Error(`Invalid source fix reason from Codex for file: ${fix.filePath}`);
    }
  }
}

function ensureInsideRepo(repoPath: string, relativePath: string): string {
  const resolved = path.resolve(repoPath, relativePath);
  const normalizedRepo = path.resolve(repoPath);
  const isInside =
    resolved === normalizedRepo || resolved.startsWith(`${normalizedRepo}${path.sep}`);
  if (!isInside) {
    throw new Error(`testFilePath escapes repository root: ${relativePath}`);
  }
  return resolved;
}

function sanitizeFileName(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_.-]/g, '_');
}

function escapeForGoTestRegex(testName: string): string {
  return testName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface FileSnapshot {
  absolutePath: string;
  existed: boolean;
  content: string;
}

async function snapshotFiles(
  repoPath: string,
  relativePaths: string[],
): Promise<Map<string, FileSnapshot>> {
  const snapshots = new Map<string, FileSnapshot>();
  for (const relativePath of dedupe(relativePaths)) {
    const absolutePath = ensureInsideRepo(repoPath, relativePath);
    const existing = await readExistingFile(absolutePath);
    snapshots.set(relativePath, {
      absolutePath,
      existed: existing !== undefined,
      content: existing ?? '',
    });
  }
  return snapshots;
}

async function restoreFiles(snapshots: Map<string, FileSnapshot>): Promise<void> {
  for (const snapshot of snapshots.values()) {
    if (snapshot.existed) {
      await mkdir(path.dirname(snapshot.absolutePath), { recursive: true });
      await writeFile(snapshot.absolutePath, snapshot.content, 'utf8');
      continue;
    }
    try {
      await unlink(snapshot.absolutePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        throw error;
      }
    }
  }
}

async function applySourceFixes(repoPath: string, sourceFixes: SourceFix[]): Promise<void> {
  for (const fix of sourceFixes) {
    const absolutePath = ensureInsideRepo(repoPath, fix.filePath);
    const original = await readFile(absolutePath, 'utf8');
    const index = original.indexOf(fix.search);
    if (index < 0) {
      throw new Error(
        `Source fix search snippet not found in ${fix.filePath}. reason=${fix.reason}`,
      );
    }
    const next =
      original.slice(0, index) + fix.replace + original.slice(index + fix.search.length);
    await writeFile(absolutePath, next, 'utf8');
  }
}

async function readExistingFile(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}
