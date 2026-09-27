package wgsl

import (
	"context"
	"strings"
	"testing"
)

// The test graph exercises every resolver path the compiler supports: a
// relative import, a bare @vgpu/wgsl-std import (embedded packageMap), and an
// entry that declares bindings (module purity skips only the entry).
const entryWGSL = `import { scale } from "./helper.wgsl";
import { hashU32 } from "@vgpu/wgsl-std/hash";

struct Params {
  value: f32,
}

@group(0) @binding(0) var<uniform> params: Params;

@fragment
fn main() -> @location(0) vec4f {
  let h = hashU32(1u);
  let s = scale(params.value);
  return vec4f(s, f32(h & 1u), 0.0, 1.0);
}
`

const helperWGSL = `export fn scale(v: f32) -> f32 {
  return v * 2.0;
}
`

func TestCompileRelativeAndStdlibGraph(t *testing.T) {
	t.Parallel()
	res, err := Compile(context.Background(), "shaders/entry.wgsl", map[string]string{
		"shaders/entry.wgsl":  entryWGSL,
		"shaders/helper.wgsl": helperWGSL,
	})
	if err != nil {
		t.Fatalf("Compile: %v", err)
	}
	if !strings.HasPrefix(res.Module, "export default { version: 1, wgsl: ") {
		t.Fatalf("module has an unexpected shape: %.120s", res.Module)
	}
	if !strings.HasSuffix(res.Module, "};") {
		t.Errorf("module does not end with the expected object literal")
	}
	// The inlined graph must not leak import statements, and the binding the
	// frontend's set() reflects by name must survive emission.
	if strings.Contains(res.Module, "import {") {
		t.Errorf("module still contains a WGSL import")
	}
	if !strings.Contains(res.Module, "var<uniform> params") {
		t.Errorf("binding name params was mangled away:\n%.400s", res.Module)
	}
	if !strings.Contains(res.Module, "struct ") || !strings.Contains(res.Module, "value: f32") {
		t.Errorf("struct fields did not survive emission:\n%.400s", res.Module)
	}
}

func TestCompileMissingModule(t *testing.T) {
	t.Parallel()
	_, err := Compile(context.Background(), "entry.wgsl", map[string]string{
		"entry.wgsl": `import { gone } from "./nope.wgsl";
@fragment
fn main() -> @location(0) vec4f { return vec4f(gone); }
`,
	})
	if err == nil {
		t.Fatal("expected an error for a missing import")
	}
	compErr := &Error{}
	if !asCompileError(err, &compErr) {
		t.Fatalf("expected *Error, got %T: %v", err, err)
	}
	if len(compErr.Errors) == 0 {
		t.Fatalf("error carried no diagnostics: %v", err)
	}
	if got := compErr.Error(); !strings.Contains(got, "nope.wgsl") {
		t.Errorf("diagnostics should mention the missing module, got:\n%s", got)
	}
}

// asCompileError is errors.As with the pointer type spelled out for clarity.
func asCompileError(err error, target **Error) bool {
	if e, ok := err.(*Error); ok {
		*target = e
		return true
	}
	return false
}
