package bindir

import (
	"os"
	"path/filepath"
	"strings"
)

// Block is one managed rc-file block: the two marker lines that delimit it.
// Two blocks may coexist in one file (suwu-max adds the app's directory, the
// tools page optionally adds the tool directory), so each has its own markers
// and removing one never disturbs the other.
type Block struct {
	Start string
	End   string
	// Tag names the block in the one-time rc backup (`<file>.<tag>.bak`), so
	// each block keeps its own "before" copy and neither overwrites the other.
	Tag string
}

// MaxBlock is `suwu-max`'s block. It adds ~/.local/bin (where the app lives),
// and under the bootstrap model it no longer adds the tool directory.
var MaxBlock = Block{Start: "# >>> suwu-max >>>", End: "# <<< suwu-max <<<", Tag: "suwu-max"}

// ToolsBlock is the tools page's block, adding the managed tool directory to an
// interactive shell. It is opt-in: Suwu's own sessions get the directory from
// the server's PATH, and `suwu exec` needs no PATH at all.
var ToolsBlock = Block{Start: "# >>> suwu-bin >>>", End: "# <<< suwu-bin <<<", Tag: "suwu-bin"}

type shellSyntax int

const (
	posixSyntax shellSyntax = iota
	fishSyntax
)

type rcTarget struct {
	file   string
	syntax shellSyntax
}

// EnsurePath adds (or refreshes) this block so dir is on PATH for the shells
// configured on this machine. Only rc files that already exist are touched,
// except that ~/.profile is created when none exist at all. It is idempotent
// and returns the files it changed.
func EnsurePath(dir string, block Block) ([]string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	display := displayPath(dir, home)
	var changed []string
	for _, target := range rcTargets(home) {
		original, err := os.ReadFile(target.file)
		if err != nil {
			if !os.IsNotExist(err) {
				return changed, err
			}
			original = nil
		}
		next, didChange := upsertBlock(string(original), renderBlock(target.syntax, display, block), block)
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
		{filepath.Join(home, ".bashrc"), posixSyntax},
		{filepath.Join(home, ".bash_profile"), posixSyntax},
		{filepath.Join(home, ".profile"), posixSyntax},
		{filepath.Join(home, ".zshrc"), posixSyntax},
		{filepath.Join(home, ".zshenv"), posixSyntax},
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

func renderBlock(syntax shellSyntax, display string, block Block) string {
	if syntax == fishSyntax {
		return strings.Join([]string{
			block.Start,
			`if not contains "` + display + `" $PATH`,
			`    set -gx PATH "` + display + `" $PATH`,
			`end`,
			block.End,
		}, "\n")
	}
	return strings.Join([]string{
		block.Start,
		`case ":$PATH:" in *":` + display + `:"*) ;; *) PATH="` + display + `:$PATH" ;; esac`,
		`export PATH`,
		block.End,
	}, "\n")
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
// surprise. `suwu exec` and the opt-in rc block cover the other two cases.
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
