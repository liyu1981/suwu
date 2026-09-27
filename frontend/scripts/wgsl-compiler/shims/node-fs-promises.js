// `node:fs/promises` shim — see node-fs.js for why it is unreachable.

function unavailable(name) {
  return () => {
    throw new Error(
      `node:${name} is not available in suwu's embedded WGSL compiler; ` +
        'pass files through the in-memory module map',
    );
  };
}

export const readFile = unavailable('fs/promises.readFile');
export const open = unavailable('fs/promises.open');
export const writeFile = unavailable('fs/promises.writeFile');
