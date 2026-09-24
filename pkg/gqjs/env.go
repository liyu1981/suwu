package gqjs

import (
	"fmt"
	"path"
	"path/filepath"
	"strings"
	"time"
)

// Defaults applied when the corresponding Env field is zero.
const (
	DefaultTimeout        = 5 * time.Second
	DefaultMemoryLimit    = 64 << 20 // 64 MiB
	DefaultMaxStackSize   = 1 << 20  // 1 MiB
	DefaultMaxOutputBytes = 1 << 20  // 1 MiB
)

// FSConfig scopes filesystem access for a request.
//
// Roots maps a virtual (guest) directory prefix to a real host directory, e.g.
// {"/app": "/srv/app"} makes the JS path "/app/index.js" resolve to
// "/srv/app/index.js". Access outside every root is denied.
type FSConfig struct {
	Roots    map[string]string
	ReadOnly bool
}

// Env describes the environment for a single request.
type Env struct {
	// Args is exposed as process.argv (typically [script, ...args]).
	Args []string
	// Vars is exposed as process.env.
	Vars map[string]string
	// CWD is the virtual working directory (defaults to "/").
	CWD string
	// Input is injected as the global `input` (JSON-serialized).
	Input any
	// InputJSON, when set, is injected verbatim and takes precedence over Input.
	InputJSON []byte
	// FS scopes filesystem access.
	FS FSConfig
	// Timeout bounds the whole request. Defaults to DefaultTimeout.
	Timeout time.Duration
	// MemoryLimit is the QuickJS heap limit in bytes. Defaults to 64 MiB.
	MemoryLimit int
	// MaxStackSize is the QuickJS stack limit in bytes. Defaults to 1 MiB.
	MaxStackSize int
	// MaxOutputBytes caps captured stdout+stderr. Defaults to 1 MiB.
	MaxOutputBytes int
}

// applyDefaults normalizes the environment for execution.
func (e *Env) applyDefaults() {
	if e.Timeout <= 0 {
		e.Timeout = DefaultTimeout
	}
	if e.MemoryLimit <= 0 {
		e.MemoryLimit = DefaultMemoryLimit
	}
	if e.MaxStackSize <= 0 {
		e.MaxStackSize = DefaultMaxStackSize
	}
	if e.MaxOutputBytes <= 0 {
		e.MaxOutputBytes = DefaultMaxOutputBytes
	}
	if e.CWD == "" {
		e.CWD = "/"
	}
	e.CWD = cleanVirtual(e.CWD)

	if e.Vars == nil {
		e.Vars = map[string]string{}
	}
	if len(e.FS.Roots) > 0 {
		normalized := make(map[string]string, len(e.FS.Roots))
		for v, r := range e.FS.Roots {
			normalized[cleanVirtual(v)] = r
		}
		e.FS.Roots = normalized
	}
}

// cleanVirtual normalizes a virtual path to an absolute, slash-separated form.
func cleanVirtual(p string) string {
	if p == "" {
		return "/"
	}
	return path.Clean("/" + strings.TrimPrefix(p, "/"))
}

// resolveVirtualPath maps a guest path to a real host path, enforcing the
// configured filesystem roots. Relative paths are resolved against Env.CWD.
func (e Env) resolveVirtualPath(p string) (string, error) {
	if p == "" {
		return "", fmt.Errorf("EACCES: empty path")
	}
	vp := p
	if !strings.HasPrefix(vp, "/") {
		vp = path.Join(e.CWD, vp)
	}
	vp = cleanVirtual(vp)

	var bestVirtual string
	for v := range e.FS.Roots {
		if vp == v || strings.HasPrefix(vp, v+"/") {
			if len(v) > len(bestVirtual) {
				bestVirtual = v
			}
		}
	}
	if bestVirtual == "" {
		return "", fmt.Errorf("EACCES: %q is outside the allowed filesystem roots", p)
	}

	realRoot := e.FS.Roots[bestVirtual]
	rel := strings.TrimPrefix(vp, bestVirtual)
	real := filepath.Join(realRoot, filepath.FromSlash(rel))

	absRoot, err := filepath.Abs(realRoot)
	if err != nil {
		return "", fmt.Errorf("EACCES: invalid root: %w", err)
	}
	absReal, err := filepath.Abs(real)
	if err != nil {
		return "", fmt.Errorf("EACCES: invalid path: %w", err)
	}
	if absReal != absRoot && !strings.HasPrefix(absReal, absRoot+string(filepath.Separator)) {
		return "", fmt.Errorf("EACCES: %q escapes the allowed filesystem roots", p)
	}
	return absReal, nil
}
