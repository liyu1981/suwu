// `@vgpu/adapter-node` stub: GPU-backed validation is disabled in the embedded
// compiler (`validate: false`), so this module is never executed. Aliasing it
// keeps the bundle free of an optional native dependency.

export function createNodeAdapter() {
  throw new Error(
    'GPU validation is disabled in suwu\'s embedded WGSL compiler (validate: false)',
  );
}

export default { createNodeAdapter };
