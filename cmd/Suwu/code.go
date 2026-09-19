package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"suwu/pkg/notify"
)

// codeAction is the JSON payload sent by `suwu code`.
type codeAction struct {
	Action  string      `json:"action"`
	Payload codePayload `json:"payload"`
}

type codePayload struct {
	Type  string     `json:"type"`
	Files []codeFile `json:"files"`
	// Dir is the Code Explorer's default directory: the first file's base
	// directory for `suwu code <files>`, or the directory itself for
	// `suwu code <dir>`.
	Dir string `json:"dir,omitempty"`
}

type codeFile struct {
	Path   string      `json:"path"`
	Ranges []codeRange `json:"ranges,omitempty"`
}

type codeRange struct {
	Start int `json:"start"`
	End   int `json:"end"`
}

var codeRangeRe = regexp.MustCompile(`^(\d+)(?:-(\d+))?$`)

// parseCodeSpec splits "path[:50-55,40-41]" into the path and its highlight
// ranges. A ':' suffix that is not a valid range list is treated as part of the
// path, so paths containing a colon still work.
func parseCodeSpec(spec string) (string, []codeRange, error) {
	path := spec
	var ranges []codeRange

	if idx := strings.LastIndex(spec, ":"); idx > 0 {
		suffix := spec[idx+1:]
		// A suffix that starts with a digit is an attempted range list; an
		// invalid one is an error rather than being folded back into the path.
		if isDigit(suffix) {
			parsed, err := parseCodeRanges(suffix)
			if err != nil {
				return "", nil, err
			}
			path = spec[:idx]
			ranges = parsed
		}
	}

	if path == "" {
		return "", nil, fmt.Errorf("empty file path")
	}
	return path, ranges, nil
}

func isDigit(s string) bool {
	return len(s) > 0 && s[0] >= '0' && s[0] <= '9'
}

func parseCodeRanges(spec string) ([]codeRange, error) {
	if spec == "" {
		return nil, fmt.Errorf("empty range list")
	}
	parts := strings.Split(spec, ",")
	ranges := make([]codeRange, 0, len(parts))
	for _, part := range parts {
		match := codeRangeRe.FindStringSubmatch(strings.TrimSpace(part))
		if match == nil {
			return nil, fmt.Errorf("invalid range %q", part)
		}
		start, err := strconv.Atoi(match[1])
		if err != nil || start < 1 {
			return nil, fmt.Errorf("invalid start line in %q", part)
		}
		end := start
		if match[2] != "" {
			end, err = strconv.Atoi(match[2])
			if err != nil || end < start {
				return nil, fmt.Errorf("invalid end line in %q", part)
			}
		}
		ranges = append(ranges, codeRange{Start: start, End: end})
	}
	return ranges, nil
}

func codeMain(args []string) error {
	fs := flag.NewFlagSet("code", flag.ContinueOnError)
	sock := fs.String("sock", "", "path to the notify socket (default ~/.suwu/suwu.sock, or $SUWU_SOCK_PATH)")
	if err := fs.Parse(args); err != nil {
		return err
	}

	if fs.NArg() == 0 {
		return fmt.Errorf("usage: suwu code [--sock <path>] <path[:start[-end][,start[-end]]...]>... | <dir>")
	}

	files, defaultDir, err := resolveCodeTarget(fs.Args())
	if err != nil {
		return err
	}

	action := codeAction{
		Action: "code",
		Payload: codePayload{
			Type:  "code",
			Files: files,
			Dir:   defaultDir,
		},
	}

	data, err := json.Marshal(action)
	if err != nil {
		return fmt.Errorf("marshal action: %w", err)
	}

	sockPath, err := resolveSockPath(*sock)
	if err != nil {
		return err
	}

	summary := codeSummary(files)
	if summary == "" {
		summary = defaultDir
	}

	n := notify.Notification{
		Message: fmt.Sprintf("Code: %s", summary),
		Data:    data,
	}
	nJSON, err := json.Marshal(n)
	if err != nil {
		return fmt.Errorf("marshal notification: %w", err)
	}

	if err := notify.Send(sockPath, string(nJSON)); err != nil {
		return err
	}
	fmt.Printf("Code: %s\n", summary)
	return nil
}

// resolveSpec parses one CLI argument into an absolute path, its highlight
// ranges, and whether the path is a directory.
func resolveSpec(spec string) (string, []codeRange, bool, error) {
	rawPath, ranges, err := parseCodeSpec(spec)
	if err != nil {
		return "", nil, false, fmt.Errorf("%s: %w", spec, err)
	}
	absPath, err := filepath.Abs(rawPath)
	if err != nil {
		return "", nil, false, fmt.Errorf("resolve path %s: %w", rawPath, err)
	}
	info, err := os.Stat(absPath)
	if err != nil {
		return "", nil, false, fmt.Errorf("stat %s: %w", absPath, err)
	}
	return absPath, ranges, info.IsDir(), nil
}

// resolveCodeTarget turns CLI specs into the files to open plus the Code
// Explorer's default directory. A single directory argument opens the explorer
// rooted there with no files — "." is simply the current directory. File
// arguments open as tabs, with the first file's base directory as the default.
func resolveCodeTarget(specs []string) ([]codeFile, string, error) {
	if len(specs) == 1 {
		absPath, ranges, isDir, err := resolveSpec(specs[0])
		if err != nil {
			return nil, "", err
		}
		if isDir && len(ranges) == 0 {
			return []codeFile{}, absPath, nil
		}
	}

	files := make([]codeFile, 0, len(specs))
	for _, spec := range specs {
		absPath, ranges, isDir, err := resolveSpec(spec)
		if err != nil {
			return nil, "", err
		}
		if isDir {
			return nil, "", fmt.Errorf("%s is a directory", absPath)
		}
		files = append(files, codeFile{Path: absPath, Ranges: ranges})
	}

	// Default dir is the first file's base directory.
	return files, filepath.Dir(files[0].Path), nil
}

func codeSummary(files []codeFile) string {
	names := make([]string, 0, len(files))
	for _, file := range files {
		name := filepath.Base(file.Path)
		if len(file.Ranges) > 0 {
			name = fmt.Sprintf("%s (%d)", name, len(file.Ranges))
		}
		names = append(names, name)
	}
	return strings.Join(names, ", ")
}
