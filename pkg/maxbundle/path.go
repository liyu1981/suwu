package maxbundle

import (
	"os"
	"path/filepath"
	"strings"
)

const (
	blockStart = "# >>> suwu-max >>>"
	blockEnd   = "# <<< suwu-max <<<"
)

type shellSyntax int

const (
	posixSyntax shellSyntax = iota
	fishSyntax
)

type rcTarget struct {
	file   string
	syntax shellSyntax
}

// EnsurePath adds (or refreshes) a managed block that puts dir on PATH for the
// shells configured on this machine. Only rc files that already exist are
// touched, except that ~/.profile is created when none exist at all. It is
// idempotent and returns the files it changed.
func EnsurePath(dir string) ([]string, error) {
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
		next, didChange := upsertBlock(string(original), renderBlock(target.syntax, display))
		if !didChange {
			continue
		}
		if len(original) > 0 {
			backup := target.file + ".suwu-max.bak"
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

// RemovePath removes the managed block everywhere it is found.
func RemovePath() ([]string, error) {
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
		next, didChange := removeBlock(string(data))
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

func renderBlock(syntax shellSyntax, display string) string {
	if syntax == fishSyntax {
		return strings.Join([]string{
			blockStart,
			`if not contains "` + display + `" $PATH`,
			`    set -gx PATH "` + display + `" $PATH`,
			`end`,
			blockEnd,
		}, "\n")
	}
	return strings.Join([]string{
		blockStart,
		`case ":$PATH:" in *":` + display + `:"*) ;; *) PATH="` + display + `:$PATH" ;; esac`,
		`export PATH`,
		blockEnd,
	}, "\n")
}

// upsertBlock replaces an existing managed block or appends one, returning the
// new content and whether it differs from the original.
func upsertBlock(content, block string) (string, bool) {
	if start, end, ok := findBlock(content); ok {
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

func removeBlock(content string) (string, bool) {
	start, end, ok := findBlock(content)
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
func findBlock(content string) (start, end int, ok bool) {
	start = strings.Index(content, blockStart)
	if start < 0 {
		return 0, 0, false
	}
	after := content[start:]
	rel := strings.Index(after, blockEnd)
	if rel < 0 {
		return 0, 0, false
	}
	end = start + rel + len(blockEnd)
	return start, end, true
}
