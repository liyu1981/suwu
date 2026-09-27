// Package backgrounds embeds the builtin WebGPU backgrounds shipped inside the
// binary. External examples are NOT embedded: they live in
// examples/background/webgpu and are installed into the data dir by the user
// (see examples/background/README.md).
//
// Only the manifest and entry file are required for pkg/background to resolve
// a builtin; the whole directory (shaders + .shader.js artifacts) is embedded
// so the static route serves it exactly like a data-dir copy. A background
// copied into <dataDir>/background/webgpu overrides the builtin of the same id.
package backgrounds

import "embed"

//go:embed webgpu/seascape
var Builtin embed.FS
