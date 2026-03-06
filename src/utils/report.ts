import { access, mkdir, rename, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';

export async function writeJsonFile(filePath: string, content: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  await writeFile(tmpPath, JSON.stringify(content, null, 2), 'utf8');
  await rename(tmpPath, filePath);
}

export async function readJsonFileIfExists<T>(filePath: string): Promise<T | undefined> {
  if (!(await pathExists(filePath))) {
    return undefined;
  }
  const raw = await readFile(filePath, 'utf8');
  return JSON.parse(raw) as T;
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
