package install

// Installing from a local directory: `suwu install --local <path>`.
//
// The GitHub catalog is the right default for users, but developing an extension
// means installing a working tree — and after the build phase that tree is a JS
// project with node_modules/, src/ and a generated dist/. FromLocalDir walks it,
// applies the shared payload rule (payload.go), and stages the result exactly
// like an archive or a catalog download, so Commit/validation/--force/--dry-run
// behave identically.

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"

	"suwu/pkg/extension"
)

// LocalOptions controls one local-directory install.
type LocalOptions struct {
	Options
	// Kind is what the directory holds. Defaults to KindExtension.
	Kind Kind
	// ID overrides the item id. Empty means "the directory name", which is what
	// every example uses and what the catalog derives.
	ID string
}

// FromLocalDir stages and installs one item from a directory on disk.
//
// The directory must look like an installed item: package.json plus index.js at
// the top (the extension contract), and — when the manifest declares
// suwu.static — the built asset tree, which must exist. A missing dist/ is the
// failure mode this catches most: it means "you forgot to build", and
// installing anyway would produce an extension that renders nothing.
func FromLocalDir(dir string, opt LocalOptions) (Item, error) {
	kind := opt.Kind
	if kind == "" {
		kind = KindExtension
	}
	abs, err := filepath.Abs(dir)
	if err != nil {
		return Item{Kind: kind}, fmt.Errorf("resolve %q: %w", dir, err)
	}
	if !filepath.IsAbs(abs) || filepath.Clean(abs) != abs {
		return Item{Kind: kind}, fmt.Errorf("directory %q is not a clean absolute path", dir)
	}
	if err := validateDataDir(opt.DataDir); err != nil {
		return Item{Kind: kind}, err
	}

	id := opt.ID
	if id == "" {
		id = filepath.Base(abs)
	}
	if !kind.ValidID(id) {
		return Item{Kind: kind}, fmt.Errorf("invalid %s id %q (want %s)", kind.Label(), id, idGrammar)
	}

	manifestPath := filepath.Join(abs, extension.PackageFile)
	// Directories kept out of the payload beyond the shared rule (e.g. the
	// unpacked build tree next to the archive that replaces it).
	var skipDirs []string
	if kind == KindExtension {
		if _, err := os.Stat(manifestPath); err != nil {
			return Item{Kind: kind, ID: id}, fmt.Errorf("%s: missing %s", abs, extension.PackageFile)
		}
		if _, err := os.Stat(filepath.Join(abs, extension.EntryFile)); err != nil {
			return Item{Kind: kind, ID: id}, fmt.Errorf("%s: missing %s", abs, extension.EntryFile)
		}
		// A built extension must have its asset tree; refusing here produces
		// "run the build first" instead of an extension that 404s everything.
		if _, err := extension.ReadManifest(manifestPath, id); err != nil {
			return Item{Kind: kind, ID: id}, fmt.Errorf("%s: %w", extension.PackageFile, err)
		}
		if static, err := staticDir(manifestPath); err == nil && static != "" {
			// With an archive source, the unpacked tree of the same name is a
			// build artifact: it is not payload, and installing both would
			// double the size.
			if strings.HasSuffix(strings.ToLower(static), extension.StaticArchiveExt) {
				skipDirs = append(skipDirs, strings.TrimSuffix(static, path.Ext(static)))
			}
			st := filepath.Join(abs, static)
			info, statErr := os.Stat(st)
			ok := statErr == nil
			if ok {
				if strings.HasSuffix(strings.ToLower(static), extension.StaticArchiveExt) {
					ok = info.Mode().IsRegular()
				} else {
					ok = info.IsDir()
				}
			}
			if !ok {
				return Item{Kind: kind, ID: id}, fmt.Errorf(
					"%s: suwu.static %q is missing: build it first (pnpm --dir %s build)",
					extension.PackageFile, static, filepath.Base(abs))
			}
		}
	}

	stage, err := NewStage(opt.DataDir, kind, id)
	if err != nil {
		return Item{Kind: kind, ID: id}, err
	}
	defer func() { _ = stage.Discard() }()

	skipped := newSkipTally()
	err = filepath.WalkDir(abs, func(p string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		rel, relErr := filepath.Rel(abs, p)
		if relErr != nil {
			return relErr
		}
		rel = filepath.ToSlash(rel)
		if rel == "." {
			return nil
		}
		for _, unpacked := range skipDirs {
			if rel == unpacked || strings.HasPrefix(rel, unpacked+"/") {
				skipped.add(unpacked + " (unpacked build)")
				if d.IsDir() {
					return fs.SkipDir
				}
				return nil
			}
		}
		if reason, skip := SkipPayload(rel); skip {
			if d.IsDir() {
				skipped.add(reason)
				return fs.SkipDir // do not descend into node_modules/ or .git/
			}
			skipped.add(reason)
			return nil
		}
		if d.IsDir() {
			return nil
		}
		// Symlinks are refused: a staged tree must be exactly what the
		// directory contains, and a link could point outside it.
		if d.Type()&fs.ModeSymlink != 0 {
			return fmt.Errorf("%s: symlinks are not supported", rel)
		}
		if !d.Type().IsRegular() {
			return fmt.Errorf("%s: not a regular file", rel)
		}
		f, openErr := os.Open(p)
		if openErr != nil {
			return openErr
		}
		defer func() { _ = f.Close() }()
		_, writeErr := stage.WriteFile(rel, f)
		return writeErr
	})
	if err != nil {
		return Item{Kind: kind, ID: id}, err
	}

	item, err := stage.Commit(opt.Options)
	item.Skipped = skipped.String()
	return item, err
}

// staticDir reads suwu.static out of a package.json without a full Resolve. An
// unreadable or malformed manifest yields "" (Resolve reports it properly
// during Commit).
func staticDir(packagePath string) (string, error) {
	raw, err := os.ReadFile(packagePath)
	if err != nil {
		return "", err
	}
	var pkg struct {
		Suwu *struct {
			Static string `json:"static"`
		} `json:"suwu"`
	}
	if err := json.Unmarshal(raw, &pkg); err != nil {
		return "", err
	}
	if pkg.Suwu == nil {
		return "", nil
	}
	return strings.TrimSpace(pkg.Suwu.Static), nil
}

// LocalIDFromDir reports the id a directory would install as, so the CLI can
// print it before doing any work.
func LocalIDFromDir(dir string) (string, error) {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return "", err
	}
	return filepath.Base(abs), nil
}
