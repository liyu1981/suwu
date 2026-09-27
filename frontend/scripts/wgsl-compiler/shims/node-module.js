// `node:module` shim: `createRequire` backs the resolver's package-alongside
// fallback (`@vgpu/*` from the resolver's own install location), which the
// embedded compiler never reaches — package imports are answered by the
// `packageMap` + in-memory module map instead.

export function createRequire() {
  return () => {
    throw new Error(
      'createRequire is not available in suwu\'s embedded WGSL compiler; ' +
        'map package imports through packageMap',
    );
  };
}
