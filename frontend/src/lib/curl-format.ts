/**
 * cURL command generation from a REST Helper request. Adapted from
 * inspect-http-proxy's `curl-gen-util.ts`.
 */

import type { RestSendPayload } from '../store/resthelper';

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function generateCurlCommand(request: RestSendPayload): string {
  const parts: string[] = ['curl'];

  if (request.method && request.method.toUpperCase() !== 'GET') {
    parts.push(`-X ${request.method.toUpperCase()}`);
  }

  for (const header of request.headers) {
    if (!header.key.trim()) continue;
    parts.push(`-H ${shellQuote(`${header.key}: ${header.value}`)}`);
  }

  switch (request.bodyType) {
    case 'json':
    case 'raw':
      if (request.body) parts.push(`--data-raw ${shellQuote(request.body)}`);
      break;
    case 'urlencoded':
      for (const entry of request.formData) {
        if (!entry.key.trim()) continue;
        parts.push(`--data-urlencode ${shellQuote(`${entry.key}=${entry.value}`)}`);
      }
      break;
    case 'form-data':
      for (const entry of request.formData) {
        if (!entry.key.trim()) continue;
        if (entry.type === 'file') {
          parts.push(`-F ${shellQuote(`${entry.key}=@${entry.filename ?? 'file'}`)}`);
        } else {
          parts.push(`-F ${shellQuote(`${entry.key}=${entry.value}`)}`);
        }
      }
      break;
    default:
      break;
  }

  parts.push(shellQuote(request.url));
  return parts.join(' \\\n  ');
}
