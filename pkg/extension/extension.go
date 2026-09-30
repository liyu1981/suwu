// Package extension discovers and resolves gqjs-backed extensions that the
// `extension` tile plugin renders. An extension is a directory under the Suwu
// data dir's `extension/` folder containing a required `package.json`
// (npm-style name/description at the top level, Suwu specifics under the
// "suwu" object) and a hard-coded `index.js` entry point. Optional API
// handlers are registered as ordered `{route, handler}` entries under
// `suwu.api` and served under /gqjs/api/<id>/, a directory of public assets
// is declared with `suwu.static` and served unauthenticated under
// /gqjs/static/<id>/ (never put secrets in it), and `suwu.net` opts the
// extension into network access for its scripts.
//
// Nothing is seeded automatically: installable examples live in the repo's
// examples/extension/ directory and are installed with `suwu install`.
package extension

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// DirName is the extension tree below the data dir: <dataDir>/extension.
// It is singular to match the sibling `background` tree, and it is the prefix
// an install archive is expected to carry (see docs/INSTALL_PLAN.md §7.1).
const DirName = "extension"

// LegacyDirName is the pre-0.1.12 name of the extension tree. It is read as a
// compatibility fallback (ResolveDir) and never written: `suwu install` only
// ever creates <dataDir>/extension.
const LegacyDirName = "extensions"

// EntryFile is the hard-coded render entry point filename inside an extension dir.
const EntryFile = "index.js"

// PackageFile is the required metadata filename inside an extension dir.
// npm-style fields (name, description) are read from the top level and never
// repeated inside the Suwu-specific object.
const PackageFile = "package.json"

// paramSegRe matches a route parameter segment: <name>.
var paramSegRe = regexp.MustCompile(`^<[A-Za-z_][A-Za-z0-9_-]*>$`)

// idRe validates an extension id (also the directory name). It forbids path
// separators and dot segments, which is the primary traversal defense.
var idRe = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)

// Param documents one launch parameter an extension accepts. It mirrors the
// frontend PluginParamDoc shape so the config editor can render labels/hints.
type Param struct {
	Key          string `json:"key"`
	Label        string `json:"label,omitempty"`
	Description  string `json:"description,omitempty"`
	DefaultValue string `json:"defaultValue,omitempty"`
}

// APIRoute registers one API entry: requests under /gqjs/api/<id>/ whose path
// prefix-matches Route are executed by Handler's script. Registration order
// matters — the first matching route wins, so a broader route listed first
// shortcuts later, more specific ones.
type APIRoute struct {
	Route   string `json:"route"`
	Handler string `json:"handler"`
}

// packageJSON is the subset of package.json Suwu reads. Unknown fields
// (version, dependencies, …) are ignored.
type packageJSON struct {
	Name        string     `json:"name"`
	Description string     `json:"description"`
	Suwu        *suwuSpecs `json:"suwu"`
}

// suwuSpecs is the Suwu-specific object inside package.json.
type suwuSpecs struct {
	Params []Param    `json:"params"`
	API    []APIRoute `json:"api"`
	// Static is the directory (relative to the extension dir) whose files are
	// served under /gqjs/static/<id>/. Empty means no static serving. The
	// directory must be a dedicated subtree (never "." or the extension root)
	// so handler source and package.json can never be served.
	Static string `json:"static"`
	// Net opts the extension's scripts into network access (suwu gq
	// --allow-net). Off by default: without it, fetch() rejects.
	Net bool `json:"net"`
}

// Extension is one resolved, runnable extension.
type Extension struct {
	// ID is the extension directory name.
	ID string `json:"id"`
	// Name is the display name (defaults to ID).
	Name string `json:"name"`
	// Description is a short human description.
	Description string `json:"description,omitempty"`
	// Params documents accepted launch parameters.
	Params []Param `json:"params,omitempty"`
	// API lists registered API routes in declaration order (first match wins).
	API []APIRoute `json:"api,omitempty"`
	// Net reports whether the extension declared suwu.net (network access).
	Net bool `json:"net,omitempty"`
	// Static is the declared public-assets directory (suwu.static); empty
	// when the extension serves no static files.
	Static string `json:"static,omitempty"`
	// Dir is the absolute extension directory.
	Dir string `json:"-"`
	// Entry is the absolute path to index.js.
	Entry string `json:"-"`
}

// Dir returns the extension directory for a Suwu data directory: the single
// source of truth for where extensions live.
func Dir(dataDir string) string { return filepath.Join(dataDir, DirName) }

// LegacyDir returns the pre-rename extension directory. It is read-only: see
// ResolveDir.
func LegacyDir(dataDir string) string { return filepath.Join(dataDir, LegacyDirName) }

// DirResolution says which extension directory a reader should use.
type DirResolution struct {
	// Dir is the directory to read extensions from.
	Dir string
	// Legacy is true when Dir is the pre-rename path, so the caller can warn.
	Legacy bool
	// LegacyPresent is true when the pre-rename directory still holds
	// extensions, whether or not it is the one being read. It is the signal
	// for the one-time "mv" hint.
	LegacyPresent bool
}

// ResolveDir picks the extension directory to read: the current name when it
// holds at least one resolvable extension, otherwise the legacy name when that
// one does, otherwise the current name (so a fresh install creates it).
//
// The fallback exists because the released docs told users to copy extensions
// into <dataDir>/extensions; without it, upgrading would silently stop listing
// them. It is a compatibility read path, not a migration — nothing is ever
// moved or written here.
func ResolveDir(dataDir string) DirResolution {
	current := Dir(dataDir)
	res := DirResolution{Dir: current, LegacyPresent: hasExtension(LegacyDir(dataDir))}
	// The legacy directory is reported even when the current one wins: it is
	// the leftover that will silently stop being read.
	if hasExtension(current) || !res.LegacyPresent {
		return res
	}
	res.Dir = LegacyDir(dataDir)
	res.Legacy = true
	return res
}

// hasExtension reports whether dir exists and holds at least one resolvable
// extension. An unreadable or absent directory is simply "no".
func hasExtension(dir string) bool {
	exts, err := List(dir)
	return err == nil && len(exts) > 0
}

// ValidID reports whether id is a legal extension id.
func ValidID(id string) bool { return idRe.MatchString(id) }

// List returns every resolvable extension under dir, sorted by ID. Missing or
// unreadable directories yield an empty result; individual invalid or
// incomplete extension directories are skipped.
func List(dir string) ([]Extension, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("read extensions dir: %w", err)
	}
	out := make([]Extension, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		ext, err := Resolve(dir, e.Name())
		if err != nil {
			continue // skip invalid/incomplete extension dirs
		}
		out = append(out, ext)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

// Resolve validates an id and returns its Extension, reading package.json.
func Resolve(dir, id string) (Extension, error) {
	if !ValidID(id) {
		return Extension{}, fmt.Errorf("invalid extension id %q", id)
	}
	base, err := filepath.Abs(dir)
	if err != nil {
		return Extension{}, fmt.Errorf("resolve extensions dir: %w", err)
	}
	extDir := filepath.Join(base, id)
	if err := ensureWithin(base, extDir); err != nil {
		return Extension{}, fmt.Errorf("extension %q: %w", id, err)
	}

	entry := filepath.Join(extDir, EntryFile)
	if !isRegularFile(entry) {
		return Extension{}, fmt.Errorf("extension %q: missing %s", id, EntryFile)
	}
	if err := ensureWithin(extDir, entry); err != nil {
		return Extension{}, fmt.Errorf("extension %q: %w", id, err)
	}

	pkg, err := readPackage(filepath.Join(extDir, PackageFile))
	if err != nil {
		return Extension{}, fmt.Errorf("extension %q: %w", id, err)
	}

	// A malformed registration fails the whole extension: an extension can
	// never half-serve with a broken API surface.
	var api []APIRoute
	var params []Param
	if pkg.Suwu != nil {
		api = pkg.Suwu.API
		params = pkg.Suwu.Params
	}
	for _, rt := range api {
		if err := validateAPIRoute(rt); err != nil {
			return Extension{}, fmt.Errorf("extension %q: %w", id, err)
		}
		if _, err := handlerPath(extDir, rt.Handler); err != nil {
			return Extension{}, fmt.Errorf("extension %q: %w", id, err)
		}
	}

	var static string
	if pkg.Suwu != nil {
		static = pkg.Suwu.Static
		if err := validateStaticRoot(static); err != nil {
			return Extension{}, fmt.Errorf("extension %q: %w", id, err)
		}
	}

	name := pkg.Name
	if name == "" {
		name = id
	}
	net := pkg.Suwu != nil && pkg.Suwu.Net
	return Extension{
		ID:          id,
		Name:        name,
		Description: pkg.Description,
		Params:      params,
		API:         api,
		Net:         net,
		Static:      static,
		Dir:         extDir,
		Entry:       entry,
	}, nil
}

// HandlerPath resolves an API handler (as declared in suwu.api) to an
// absolute path inside the extension directory.
func (e Extension) HandlerPath(handler string) (string, error) {
	return handlerPath(e.Dir, handler)
}

// StaticPath resolves a requested static asset (relative path after the id)
// inside the extension's declared suwu.static directory. Every segment must
// be a plain file component — no empty/dot segments and no dotfiles — and the
// resolved path (symlinks included) must stay inside the static root, so a
// request can never walk into handler source, package.json, or out of the
// extension altogether.
func (e Extension) StaticPath(rel string) (string, error) {
	if e.Static == "" {
		return "", fmt.Errorf("extension has no static directory")
	}
	if err := validateRelSegments(rel); err != nil {
		return "", err
	}
	root := filepath.Join(e.Dir, e.Static)
	p := filepath.Join(root, rel)
	if err := ensureWithin(root, p); err != nil {
		return "", fmt.Errorf("static path %q: %w", rel, err)
	}
	return p, nil
}

// validateRelSegments checks a slash-separated relative path: non-empty,
// with no absolute prefix, no backslashes, and no empty, dot, or dot-prefixed
// segments (which also rejects dotfiles like .env).
func validateRelSegments(p string) error {
	if p == "" {
		return fmt.Errorf("path is empty")
	}
	if strings.HasPrefix(p, "/") || strings.Contains(p, `\`) {
		return fmt.Errorf("path %q must be relative", p)
	}
	for _, seg := range strings.Split(p, "/") {
		if seg == "" || seg == "." || seg == ".." {
			return fmt.Errorf("path %q has an invalid segment", p)
		}
		if strings.HasPrefix(seg, ".") {
			return fmt.Errorf("path %q must not contain dotfiles", p)
		}
	}
	return nil
}

// validateStaticRoot checks the declared suwu.static directory (empty = no
// static serving), with the same segment rules as StaticPath — the root must
// be a dedicated subtree, never "." or a hidden directory.
func validateStaticRoot(root string) error {
	if root == "" {
		return nil
	}
	return validateRelSegments(root)
}

// validateHandlerSyntax checks a declared handler before it is joined to the
// extension directory: a plain relative .js path with no dot segments.
func validateHandlerSyntax(handler string) error {
	if handler == "" {
		return fmt.Errorf("API handler is empty")
	}
	if !strings.HasSuffix(handler, ".js") {
		return fmt.Errorf("API handler %q must end in .js", handler)
	}
	if strings.HasPrefix(handler, "/") || strings.Contains(handler, `\`) {
		return fmt.Errorf("API handler %q must be a relative path", handler)
	}
	for _, seg := range strings.Split(handler, "/") {
		if seg == "" || seg == "." || seg == ".." {
			return fmt.Errorf("API handler %q has an invalid path segment", handler)
		}
	}
	return nil
}

// handlerPath validates a handler and resolves it inside extDir, re-checked
// against symlinks as defense in depth.
func handlerPath(extDir, handler string) (string, error) {
	if err := validateHandlerSyntax(handler); err != nil {
		return "", err
	}
	p := filepath.Join(extDir, handler)
	if err := ensureWithin(extDir, p); err != nil {
		return "", fmt.Errorf("API handler %q: %w", handler, err)
	}
	return p, nil
}

// validateAPIRoute checks one suwu.api entry: the route's segment grammar
// (literals and <param> segments, no empty segments) and its handler syntax.
// The catch-all root is "/".
func validateAPIRoute(rt APIRoute) error {
	if rt.Route == "" {
		return fmt.Errorf("API route is empty")
	}
	for _, seg := range splitRoute(rt.Route) {
		switch {
		case seg == "":
			return fmt.Errorf("API route %q has an empty segment", rt.Route)
		case strings.HasPrefix(seg, "<") || strings.HasSuffix(seg, ">"):
			if !paramSegRe.MatchString(seg) {
				return fmt.Errorf("API route %q has an invalid parameter segment %q", rt.Route, seg)
			}
		case strings.ContainsAny(seg, "<>"):
			return fmt.Errorf("API route %q has an invalid segment %q", rt.Route, seg)
		}
	}
	return validateHandlerSyntax(rt.Handler)
}

// splitRoute normalizes a route pattern or request path into its segments.
// A leading slash is implied and trailing slashes are trimmed; "/" and ""
// yield no segments — the catch-all root.
func splitRoute(p string) []string {
	trimmed := strings.Trim(p, "/")
	if trimmed == "" {
		return nil
	}
	return strings.Split(trimmed, "/")
}

// MatchAPI selects the first route in declaration order whose pattern
// prefix-matches path: every route segment must match the corresponding path
// segment — a literal by equality, a <param> by binding it — while the path
// may carry extra trailing segments. So /hello listed before /hello/world
// shortcuts the latter, and /note/<id> matches /note/42 as well as
// /note/42/edit (binding id to the first segment).
func MatchAPI(routes []APIRoute, path string) (APIRoute, map[string]string, bool) {
	pathSegs := splitRoute(path)
	for _, rt := range routes {
		routeSegs := splitRoute(rt.Route)
		if len(routeSegs) > len(pathSegs) {
			continue
		}
		bindings := map[string]string{}
		matched := true
		for i, seg := range routeSegs {
			if strings.HasPrefix(seg, "<") {
				bindings[seg[1:len(seg)-1]] = pathSegs[i]
				continue
			}
			if seg != pathSegs[i] {
				matched = false
				break
			}
		}
		if matched {
			return rt, bindings, true
		}
	}
	return APIRoute{}, nil, false
}

func readPackage(path string) (packageJSON, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return packageJSON{}, fmt.Errorf("missing %s", PackageFile)
		}
		return packageJSON{}, fmt.Errorf("read %s: %w", PackageFile, err)
	}
	var p packageJSON
	if err := json.Unmarshal(data, &p); err != nil {
		return packageJSON{}, fmt.Errorf("parse %s: %w", PackageFile, err)
	}
	return p, nil
}

// isRegularFile reports whether p exists and is a regular file.
func isRegularFile(p string) bool {
	info, err := os.Stat(p)
	return err == nil && !info.IsDir()
}

// ensureWithin rejects target when, after resolving symlinks, it is not
// contained in base. This is the defense against a symlinked extension dir
// escaping the extensions root.
func ensureWithin(base, target string) error {
	resolvedBase, err := filepath.EvalSymlinks(base)
	if err != nil {
		// base may not exist yet (e.g. Seed); fall back to lexical check.
		resolvedBase = base
	}
	resolvedTarget, err := filepath.EvalSymlinks(target)
	if err != nil {
		resolvedTarget = target
	}
	absBase, err := filepath.Abs(resolvedBase)
	if err != nil {
		return err
	}
	absTarget, err := filepath.Abs(resolvedTarget)
	if err != nil {
		return err
	}
	if absTarget != absBase && !strings.HasPrefix(absTarget, absBase+string(filepath.Separator)) {
		return fmt.Errorf("path escapes the extensions directory")
	}
	return nil
}
