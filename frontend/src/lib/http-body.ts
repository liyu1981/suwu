/** Helpers for turning the base64 response envelope into usable text/blobs. */

const BINARY_HINT = /image|audio|video|zip|pdf|octet-stream|font|protobuf|wasm/i;

export function decodeBase64ToBytes(b64: string): Uint8Array {
  if (!b64) return new Uint8Array(0);
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function decodeBase64ToText(b64: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(decodeBase64ToBytes(b64));
  } catch {
    return '';
  }
}

/** Case-insensitive first-value lookup for a header map. */
function headerValue(headers: Record<string, string[]>, name: string): string {
  const lower = name.toLowerCase();
  for (const [key, values] of Object.entries(headers)) {
    if (key.toLowerCase() === lower && values.length > 0) return values[0];
  }
  return '';
}

export function contentTypeOf(headers: Record<string, string[]>): string {
  return headerValue(headers, 'content-type');
}

export function isJsonContentType(contentType: string): boolean {
  return /json/i.test(contentType);
}

export function isBinaryContentType(contentType: string): boolean {
  return BINARY_HINT.test(contentType) && !contentType.includes('svg');
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
