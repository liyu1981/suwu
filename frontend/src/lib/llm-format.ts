/**
 * LLM-optimized markdown for an HTTP request/response pair.
 *
 * Ported from inspect-http-proxy's `generateLLMMarkdown`
 * (`frontend/src/lib/llm-data-gen-util.ts`): a token-efficient, structured
 * representation with fenced bodies, binary placeholders, and a size cap.
 */

import {
  contentTypeOf,
  decodeBase64ToText,
  formatBytes,
  isBinaryContentType,
  isJsonContentType,
} from './http-body';
import type { RestResponseData, RestSendPayload } from '../store/resthelper';

const MAX_BODY_CHARS = 10 * 1024;

function prettifyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function fence(contentType: string, body: string): string {
  if (isBinaryContentType(contentType)) return `[Binary Data: ${formatBytes(body.length)}]`;
  let processed = body;
  if (processed.length > MAX_BODY_CHARS) {
    processed = `${processed.slice(0, MAX_BODY_CHARS)}\n\n... [Body truncated due to size]`;
  }
  if (isJsonContentType(contentType)) return `\`\`\`json\n${prettifyJson(processed)}\n\`\`\``;
  if (/xml|html/i.test(contentType)) return `\`\`\`xml\n${processed}\n\`\`\``;
  return `\`\`\`text\n${processed}\n\`\`\``;
}

function headersBlock(
  headers: Record<string, string[]> | Array<{ key: string; value: string }>,
): string {
  const lines: string[] = [];
  if (Array.isArray(headers)) {
    for (const header of headers) {
      if (header.key.trim()) lines.push(`${header.key}: ${header.value}`);
    }
  } else {
    for (const [key, values] of Object.entries(headers)) {
      if (values.length > 0) lines.push(`${key}: ${values.join(', ')}`);
    }
  }
  if (lines.length === 0) return '_No headers_';
  return `\`\`\`http\n${lines.join('\n')}\n\`\`\``;
}

function requestBodyBlock(request: RestSendPayload): string {
  switch (request.bodyType) {
    case 'none':
      return '_No body_';
    case 'form-data':
    case 'urlencoded': {
      const lines = request.formData.map((entry) =>
        entry.type === 'file'
          ? `${entry.key}: [file ${entry.filename ?? ''}]`
          : `${entry.key}: ${entry.value}`,
      );
      return `\`\`\`text\n${lines.join('\n') || '(empty)'}\n\`\`\``;
    }
    default:
      return fence(
        request.headers.find((header) => header.key.toLowerCase() === 'content-type')?.value ||
          (request.bodyType === 'json' ? 'application/json' : 'text/plain'),
        request.body,
      );
  }
}

export function generateLLMMarkdown(
  request: RestSendPayload,
  response: RestResponseData | null,
): string {
  const lines: string[] = ['# HTTP Request', ''];
  lines.push(`- **Method:** ${request.method}`);
  lines.push(`- **URL:** ${request.url}`);
  if (response?.finalUrl && response.finalUrl !== request.url) {
    lines.push(`- **Final URL:** ${response.finalUrl}`);
  }
  if (response) {
    lines.push(
      `- **Status:** ${response.status === 0 ? 'ERROR' : `${response.status} ${response.statusText}`.trim()}`,
    );
    lines.push(`- **Duration:** ${response.durationMs} ms`);
    lines.push(
      `- **Size:** ${formatBytes(response.bodySize)}${response.truncated ? ' (truncated)' : ''}`,
    );
    if (response.insecureTLS) lines.push('- **TLS verification:** disabled');
    if ((response.redirects ?? []).length > 0) {
      lines.push(`- **Redirects:** ${response.redirects.join(' → ')}`);
    }
  }

  lines.push('', '## Request Headers', headersBlock(request.headers));
  lines.push('', `## Request Body (${request.bodyType})`, requestBodyBlock(request));

  if (response) {
    lines.push('', '## Response Headers', headersBlock(response.headers));
    if (response.error) {
      lines.push(
        '',
        `## Error (${response.errorKind ?? 'other'})`,
        `\`\`\`text\n${response.error}\n\`\`\``,
      );
    } else {
      const contentType = contentTypeOf(response.headers) || 'text/plain';
      const body = decodeBase64ToText(response.bodyB64);
      lines.push('', `## Response Body (${contentType})`, fence(contentType, body));
    }
  }

  lines.push('');
  return lines.join('\n');
}
