/**
 * Codex may wrap JSON in markdown fences. This helper extracts the first JSON object/array.
 */
export function parsePossiblyFencedJson<T>(text: string): T {
  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fencedMatch?.[1]?.trim() ?? text.trim();

  try {
    return JSON.parse(candidate) as T;
  } catch {
    const start = candidate.search(/[\[{]/);
    if (start >= 0) {
      const sliced = candidate.slice(start);
      return JSON.parse(sliced) as T;
    }
    throw new Error(`Failed to parse JSON response: ${text}`);
  }
}
