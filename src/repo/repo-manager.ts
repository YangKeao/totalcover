import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { execCommand } from '../utils/exec.js';

export interface RepoPrepareOptions {
  url: string;
  branch?: string;
  localPath: string;
  refresh?: boolean;
  cloneDepth?: number;
}

export async function prepareRepository(options: RepoPrepareOptions): Promise<void> {
  const gitDir = path.join(options.localPath, '.git');
  const branch = options.branch ?? 'master';

  const exists = await pathExists(gitDir);
  if (!exists) {
    await mkdir(path.dirname(options.localPath), { recursive: true });
    const depthArg = options.cloneDepth ? `--depth ${options.cloneDepth}` : '';
    const cloneCommand = `git clone ${depthArg} --branch ${quoteArg(branch)} ${quoteArg(options.url)} ${quoteArg(options.localPath)}`.trim();
    const cloneResult = await execCommand(cloneCommand);
    if (cloneResult.exitCode !== 0) {
      throw new Error(`Repository clone failed: ${cloneResult.stderr}`);
    }
    return;
  }

  if (options.refresh) {
    const fetchResult = await execCommand(`git -C ${quoteArg(options.localPath)} fetch --all --prune`);
    if (fetchResult.exitCode !== 0) {
      throw new Error(`git fetch failed: ${fetchResult.stderr}`);
    }
    const checkoutResult = await execCommand(`git -C ${quoteArg(options.localPath)} checkout ${quoteArg(branch)}`);
    if (checkoutResult.exitCode !== 0) {
      throw new Error(`git checkout failed: ${checkoutResult.stderr}`);
    }
    const pullResult = await execCommand(`git -C ${quoteArg(options.localPath)} pull --ff-only origin ${quoteArg(branch)}`);
    if (pullResult.exitCode !== 0) {
      throw new Error(`git pull failed: ${pullResult.stderr}`);
    }
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function quoteArg(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}
