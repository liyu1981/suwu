// Package envfile loads dotenv-style KEY=VALUE files into the process
// environment without external dependencies.
package envfile

import (
	"bufio"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Load reads the dotenv file at path and sets each KEY=VALUE into the process
// environment, but only for keys not already set (existing values win). It is
// a no-op when the file does not exist.
func Load(path string) error {
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	defer f.Close()
	return LoadFrom(f, func(k, v string) {
		if os.Getenv(k) == "" {
			_ = os.Setenv(k, v)
		}
	})
}

// LoadForce reads the dotenv file at path and sets every KEY=VALUE into the
// process environment, overriding any existing values. It is a no-op when
// the file does not exist.
func LoadForce(path string) error {
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	defer f.Close()
	return LoadFrom(f, func(k, v string) {
		_ = os.Setenv(k, v)
	})
}

// Upsert writes keys into the dotenv file at path: existing KEY=VALUE lines
// are updated in place (comments and surrounding lines are preserved) and
// missing keys are appended at the end under a separating blank line. The
// file is created (with parent directories) when absent. Values are written
// bare; when a value contains whitespace, '#', or a quote it is double
// quoted with escaping.
func Upsert(path string, kv map[string]string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	lines, err := readLines(path)
	if err != nil && !os.IsNotExist(err) {
		return err
	}

	updated := make(map[string]bool, len(kv))
	for i, line := range lines {
		key := lineKey(line)
		if key == "" {
			continue
		}
		if v, ok := kv[key]; ok {
			lines[i] = key + "=" + formatValue(v)
			updated[key] = true
		}
	}

	var missing []string
	for k, v := range kv {
		if !updated[k] {
			missing = append(missing, k+"="+formatValue(v))
		}
	}
	sort.Strings(missing)
	if len(missing) > 0 {
		if len(lines) > 0 && strings.TrimSpace(lines[len(lines)-1]) != "" {
			lines = append(lines, "")
		}
		lines = append(lines, missing...)
	}

	return os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o600)
}

func readLines(path string) ([]string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	content := strings.TrimSuffix(string(data), "\n")
	if content == "" {
		return nil, nil
	}
	return strings.Split(content, "\n"), nil
}

// lineKey extracts the variable name of a dotenv line, or "" when the line
// is blank, a comment, or not a KEY=VALUE assignment.
func lineKey(line string) string {
	line = strings.TrimSpace(line)
	if line == "" || strings.HasPrefix(line, "#") {
		return ""
	}
	if rest, ok := strings.CutPrefix(line, "export "); ok {
		line = strings.TrimSpace(rest)
	}
	key, _, found := strings.Cut(line, "=")
	if !found {
		return ""
	}
	return strings.TrimSpace(key)
}

func formatValue(v string) string {
	if strings.ContainsAny(v, " \t#\"'") {
		return `"` + strings.ReplaceAll(v, `"`, `\"`) + `"`
	}
	return v
}

// LoadFrom scans r for dotenv lines and calls set(key, value) for each. It is
// exposed for testing and embedding in larger loaders.
func LoadFrom(r interface {
	Read([]byte) (int, error)
}, set func(k, v string)) error {
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if strings.HasPrefix(line, "export ") {
			line = strings.TrimSpace(strings.TrimPrefix(line, "export "))
		}
		eq := strings.Index(line, "=")
		if eq <= 0 {
			continue
		}
		key := strings.TrimSpace(line[:eq])
		val := unquote(strings.TrimSpace(line[eq+1:]))
		if key == "" {
			continue
		}
		set(key, val)
	}
	return sc.Err()
}

func unquote(s string) string {
	if len(s) >= 2 {
		if s[0] == '"' && s[len(s)-1] == '"' {
			return unescape(s[1 : len(s)-1])
		}
		if s[0] == '\'' && s[len(s)-1] == '\'' {
			return s[1 : len(s)-1]
		}
	}
	return s
}

func unescape(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c == '\\' && i+1 < len(s) {
			i++
			switch s[i] {
			case 'n':
				b.WriteByte('\n')
			case 't':
				b.WriteByte('\t')
			case 'r':
				b.WriteByte('\r')
			case '\\':
				b.WriteByte('\\')
			case '"':
				b.WriteByte('"')
			default:
				b.WriteByte('\\')
				b.WriteByte(s[i])
			}
		} else {
			b.WriteByte(c)
		}
	}
	return b.String()
}
