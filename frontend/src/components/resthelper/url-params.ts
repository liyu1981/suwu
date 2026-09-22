import { emptyParam, type RestParam } from '../../store/resthelper';

/** Parse enabled query parameters out of a URL (best effort). */
export function parseParamsFromUrl(url: string): RestParam[] {
  const queryIndex = url.indexOf('?');
  if (queryIndex < 0) return [];
  const query = url.slice(queryIndex + 1).split('#')[0];
  const params = new URLSearchParams(query);
  const rows: RestParam[] = [];
  for (const [key, value] of params.entries()) {
    rows.push(emptyParam({ key, value }));
  }
  return rows;
}

/** Rewrite a URL's query string from a parameter table. */
export function mergeParamsIntoUrl(url: string, params: RestParam[]): string {
  const hashIndex = url.indexOf('#');
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : '';
  const withoutHash = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const queryIndex = withoutHash.indexOf('?');
  const base = queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash;

  const search = new URLSearchParams();
  for (const param of params) {
    if (param.enabled && param.key.trim()) search.append(param.key, param.value);
  }
  const query = search.toString();
  return `${base}${query ? `?${query}` : ''}${hash}`;
}
