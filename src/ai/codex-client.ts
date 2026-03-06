import { Codex, type Thread, type ThreadOptions } from '@openai/codex-sdk';

import { parsePossiblyFencedJson } from '../utils/json.js';

/**
 * Lightweight wrapper around Codex SDK.
 *
 * We open a fresh thread per request to avoid cross-task context leakage
 * between scoring and generation jobs.
 */
export class CodexClient {
  private readonly codex: Codex;
  private readonly threadOptions: ThreadOptions;

  constructor(
    private readonly model: string,
    private readonly cwd: string,
  ) {
    this.codex = new Codex();
    this.threadOptions = {
      model: this.model,
      workingDirectory: this.cwd,
      modelReasoningEffort: 'xhigh',
    };
  }

  createThread(threadId?: string): Thread {
    if (threadId) {
      try {
        return this.codex.resumeThread(threadId, this.threadOptions);
      } catch (error) {
        console.warn(`[codex] failed to resume thread ${threadId}, starting new thread: ${error}`);
      }
    }
    return this.codex.startThread(this.threadOptions);
  }

  async textCompletion(systemPrompt: string, userPrompt: string): Promise<string> {
    const thread = this.codex.startThread(this.threadOptions);
    const prompt = composePrompt(systemPrompt, userPrompt);
    return this.runPrompt(thread, prompt);
  }

  async jsonCompletion<T>(systemPrompt: string, userPrompt: string): Promise<T> {
    const text = await this.textCompletion(systemPrompt, userPrompt);
    return parsePossiblyFencedJson<T>(text);
  }

  async textCompletionInThread(
    thread: Thread,
    systemPrompt: string,
    userPrompt: string,
  ): Promise<string> {
    const prompt = composePrompt(systemPrompt, userPrompt);
    return this.runPrompt(thread, prompt);
  }

  async jsonCompletionInThread<T>(
    thread: Thread,
    systemPrompt: string,
    userPrompt: string,
  ): Promise<T> {
    const text = await this.textCompletionInThread(thread, systemPrompt, userPrompt);
    return parsePossiblyFencedJson<T>(text);
  }

  private async runPrompt(thread: Thread, prompt: string): Promise<string> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await thread.run(prompt);
        const text = extractText(response).trim();
        if (!text) {
          throw new Error('Codex SDK returned empty output');
        }
        return text;
      } catch (error) {
        lastError = error;
        if (!isRetryableCodexError(error) || attempt === 3) {
          throw error;
        }
        await sleep(attempt * 1000);
      }
    }

    throw lastError;
  }
}

function extractText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (!value || typeof value !== 'object') {
    return '';
  }

  const record = value as Record<string, unknown>;
  const directCandidates = [
    record.output_text,
    record.outputText,
    record.finalResponse,
    record.text,
    record.finalOutput,
    record.message,
  ];

  for (const candidate of directCandidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate;
    }
  }

  const nested = collectStrings(record);
  if (nested.length > 0) {
    return nested.join('\n');
  }

  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function collectStrings(value: unknown): string[] {
  if (typeof value === 'string') {
    return value.trim() ? [value] : [];
  }
  if (!value || typeof value !== 'object') {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectStrings(item));
  }

  const record = value as Record<string, unknown>;
  const candidates = [record.content, record.messages, record.output, record.result];
  return candidates.flatMap((item) => collectStrings(item));
}

function isRetryableCodexError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /stream disconnected/i.test(message) ||
    /timed out/i.test(message) ||
    /ECONNRESET/i.test(message) ||
    /ENOTFOUND/i.test(message) ||
    /EAI_AGAIN/i.test(message) ||
    /5\d\d/.test(message)
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function composePrompt(systemPrompt: string, userPrompt: string): string {
  return [
    'Follow the system instruction and then answer the user request.',
    '',
    '[System Instruction]',
    systemPrompt,
    '',
    '[User Request]',
    userPrompt,
  ].join('\n');
}
