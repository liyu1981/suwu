// Package wgsl compiles WGSL shader graphs into ShaderSource modules
// (`export default { version: 1, wgsl, functionExports };`) for background
// .shader.js artifacts.
//
// The compiler is @vgpu/wgsl's resolveShader, bundled to a single script by
// frontend/scripts/wgsl-compiler/ and executed on the QuickJS runtime the
// binary already ships (pkg/gqjs) — no Node, no vgpu toolchain, no network.
// Every input file travels in the request's in-memory module map, so the
// resolver never touches a filesystem and the bundle's Node shims stay unused.
package wgsl

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"

	"suwu/pkg/gqjs"
)

// resolver.js: @vgpu/wgsl's resolver + QuickJS shims, one plain script.
//
//go:embed resolver.js
var resolverBundle string

// wgsl-stdlib.json: @vgpu/wgsl-std sources keyed "/vgpu-wgsl-std/<path>".
//
//go:embed wgsl-stdlib.json
var stdlibJSON []byte

// Bounds for one resolution. The bundle (~78 KiB) parses per call; big graphs
// are still comfortably inside these.
const (
	compileTimeout    = 30 * time.Second
	compileMemoryByte = 256 << 20
)

// packageMap answers bare `@vgpu/wgsl-std/...` specifiers from the embedded
// stdlib merged into every module map.
var packageMap = map[string]string{"@vgpu/wgsl-std/": "/vgpu-wgsl-std/"}

// Diagnostic is one resolver message; Line/Column are 0 when not positioned.
type Diagnostic struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Line    int    `json:"line,omitempty"`
	Column  int    `json:"column,omitempty"`
	File    string `json:"file,omitempty"`
}

func (d Diagnostic) String() string {
	var sb strings.Builder
	if d.File != "" {
		sb.WriteString(d.File)
		if d.Line > 0 {
			fmt.Fprintf(&sb, ":%d:%d", d.Line, d.Column)
		}
		sb.WriteString(": ")
	}
	if d.Code != "" {
		sb.WriteString(d.Code)
		sb.WriteString(": ")
	}
	sb.WriteString(d.Message)
	return sb.String()
}

// Result is a successful compilation: the module text the background imports.
type Result struct {
	Module string
	// Warnings are non-fatal diagnostics (e.g. conditional package exports).
	Warnings []Diagnostic
}

// Error reports compilation failures as the resolver's diagnostics.
type Error struct {
	Errors []Diagnostic
}

func (e *Error) Error() string {
	lines := make([]string, 0, len(e.Errors))
	for _, d := range e.Errors {
		lines = append(lines, d.String())
	}
	return strings.Join(lines, "\n")
}

type request struct {
	Entry      string            `json:"entry"`
	Modules    map[string]string `json:"modules"`
	PackageMap map[string]string `json:"packageMap"`
}

type response struct {
	OK       bool         `json:"ok"`
	Module   string       `json:"module"`
	Errors   []Diagnostic `json:"errors"`
	Warnings []Diagnostic `json:"warnings"`
}

// stdlib is the embedded @vgpu/wgsl-std module map, parsed once.
var stdlib = sync.OnceValue(func() map[string]string {
	m := make(map[string]string)
	if err := json.Unmarshal(stdlibJSON, &m); err != nil {
		panic("wgsl: embedded stdlib is invalid: " + err.Error())
	}
	return m
})

// Compile resolves the WGSL import graph rooted at entry and returns the
// ShaderSource module text. files maps slash-separated paths relative to the
// background root to their contents; the embedded stdlib is merged in
// automatically. Callers pass every .wgsl under the root — the resolver picks
// the graph it needs.
func Compile(ctx context.Context, entry string, files map[string]string) (Result, error) {
	if entry == "" {
		return Result{}, &Error{Errors: []Diagnostic{{Code: "WGSL-INPUT", Message: "empty entry"}}}
	}
	modules := make(map[string]string, len(files)+len(stdlib()))
	for k, v := range stdlib() {
		modules[k] = v
	}
	for k, v := range files {
		modules[k] = v
	}

	payload, err := json.Marshal(request{Entry: entry, Modules: modules, PackageMap: packageMap})
	if err != nil {
		return Result{}, fmt.Errorf("wgsl: encode request: %w", err)
	}

	runner := gqjs.New()
	res, err := runner.Run(ctx, resolverBundle, gqjs.Env{
		InputJSON:      payload,
		Timeout:        compileTimeout,
		MemoryLimit:    compileMemoryByte,
		MaxOutputBytes: 4 << 20,
	})
	if err != nil {
		return Result{}, fmt.Errorf("wgsl: resolver failed: %w", err)
	}

	var out response
	if err := json.Unmarshal([]byte(res.JSON), &out); err != nil {
		return Result{}, fmt.Errorf("wgsl: unexpected resolver result: %w", err)
	}
	if !out.OK {
		errs := out.Errors
		if len(errs) == 0 {
			errs = []Diagnostic{{Code: "WGSL-RESOLVE", Message: "resolver returned no module and no diagnostics"}}
		}
		return Result{}, &Error{Errors: errs}
	}
	if out.Module == "" {
		return Result{}, &Error{Errors: []Diagnostic{{Code: "WGSL-RESOLVE", Message: "resolver returned an empty module"}}}
	}
	return Result{Module: out.Module, Warnings: out.Warnings}, nil
}
