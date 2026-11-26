package bindir

import (
	"os"
	"path/filepath"
	"strings"
)

// Block is one managed rc-file block: the two marker lines that delimit it.
// Several blocks may coexist in one file (suwu-max's app directory, the tool
// directory, and per-tool shell setup), so each has its own markers and
// removing one never disturbs the others.
type Block struct {
	Start string
	End   string
	// Tag names the block in the one-time rc backup (`<file>.<tag>.bak`), so
	// each block keeps its own "before" copy and neither overwrites the other.
	Tag string
}

// MaxBlock is `suwu-max`'s block. It adds ~/.local/bin (where the app lives).
var MaxBlock = Block{Start: "# >>> suwu-max >>>", End: "# <<< suwu-max <<<", Tag: "suwu-max"}

// ToolsBlock puts the managed tool directory on an interactive shell's PATH.
// It is not optional: Suwu writes it when it starts and after every install, so
// the tools it manages work in shells opened outside Suwu too. `suwu exec` never
// depends on it.
var ToolsBlock = Block{Start: "# >>> suwu-bin >>>", End: "# <<< suwu-bin <<<", Tag: "suwu-bin"}

// FzfBlock and AsdfBlock carry the optional shell setup of those two tools.
// Their integration is a separate, explicit click in the Tools page because it
// changes shell behaviour beyond finding a binary.
var (
	FzfBlock  = Block{Start: "# >>> suwu-fzf >>>", End: "# <<< suwu-fzf <<<", Tag: "suwu-fzf"}
	AsdfBlock = Block{Start: "# >>> suwu-asdf >>>", End: "# <<< suwu-asdf <<<", Tag: "suwu-asdf"}
)

type shellSyntax int

const (
	posixSyntax shellSyntax = iota
	bashSyntax
	zshSyntax
	fishSyntax
)

type rcTarget struct {
	file   string
	syntax shellSyntax
}

// bodyBuilder renders the lines inside a managed block for one shell. An empty
// result means the block does not apply to that shell and is skipped.
type bodyBuilder func(syntax shellSyntax, home string) string

// ToolSetup is one optional shell integration snippet.
type ToolSetup struct {
	Name string
	// Command is the line users see in the UI and docs (the POSIX form).
	Command string
	block   Block
	posix   string
	bash    string
	zsh     string
	fish    string
}

// ToolSetups returns the shell setups Suwu can add for a managed tool.
func ToolSetups() []ToolSetup {
	return []ToolSetup{
		{
			Name:    "fzf",
			Command: `eval "$(fzf --bash)"`,
			block:   FzfBlock,
			bash:    `eval "$(fzf --bash)"`,
			zsh:     `eval "$(fzf --zsh)"`,
			posix:   `eval "$(fzf --bash)"`,
			fish:    `fzf --fish | source`,
		},
		{
			Name:    "asdf",
			Command: `export PATH="${ASDF_DATA_DIR:-$HOME/.asdf}/shims:$PATH"`,
			block:   AsdfBlock,
			bash:    `export PATH="${ASDF_DATA_DIR:-$HOME/.asdf}/shims:$PATH"`,
			zsh:     `export PATH="${ASDF_DATA_DIR:-$HOME/.asdf}/shims:$PATH"`,
			posix:   `export PATH="${ASDF_DATA_DIR:-$HOME/.asdf}/shims:$PATH"`,
			fish:    `if test -d "$HOME/.asdf/shims"; set -gx PATH "$HOME/.asdf/shims" $PATH; end`,
		},
	}
}

// ToolSetupFor looks up the optional shell setup for a tool name.
func ToolSetupFor(name string) (ToolSetup, bool) {
	for _, setup := range ToolSetups() {
		if setup.Name == name {
			return setup, true
		}
	}
	return ToolSetup{}, false
}

func (s ToolSetup) body(syntax shellSyntax) string {
	switch syntax {
	case fishSyntax:
		return s.fish
	case zshSyntax:
		if s.zsh != "" {
			return s.zsh
		}
		return s.posix
	default:
		if s.bash != "" {
			return s.bash
		}
		return s.posix
	}
}

// EnsurePath adds (or refreshes) this block so dir is on PATH for the shells
// configured on this machine. Only rc files that already exist are touched,
// except that ~/.profile is created when none exist at all. It is idempotent
// and returns the files it changed.
func EnsurePath(dir string, block Block) ([]string, error) {
	return ensureBlock(block, func(syntax shellSyntax, home string) string {
		return renderPathBody(syntax, displayPath(dir, home))
	})
}

// EnsureToolSetup adds the optional shell integration for one managed tool.
func EnsureToolSetup(name string) ([]string, error) {
	setup, ok := ToolSetupFor(name)
	if !ok {
		return nil, os.ErrNotExist
	}
	return ensureBlock(setup.block, func(syntax shellSyntax, _ string) string {
		return setup.body(syntax)
	})
}

// RemoveToolSetup removes the optional shell integration for one managed tool.
func RemoveToolSetup(name string) ([]string, error) {
	setup, ok := ToolSetupFor(name)
	if !ok {
		return nil, os.ErrNotExist
	}
	return RemovePath(setup.block)
}

// ToolSetupFiles lists the rc files that currently carry this tool's setup.
func ToolSetupFiles(name string) ([]string, error) {
	setup, ok := ToolSetupFor(name)
	if !ok {
		return nil, os.ErrNotExist
	}
	return PathFiles(setup.block)
}

// ensureBlock writes a managed block built by body into every existing rc file
// whose shell the body supports.
func ensureBlock(block Block, body bodyBuilder) ([]string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	var changed []string
	for _, target := range rcTargets(home) {
		inner := body(target.syntax, home)
		if strings.TrimSpace(inner) == "" {
			continue
		}
		original, err := os.ReadFile(target.file)
		if err != nil {
			if !os.IsNotExist(err) {
				return changed, err
			}
			original = nil
		}
		next, didChange := upsertBlock(string(original), wrapBlock(block, inner), block)
		if !didChange {
			continue
		}
		if len(original) > 0 {
			backup := target.file + "." + block.Tag + ".bak"
			if _, statErr := os.Stat(backup); os.IsNotExist(statErr) {
				_ = os.WriteFile(backup, original, 0o644)
			}
		}
		if err := os.MkdirAll(filepath.Dir(target.file), 0o755); err != nil {
			return changed, err
		}
		if err := os.WriteFile(target.file, []byte(next), 0o644); err != nil {
			return changed, err
		}
		changed = append(changed, target.file)
	}
	return changed, nil
}

// RemovePath removes this block everywhere it is found.
func RemovePath(block Block) ([]string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	var changed []string
	for _, target := range rcTargets(home) {
		data, err := os.ReadFile(target.file)
		if err != nil {
			continue
		}
		next, didChange := removeBlock(string(data), block)
		if !didChange {
			continue
		}
		if err := os.WriteFile(target.file, []byte(next), 0o644); err != nil {
			return changed, err
		}
		changed = append(changed, target.file)
	}
	return changed, nil
}

// PathFiles lists the rc files that currently carry this block.
func PathFiles(block Block) ([]string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	var files []string
	for _, target := range rcTargets(home) {
		data, err := os.ReadFile(target.file)
		if err != nil {
			continue
		}
		if _, _, ok := findBlock(string(data), block); ok {
			files = append(files, target.file)
		}
	}
	return files, nil
}

// OnPath reports whether the rc files already put dir on PATH — through one of
// our blocks or because the user (or a distribution default) mentions it. It is
// what keeps `suwu-max` from adding a block that says what the shell already
// does.
func OnPath(dir string) bool {
	home, err := os.UserHomeDir()
	if err != nil {
		return false
	}
	rel, relErr := filepath.Rel(home, dir)
	if relErr == nil && rel != "." && !strings.HasPrefix(rel, "..") {
		rel = "$HOME/" + filepath.ToSlash(rel)
	}
	forms := []string{filepath.ToSlash(dir), rel}
	for _, target := range rcTargets(home) {
		data, err := os.ReadFile(target.file)
		if err != nil {
			continue
		}
		content := string(data)
		for _, form := range forms {
			if form != "" && strings.Contains(content, form) {
				return true
			}
		}
	}
	return false
}

// rcTargets picks the rc files to patch. Every existing bash/zsh/fish rc is
// patched (login and non-login shells read different files), and ~/.profile is
// created when the account has none.
func rcTargets(home string) []rcTarget {
	candidates := []rcTarget{
		{filepath.Join(home, ".bashrc"), bashSyntax},
		{filepath.Join(home, ".bash_profile"), bashSyntax},
		{filepath.Join(home, ".profile"), posixSyntax},
		{filepath.Join(home, ".zshrc"), zshSyntax},
		{filepath.Join(home, ".zshenv"), zshSyntax},
		{filepath.Join(home, ".config", "fish", "config.fish"), fishSyntax},
	}
	var existing []rcTarget
	for _, c := range candidates {
		if info, err := os.Stat(c.file); err == nil && info.Mode().IsRegular() {
			existing = append(existing, c)
		}
	}
	if len(existing) == 0 {
		return []rcTarget{{filepath.Join(home, ".profile"), posixSyntax}}
	}
	return existing
}

// displayPath renders dir relative to $HOME so the block survives a moved home.
func displayPath(dir, home string) string {
	if rel, err := filepath.Rel(home, dir); err == nil && rel != "." && !strings.HasPrefix(rel, "..") {
		return "$HOME/" + filepath.ToSlash(rel)
	}
	return filepath.ToSlash(dir)
}

func renderPathBody(syntax shellSyntax, display string) string {
	if syntax == fishSyntax {
		return strings.Join([]string{
			`if not contains "` + display + `" $PATH`,
			`    set -gx PATH "` + display + `" $PATH`,
			`end`,
		}, "\n")
	}
	return strings.Join([]string{
		`case ":$PATH:" in *":` + display + `:"*) ;; *) PATH="` + display + `:$PATH" ;; esac`,
		`export PATH`,
	}, "\n")
}

func wrapBlock(block Block, inner string) string {
	return block.Start + "\n" + inner + "\n" + block.End
}

// upsertBlock replaces an existing managed block or appends one, returning the
// new content and whether it differs from the original.
func upsertBlock(content, block string, markers Block) (string, bool) {
	if start, end, ok := findBlock(content, markers); ok {
		next := content[:start] + block + content[end:]
		return next, next != content
	}
	trimmed := strings.TrimRight(content, "\n")
	var b strings.Builder
	b.WriteString(trimmed)
	if trimmed != "" {
		b.WriteString("\n\n")
	}
	b.WriteString(block)
	b.WriteString("\n")
	return b.String(), true
}

func removeBlock(content string, markers Block) (string, bool) {
	start, end, ok := findBlock(content, markers)
	if !ok {
		return content, false
	}
	next := content[:start] + content[end:]
	next = strings.TrimRight(next, "\n")
	if next != "" {
		next += "\n"
	}
	return next, next != content
}

// findBlock returns the byte range covering the markers and everything between.
func findBlock(content string, markers Block) (start, end int, ok bool) {
	start = strings.Index(content, markers.Start)
	if start < 0 {
		return 0, 0, false
	}
	after := content[start:]
	rel := strings.Index(after, markers.End)
	if rel < 0 {
		return 0, 0, false
	}
	end = start + rel + len(markers.End)
	return start, end, true
}

// PrependProcessPATH puts dir at the front of this process's PATH when the
// directory exists and is not already there.
//
// This is how a server makes installed tools visible to everything it spawns —
// PTY sessions, git hooks, the gq runner — without touching a single rc file: the
// scope is this process and its children, which is the polite amount of
// surprise. The managed rc block covers shells opened outside Suwu, and
// `suwu exec` covers scripts.
func PrependProcessPATH(dir string) bool {
	if dir == "" {
		return false
	}
	if info, err := os.Stat(dir); err != nil || !info.IsDir() {
		return false
	}
	sep := string(os.PathListSeparator)
	current := os.Getenv("PATH")
	if current == dir || strings.HasPrefix(current, dir+sep) {
		return false
	}
	next := dir
	if current != "" {
		next = dir + sep + current
	}
	return os.Setenv("PATH", next) == nil
}
