import { atom } from 'jotai';
import { atomWithStorage } from 'jotai/utils';

/** REST Helper types, defaults, and in-memory atoms. Persistence lives in
 * `lib/restdb.ts` (history/collections/cookies) and the tile session state
 * (current draft). The backend is stateless. */

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export type BodyType = 'none' | 'json' | 'raw' | 'form-data' | 'urlencoded';
export const BODY_TYPES: BodyType[] = ['none', 'json', 'raw', 'form-data', 'urlencoded'];

export type UserAgentMode = 'default' | 'browser' | 'custom';

export interface RestHeader {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
  /** Marks credentials so they can be redacted on export. */
  sensitive?: boolean;
}

export interface RestParam {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
}

export interface RestFormEntry {
  id: string;
  key: string;
  value: string;
  type: 'text' | 'file';
  filename?: string;
  contentB64?: string;
  contentType?: string;
  enabled: boolean;
}

export interface RestRequestDraft {
  method: HttpMethod;
  url: string;
  headers: RestHeader[];
  params: RestParam[];
  bodyType: BodyType;
  body: string;
  formData: RestFormEntry[];
}

/** Wire payload sent to POST /api/rest/request. */
export interface RestSendPayload {
  method: string;
  url: string;
  headers: Array<{ key: string; value: string; enabled: boolean }>;
  bodyType: BodyType;
  body: string;
  formData: Array<{
    key: string;
    value: string;
    type: 'text' | 'file';
    filename?: string;
    contentB64?: string;
    contentType?: string;
    enabled: boolean;
  }>;
  userAgentMode: UserAgentMode;
  browserUserAgent: string;
  customUserAgent: string;
  timeoutMs: number;
  followRedirects: boolean;
  insecureTLS: boolean;
  maxResponseBytes: number;
}

export interface RestResponseData {
  status: number;
  statusText: string;
  headers: Record<string, string[]>;
  bodyB64: string;
  bodySize: number;
  truncated: boolean;
  durationMs: number;
  finalUrl: string;
  redirects: string[];
  insecureTLS: boolean;
  error?: string;
  errorKind?: string;
  /** Set when a stored response's body was too large to keep in IndexedDB. */
  bodyOmitted?: boolean;
}

export interface RestResponseState {
  loading: boolean;
  response: RestResponseData | null;
  request: RestSendPayload | null;
  sentAt: number;
}

export interface RestHistoryEntry {
  id: string;
  method: string;
  url: string;
  status: number;
  durationMs: number;
  timestamp: number;
  request: RestRequestDraft;
}

/** A response snapshot persisted in IndexedDB, keyed by its history entry id. */
export interface RestStoredResponse {
  id: string;
  timestamp: number;
  response: RestResponseData;
}

export interface SavedRequest {
  id: string;
  name: string;
  request: RestRequestDraft;
  createdAt: number;
  updatedAt: number;
}

export interface RestCollection {
  id: string;
  name: string;
  requests: SavedRequest[];
  createdAt: number;
}

export interface RestOptions {
  userAgentMode: UserAgentMode;
  customUserAgent: string;
  timeoutMs: number;
  followRedirects: boolean;
  insecureTLS: boolean;
  /** Attach jar cookies to matching requests. */
  useCookieJar: boolean;
  /** Update the jar from Set-Cookie response headers. */
  captureCookies: boolean;
}

let idCounter = 0;
export function newId(prefix = 'r'): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

export function emptyHeader(partial: Partial<RestHeader> = {}): RestHeader {
  return { id: newId('h'), key: '', value: '', enabled: true, ...partial };
}

export function emptyParam(partial: Partial<RestParam> = {}): RestParam {
  return { id: newId('p'), key: '', value: '', enabled: true, ...partial };
}

export function emptyFormEntry(partial: Partial<RestFormEntry> = {}): RestFormEntry {
  return { id: newId('f'), key: '', value: '', type: 'text', enabled: true, ...partial };
}

export function defaultDraft(): RestRequestDraft {
  return {
    method: 'GET',
    url: '',
    headers: [emptyHeader()],
    params: [],
    bodyType: 'none',
    body: '',
    formData: [],
  };
}

export const DEFAULT_OPTIONS: RestOptions = {
  userAgentMode: 'default',
  customUserAgent: '',
  timeoutMs: 30000,
  followRedirects: true,
  insecureTLS: false,
  useCookieJar: true,
  captureCookies: true,
};

/** Current request draft. Hydrated from tile session state by the panel. */
export const restDraftAtom = atom<RestRequestDraft>(defaultDraft());

/** Persisted request options. */
export const restOptionsAtom = atomWithStorage<RestOptions>('suwu:rest-options', DEFAULT_OPTIONS);

/** Response state for the request currently shown. */
export const restResponseAtom = atom<RestResponseState>({
  loading: false,
  response: null,
  request: null,
  sentAt: 0,
});

export const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

/** Stored responses larger than this keep status/headers but drop the body. */
export const MAX_STORED_BODY_BYTES = 2 * 1024 * 1024;

/** Build the backend payload from a draft, options, and the browser UA. */
export function toSendPayload(
  draft: RestRequestDraft,
  options: RestOptions,
  browserUserAgent: string,
  cookieHeader: string,
): RestSendPayload {
  const headers = draft.headers
    .filter((header) => header.enabled && header.key.trim())
    .map((header) => ({ key: header.key, value: header.value, enabled: true }));

  // The jar provides a Cookie header only when the user did not set one.
  if (cookieHeader && !headers.some((header) => header.key.toLowerCase() === 'cookie')) {
    headers.push({ key: 'Cookie', value: cookieHeader, enabled: true });
  }

  return {
    method: draft.method,
    url: draft.url,
    headers,
    bodyType: draft.bodyType,
    body: draft.body,
    formData: draft.formData
      .filter((entry) => entry.enabled && entry.key.trim())
      .map((entry) => ({
        key: entry.key,
        value: entry.value,
        type: entry.type,
        filename: entry.filename,
        contentB64: entry.contentB64,
        contentType: entry.contentType,
        enabled: true,
      })),
    userAgentMode: options.userAgentMode,
    browserUserAgent,
    customUserAgent: options.customUserAgent,
    timeoutMs: options.timeoutMs,
    followRedirects: options.followRedirects,
    insecureTLS: options.insecureTLS,
    maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
  };
}
