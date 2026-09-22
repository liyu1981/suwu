/**
 * Parser for buffered LLM streaming responses (SSE and NDJSON).
 *
 * The backend buffers the whole response body, so a completed stream is parsed
 * client-side into individual chunks. Adapted from inspect-http-proxy's
 * openai/ollama stream renderers, generalized to handle llama.cpp native
 * `/completion` chunks and OpenAI-style `chat.completion.chunk` deltas.
 */

export interface StreamChunk {
  /** The raw JSON object text for this chunk. */
  raw: string;
  /** Parsed chunk JSON, shown in the detail pane. */
  json: unknown;
  /** Incremental assistant text, if any. */
  content: string;
  /** Incremental reasoning/thinking text, if any. */
  reasoning: string;
}

export interface ParsedStream {
  format: 'sse' | 'ndjson' | null;
  chunks: StreamChunk[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return '';
}

/** Pull the incremental content and reasoning text out of one chunk. */
export function extractChunkText(json: unknown): { content: string; reasoning: string } {
  if (!isRecord(json)) return { content: '', reasoning: '' };

  const choices = Array.isArray(json.choices) ? json.choices : [];
  const choice = isRecord(choices[0]) ? choices[0] : undefined;
  const delta = choice && isRecord(choice.delta) ? choice.delta : undefined;
  const message = choice && isRecord(choice.message) ? choice.message : undefined;
  const nestedMessage = isRecord(json.message) ? json.message : undefined;

  const content = firstString(
    delta?.content,
    choice?.text,
    message?.content,
    nestedMessage?.content,
    json.content,
    json.response,
  );
  const reasoning = firstString(
    delta?.reasoning_content,
    delta?.reasoning,
    delta?.thinking,
    json.reasoning_content,
    json.thinking,
    json.reasoning,
  );
  return { content, reasoning };
}

/** True when the content type should be treated as a stream. */
export function isStreamContentType(contentType: string): boolean {
  return /text\/event-stream|x-ndjson|ndjson|jsonl/i.test(contentType);
}

function parseRaw(raw: string, chunks: StreamChunk[]): void {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === '[DONE]' || !trimmed.startsWith('{')) return;
  try {
    const json = JSON.parse(trimmed);
    const { content, reasoning } = extractChunkText(json);
    chunks.push({ raw: trimmed, json, content, reasoning });
  } catch {
    // Not a JSON chunk (comment, event name, partial line) — skip.
  }
}

/**
 * Parse a completed stream body. Returns an empty chunk list when the body is
 * not a recognizable stream, so callers can fall back to a plain text view.
 */
export function parseStreamBody(body: string, contentType: string): ParsedStream {
  if (!body) return { format: null, chunks: [] };

  const ct = contentType.toLowerCase();
  const isNdjson = /(x-ndjson|ndjson|jsonl)/.test(ct);
  const isSse = /text\/event-stream/.test(ct);
  const lines = body.split('\n');

  if (isSse) {
    const chunks: StreamChunk[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      parseRaw(trimmed.slice(5), chunks);
    }
    return { format: chunks.length > 0 ? 'sse' : null, chunks };
  }

  if (isNdjson) {
    const chunks: StreamChunk[] = [];
    for (const line of lines) parseRaw(line, chunks);
    return { format: chunks.length > 0 ? 'ndjson' : null, chunks };
  }

  // Tolerate servers that omit the stream content type: only treat the body as
  // NDJSON when it is not JSON, not SSE, and clearly has multiple JSON-object
  // lines (this avoids misdetecting a pretty-printed JSON array as a stream).
  if (/json/i.test(ct)) return { format: null, chunks: [] };
  const jsonLines = lines.filter((line) => line.trim().startsWith('{'));
  if (jsonLines.length > 1) {
    const chunks: StreamChunk[] = [];
    for (const line of jsonLines) parseRaw(line, chunks);
    return { format: chunks.length > 0 ? 'ndjson' : null, chunks };
  }

  return { format: null, chunks: [] };
}
