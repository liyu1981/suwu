package main

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"suwu/pkg/background"
	"suwu/pkg/wgsl"
)

const backgroundUsageText = `Usage: suwu background build <file.wgsl>

Compile a background's WGSL import graph into a ShaderSource module and print
it to stdout. Redirect it to the sibling artifact a background's scene.js
imports:

  suwu background build shaders/cosmos.wgsl > shaders/cosmos.shader.js

The whole directory containing <file.wgsl> (or, when a background.json sits
above it, the background root) is scanned for .wgsl files, so relative imports
resolve against what is on disk. Bare @vgpu/wgsl-std imports resolve against
the stdlib embedded in this binary.

Diagnostics go to stderr; stdout carries only the module on success, so ` + "`>`" + `
is always safe.

Exit codes:
  0 success, 1 compile error, 64 usage error
`

func printBackgroundUsage() { fmt.Fprint(os.Stderr, backgroundUsageText) }

// backgroundMain implements `suwu background`. It returns the process exit
// code; the caller os.Exit's it.
func backgroundMain(args []string) int {
	if len(args) == 1 && args[0] == "build" {
		printBackgroundUsage()
		return 64
	}
	if len(args) != 2 || args[0] != "build" {
		printBackgroundUsage()
		return 64
	}
	return backgroundBuild(args[1])
}

func backgroundBuild(file string) int {
	abs, err := filepath.Abs(file)
	if err != nil {
		fmt.Fprintf(os.Stderr, "background: %v\n", err)
		return 1
	}
	info, err := os.Stat(abs)
	if err != nil {
		fmt.Fprintf(os.Stderr, "background: %v\n", err)
		return 1
	}
	if !info.Mode().IsRegular() || !strings.HasSuffix(strings.ToLower(abs), ".wgsl") {
		fmt.Fprintf(os.Stderr, "background: %s is not a .wgsl file\n", file)
		return 1
	}

	entry, files, err := collectWGSL(findBackgroundRoot(filepath.Dir(abs)), abs)
	if err != nil {
		fmt.Fprintf(os.Stderr, "background: %v\n", err)
		return 1
	}

	res, err := wgsl.Compile(context.Background(), entry, files)
	if err != nil {
		var compileErr *wgsl.Error
		if errors.As(err, &compileErr) {
			for _, d := range compileErr.Errors {
				fmt.Fprintln(os.Stderr, d.String())
			}
		} else {
			fmt.Fprintf(os.Stderr, "background: %v\n", err)
		}
		return 1
	}
	for _, w := range res.Warnings {
		fmt.Fprintf(os.Stderr, "warning: %s\n", w.String())
	}
	if _, err := fmt.Fprint(os.Stdout, res.Module); err != nil {
		fmt.Fprintf(os.Stderr, "background: write stdout: %v\n", err)
		return 1
	}
	return 0
}

// findBackgroundRoot walks up from dir for background.json so relative imports
// can reach beyond a shaders/ subdirectory; without a manifest the entry's own
// directory is the root.
func findBackgroundRoot(dir string) string {
	for d := dir; ; {
		if _, err := os.Stat(filepath.Join(d, background.ManifestFile)); err == nil {
			return d
		}
		parent := filepath.Dir(d)
		if parent == d {
			return dir
		}
		d = parent
	}
}

// collectWGSL reads every .wgsl under root keyed by slash-separated relative
// path, and returns the entry's own relative key.
func collectWGSL(root, entryAbs string) (string, map[string]string, error) {
	files := make(map[string]string)
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			// Unreadable entries are unrelated noise (e.g. a shared temp dir);
			// skipping them lets the resolver report the import that is
			// actually missing instead of failing the scan.
			if path == root {
				return err
			}
			return nil
		}
		if d.IsDir() || !strings.HasSuffix(strings.ToLower(d.Name()), ".wgsl") {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		files[filepath.ToSlash(rel)] = string(data)
		return nil
	})
	if err != nil {
		return "", nil, fmt.Errorf("scan %s: %w", root, err)
	}
	relEntry, err := filepath.Rel(root, entryAbs)
	if err != nil {
		return "", nil, err
	}
	relEntry = filepath.ToSlash(relEntry)
	if _, ok := files[relEntry]; !ok {
		return "", nil, fmt.Errorf("%s is not under the scanned root %s", entryAbs, root)
	}
	return relEntry, files, nil
}
