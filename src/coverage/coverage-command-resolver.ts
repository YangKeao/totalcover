import { access, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { PlatformConfig } from '../types.js';

const TIDB_MAKEFILE = 'Makefile';
const TIDB_UT_BINARY_SOURCE = 'tools/check/ut.go';
const TIDB_INTEGRATION_SCRIPT = 'tests/integrationtest/run-tests.sh';

const TIDB_SKILL_CANDIDATES = [
  '.agents/skills/tidb-test-guidelines/SKILL.md',
  '.agent/skills/pingcap-tidb-tidb-test-guidelines/SKILL.md',
];

export interface ResolvedCoverageCommands {
  unitCommands: string[];
  e2eCommands: string[];
  skillCommandsExtracted: number;
  profileGlobs: string[];
  discoveryNotes: string[];
}

/**
 * Resolves UT/E2E coverage commands for the target repository.
 *
 * For TiDB, this prefers Makefile-native entry points discovered from repo files,
 * so users do not need to manually fill commands in config.
 */
export async function resolveCoverageCommands(
  repoPath: string,
  coverageConfig: PlatformConfig['coverage'],
): Promise<ResolvedCoverageCommands> {
  const runUnit = coverageConfig.runUnit !== false;
  const runE2E = coverageConfig.runE2E !== false;

  const unitCommands = [
    ...(coverageConfig.commands ?? []),
    ...(coverageConfig.unitCommands ?? []),
  ];
  const e2eCommands = [...(coverageConfig.e2eCommands ?? [])];

  const discoveryNotes: string[] = [];
  let skillCommandsExtracted = 0;
  const profileGlobs = [...coverageConfig.profileGlobs];

  if (coverageConfig.autoDetectTidbCommands !== false) {
    const discovered = await discoverTiDBCoverageCommands(repoPath, coverageConfig, {
      runUnit,
      runE2E,
    });
    if (discovered) {
      unitCommands.push(...discovered.unitCommands);
      e2eCommands.push(...discovered.e2eCommands);
      profileGlobs.push(...discovered.profileGlobs);
      discoveryNotes.push(...discovered.discoveryNotes);
      skillCommandsExtracted += discovered.skillCommandsExtracted;
    }
  }

  const finalUnitCommands = runUnit ? dedupe(unitCommands) : [];
  const finalE2ECommands = runE2E ? dedupe(e2eCommands) : [];

  if (runUnit && finalUnitCommands.length === 0) {
    throw new Error('No unit coverage command resolved. Check Makefile discovery or set coverage.unitCommands.');
  }

  if (runE2E && finalE2ECommands.length === 0) {
    throw new Error('No E2E coverage command resolved. Check Makefile discovery or set coverage.e2eCommands.');
  }

  return {
    unitCommands: finalUnitCommands,
    e2eCommands: finalE2ECommands,
    skillCommandsExtracted,
    profileGlobs: dedupe(profileGlobs),
    discoveryNotes,
  };
}

async function discoverTiDBCoverageCommands(
  repoPath: string,
  coverageConfig: PlatformConfig['coverage'],
  options: { runUnit: boolean; runE2E: boolean },
): Promise<ResolvedCoverageCommands | null> {
  const makefilePath = path.resolve(repoPath, TIDB_MAKEFILE);
  const hasMakefile = await pathExists(makefilePath);
  if (!hasMakefile) {
    return null;
  }

  const makefile = await readFile(makefilePath, 'utf8');
  const unitCommands: string[] = [];
  const e2eCommands: string[] = [];
  const profileGlobs = ['.totalcover/*.out', 'coverage.dat'];
  const discoveryNotes: string[] = [];
  let skillCommandsExtracted = 0;

  const utMaxProcs = resolveUTMaxProcs(coverageConfig.utMaxProcs);
  const scopePackage = coverageConfig.scopePackage?.trim();
  const scopeRunner = coverageConfig.scopeRunner ?? 'ut';

  if (options.runUnit) {
    if (
      scopePackage &&
      scopeRunner === 'go-test'
    ) {
      unitCommands.push(
        [
          'mkdir -p .totalcover',
          `go test ./${scopePackage}/... -count=1 -tags=intest,deadlock -covermode=atomic -coverprofile=.totalcover/tidb_cov.${sanitizeName(scopePackage)}.unit_test.out`,
        ].join(' && '),
      );
      discoveryNotes.push(`Discovered TiDB scoped go test command for package ${scopePackage}.`);
    } else if (
      scopePackage &&
      scopeRunner === 'ut' &&
      hasMakeTarget(makefile, 'tools/bin/ut') &&
      (await pathExists(path.resolve(repoPath, TIDB_UT_BINARY_SOURCE)))
    ) {
      unitCommands.push(
        [
          'mkdir -p .totalcover',
          'make tools/bin/ut tools/bin/xprog failpoint-enable',
          `(GOMAXPROCS=${utMaxProcs} tools/bin/ut run ${quoteShellArg(scopePackage)} --coverprofile .totalcover/tidb_cov.${sanitizeName(scopePackage)}.unit_test.out; status=$?; make failpoint-disable; exit $status)`,
        ].join(' && '),
      );
      discoveryNotes.push(`Discovered TiDB scoped UT command for package ${scopePackage}.`);
    } else if (hasMakeTarget(makefile, 'gotest_in_verify_ci')) {
      unitCommands.push(
        `mkdir -p .totalcover && GOMAXPROCS=${utMaxProcs} TEST_COVERAGE_DIR=.totalcover make gotest_in_verify_ci`,
      );
      discoveryNotes.push('Discovered TiDB UT command from Makefile target gotest_in_verify_ci.');
    } else if (
      hasMakeTarget(makefile, 'ut') &&
      (await pathExists(path.resolve(repoPath, TIDB_UT_BINARY_SOURCE)))
    ) {
      unitCommands.push(
        [
          'mkdir -p .totalcover',
          'make tools/bin/ut tools/bin/xprog failpoint-enable',
          `(GOMAXPROCS=${utMaxProcs} tools/bin/ut --coverprofile .totalcover/tidb_cov.unit_test.out --except unstable.txt; status=$?; make failpoint-disable; exit $status)`,
        ].join(' && '),
      );
      discoveryNotes.push('Discovered TiDB UT fallback flow from tools/check/ut.go and Makefile ut target.');
    }
  }

  if (options.runE2E) {
    if (
      hasMakeTarget(makefile, 'integrationtest') &&
      (await pathExists(path.resolve(repoPath, TIDB_INTEGRATION_SCRIPT)))
    ) {
      e2eCommands.push(
        'mkdir -p .totalcover && TEST_COVERAGE_DIR=.totalcover make integrationtest && cp coverage.dat .totalcover/tidb_cov.integration_test.out',
      );
      discoveryNotes.push('Discovered TiDB E2E command from Makefile target integrationtest.');
    } else {
      const hasSkillIntegrationHint = await hasSkillIntegrationCommandHint(repoPath);
      if (hasSkillIntegrationHint) {
        e2eCommands.push(
          [
            'mkdir -p .totalcover',
            'make server_check',
            '(cd tests/integrationtest && GOCOVERDIR=../../.totalcover ./run-tests.sh -s ../../bin/tidb-server)',
            'go tool covdata textfmt -i=.totalcover -o=.totalcover/tidb_cov.integration_test.out',
          ].join(' && '),
        );
        discoveryNotes.push('Discovered TiDB E2E fallback flow from skill/AGENTS integration hints.');
        skillCommandsExtracted += 1;
      }
    }
  }

  if (unitCommands.length === 0 && e2eCommands.length === 0) {
    return null;
  }

  return {
    unitCommands: dedupe(unitCommands),
    e2eCommands: dedupe(e2eCommands),
    skillCommandsExtracted,
    profileGlobs,
    discoveryNotes,
  };
}

function hasMakeTarget(makefile: string, target: string): boolean {
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}:`, 'm').test(makefile);
}

async function hasSkillIntegrationCommandHint(repoPath: string): Promise<boolean> {
  const candidates = [
    ...TIDB_SKILL_CANDIDATES,
    'AGENTS.md',
    'docs/agents/testing-flow.md',
  ];

  for (const rel of candidates) {
    const abs = path.resolve(repoPath, rel);
    if (!(await pathExists(abs))) {
      continue;
    }
    const text = await readFile(abs, 'utf8');
    if (text.includes('tests/integrationtest') && text.includes('run-tests.sh')) {
      return true;
    }
  }

  return false;
}

function resolveUTMaxProcs(configured?: number): number {
  if (configured && Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured);
  }

  const cpu = os.availableParallelism();
  // UT is expensive in TiDB. Default to half cores with a minimum of 2.
  return Math.max(2, Math.floor(cpu / 2));
}

function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function sanitizeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, '_');
}

function dedupe(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}
