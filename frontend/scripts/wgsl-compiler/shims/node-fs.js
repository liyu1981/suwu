// `node:fs` shim: unreachable when a `modules` map is supplied (the resolver
// validates every path against the map first). Failing loudly documents the
// contract instead of silently returning missing files.

function unavailable(name) {
  return () => {
    throw new Error(
      `node:${name} is not available in suwu's embedded WGSL compiler; ` +
        'pass files through the in-memory module map',
    );
  };
}

export const constants = {};
export const existsSync = unavailable('fs.existsSync');
export const readFileSync = unavailable('fs.readFileSync');
export const realpathSync = unavailable('fs.realpathSync');
export const statSync = unavailable('fs.statSync');
export const openSync = unavailable('fs.openSync');
export const fstatSync = unavailable('fs.fstatSync');
export const readSync = unavailable('fs.readSync');
export const closeSync = unavailable('fs.closeSync');
export const readdirSync = unavailable('fs.readdirSync');
export const writeFileSync = unavailable('fs.writeFileSync');
