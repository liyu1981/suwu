// POSIX path shim for the embedded WGSL compiler (QuickJS has no `node:path`).
// Implements only the functions the resolver uses, with Node's semantics.

export const sep = '/';

export function normalize(p) {
  if (p === '') return '.';
  const absolute = p.startsWith('/');
  const trailing = p.length > 1 && p.endsWith('/');
  const parts = p.split('/');
  const out = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (!absolute) out.push('..');
      continue;
    }
    out.push(part);
  }
  let res = out.join('/');
  if (res === '') res = absolute ? '/' : '.';
  if (absolute) res = `/${res.replace(/^\/+/, '')}`;
  if (trailing && res !== '/') res += '/';
  return res;
}

export function join(...parts) {
  const filtered = parts.filter((p) => p !== undefined && p !== null && p !== '');
  if (filtered.length === 0) return '.';
  return normalize(filtered.join('/'));
}

export function dirname(p) {
  if (p === '') return '.';
  const norm = p;
  if (norm === '/') return '/';
  const idx = norm.lastIndexOf('/');
  if (idx === -1) return '.';
  if (idx === 0) return '/';
  const seg = norm.slice(0, idx);
  return seg === '' ? '.' : seg;
}

export function basename(p, ext) {
  let base = p.replace(/\/+$/, '');
  const idx = base.lastIndexOf('/');
  if (idx !== -1) base = base.slice(idx + 1);
  if (ext && base.endsWith(ext) && base !== ext) base = base.slice(0, -ext.length);
  return base;
}

export function extname(p) {
  const base = basename(p);
  const idx = base.lastIndexOf('.');
  if (idx <= 0) return '';
  return base.slice(idx);
}

export function isAbsolute(p) {
  return typeof p === 'string' && p.startsWith('/');
}

export function relative(from, to) {
  const fromParts = normalize(from).split('/').filter(Boolean);
  const toParts = normalize(to).split('/').filter(Boolean);
  let i = 0;
  while (i < fromParts.length && i < toParts.length && fromParts[i] === toParts[i]) i++;
  const up = new Array(fromParts.length - i).fill('..');
  return [...up, ...toParts.slice(i)].join('/');
}

// The resolver only calls resolve() on the unreachable non-modules path (we
// always pass an in-memory module map); resolving against "/" is enough to
// keep the import valid if that ever changes.
export function resolve(...parts) {
  let result = '';
  for (const part of parts.reverse()) {
    if (part === undefined || part === null || part === '') continue;
    result = result === '' ? part : join(part, result);
    if (isAbsolute(result)) break;
  }
  if (result === '') return '/';
  return isAbsolute(result) ? normalize(result) : normalize(`/${result}`);
}
