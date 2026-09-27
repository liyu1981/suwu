// Entry for the embedded WGSL compiler bundle.
//
// Bundled to pkg/wgsl/resolver.js (see build.mjs) and executed inside the
// QuickJS runtime the suwu binary already ships (pkg/gqjs). The Go side calls
// it through the runner's `handler(input)` convention:
//
//   handler({ entry, modules, packageMap? })
//     -> { ok: true,  module: "export default {...};", warnings: [...] }
//     -> { ok: false, errors: [...], warnings: [...] }
//
// Filesystem access never happens: every WGSL file is supplied through the
// in-memory `modules` map, and package imports resolve through `packageMap`.
import './shims/polyfill.js';
import { resolveShader } from '@vgpu/wgsl/runtime';

const DEFAULT_PACKAGE_MAP = { '@vgpu/wgsl-std/': '/vgpu-wgsl-std/' };

function fmtDiagnostic(d) {
  return {
    code: d.code,
    message: d.message,
    line: d.line,
    column: d.column,
    file: d.range && typeof d.range.file === 'string' ? d.range.file : undefined,
  };
}

async function compile(input) {
  const entry = input && input.entry;
  const modules = input && input.modules;
  if (typeof entry !== 'string' || !modules || typeof modules !== 'object') {
    return {
      ok: false,
      errors: [{ code: 'WGSL-INPUT', message: 'expected { entry: string, modules: object }' }],
    };
  }

  let resolved;
  try {
    resolved = await resolveShader({
      entry,
      modules,
      packageMap: (input.packageMap && Object.keys(input.packageMap).length > 0
        ? input.packageMap
        : DEFAULT_PACKAGE_MAP),
      validate: false,
    });
  } catch (error) {
    return {
      ok: false,
      errors: [
        {
          code: (error && error.code) || 'WGSL-RESOLVE',
          message: String((error && error.message) || error),
          line: error && error.line,
          column: error && error.column,
        },
      ],
    };
  }

  const diagnostics = resolved.diagnostics || [];
  const warnings = diagnostics.filter((d) => d.severity !== 'error').map(fmtDiagnostic);
  const errors = diagnostics.filter((d) => d.severity === 'error').map(fmtDiagnostic);
  if (errors.length > 0) return { ok: false, errors, warnings };

  // Byte-compatible with @vgpu/wgsl's loader-shared shaderSourceModule().
  const functionExports = resolved.functionExports || [];
  const module =
    `export default { version: 1, wgsl: ${JSON.stringify(resolved.wgsl)}, ` +
    `functionExports: ${JSON.stringify(functionExports)} };`;
  return { ok: true, module, warnings };
}

globalThis.handler = (input) => compile(input);
