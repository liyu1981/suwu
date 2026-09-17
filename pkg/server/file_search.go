package server

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	searchMaxMatches = 1000
	searchMaxOutput  = 8 * 1024 * 1024
	searchMaxRecord  = 1024 * 1024
)

// Bound concurrent subprocesses across all sessions.
var searchSlots = make(chan struct{}, 2)

type searchRequest struct {
	Query     string `json:"query"`
	Directory string `json:"directory"`
	Extension string `json:"extension"`
}

type searchMatch struct {
	Line         int    `json:"line"`
	Column       int    `json:"column"`
	EndLine      int    `json:"endLine"`
	EndColumn    int    `json:"endColumn"`
	Preview      string `json:"preview"`
	PreviewStart int    `json:"previewStart"`
	PreviewEnd   int    `json:"previewEnd"`
}

type searchFile struct {
	Path         string        `json:"path"`
	RelativePath string        `json:"relativePath"`
	Matches      []searchMatch `json:"matches"`
}

type searchResponse struct {
	Directory       string       `json:"directory"`
	Files           []searchFile `json:"files"`
	ReturnedMatches int          `json:"returnedMatches"`
	Truncated       bool         `json:"truncated"`
	Warnings        []string     `json:"warnings"`
}

type rgText struct {
	Text  *string `json:"text"`
	Bytes *string `json:"bytes"`
}

type rgEvent struct {
	Type string `json:"type"`
	Data struct {
		Path       rgText `json:"path"`
		Lines      rgText `json:"lines"`
		LineNumber int    `json:"line_number"`
		Submatches []struct {
			Start int `json:"start"`
			End   int `json:"end"`
		} `json:"submatches"`
	} `json:"data"`
}

// POST /api/files/search. Searches disk, never editor buffers. No shell or
// user-supplied flags are involved, and ripgrep configuration is disabled.
func (s *Server) handleFileSearch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method Not Allowed"})
		return
	}
	if s.validateRequest(w, r) == "" {
		return
	}
	var req searchRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 32*1024))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid search request"})
		return
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF || req.Query == "" || len(req.Query) > 4096 || strings.ContainsRune(req.Query, 0) || !utf8.ValidString(req.Query) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Search text must be nonempty UTF-8, at most 4096 bytes, without NUL characters"})
		return
	}
	extension, err := normalizeSearchExtension(req.Extension)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if !filepath.IsAbs(req.Directory) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Choose an absolute directory path"})
		return
	}
	dir := filepath.Clean(req.Directory)
	info, err := os.Stat(dir)
	if err != nil || !info.IsDir() {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Directory does not exist or is not accessible"})
		return
	}
	select {
	case searchSlots <- struct{}{}:
		defer func() { <-searchSlots }()
	default:
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "Too many searches; try again shortly"})
		return
	}
	rg, err := exec.LookPath("rg")
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "ripgrep (rg) is not installed on the server"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	result, err := runFileSearch(ctx, rg, dir, req.Query, extension)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Could not start ripgrep search"})
		return
	}
	writeJSON(w, http.StatusOK, result)
}

var searchExtensionPattern = regexp.MustCompile(`^[A-Za-z0-9_+\-]+(\.[A-Za-z0-9_+\-]+)*$`)

// Accept one literal suffix, with an optional leading dot; never a glob or flag.
func normalizeSearchExtension(raw string) (string, error) {
	extension := strings.TrimSpace(raw)
	if extension == "" {
		return "", nil
	}
	extension = strings.TrimPrefix(extension, ".")
	if len(extension) > 64 || !searchExtensionPattern.MatchString(extension) {
		return "", errors.New("Enter one file extension, such as ts or .tsx, or leave blank for all extensions")
	}
	return extension, nil
}

func searchArgs(query, extension string) []string {
	args := []string{"--json", "--no-config", "--case-sensitive", "--color=never", "--max-filesize=2M", "--glob=!.env", "--glob=!.env.*", "--glob=!**/.*"}
	if extension != "" {
		// A type filter narrows files without overriding ignore rules, unlike
		// a positive --glob. Explicit hidden-path exclusion above also applies
		// because type filters can otherwise admit hidden files.
		args = append(args, "--type-add=suwuoccurrence:*."+extension, "--type=suwuoccurrence")
	}
	// Newlines in -F patterns mean alternatives in rg, not a contiguous
	// selection. Escape all regex metacharacters and explicitly join lines.
	if strings.Contains(query, "\n") {
		parts := strings.Split(strings.ReplaceAll(query, "\r\n", "\n"), "\n")
		for i := range parts {
			parts[i] = regexp.QuoteMeta(parts[i])
		}
		query = strings.Join(parts, `\r?\n`)
		args = append(args, "--multiline")
	} else {
		args = append(args, "--fixed-strings")
	}
	return append(args, "-e", query, "--", ".")
}

func runFileSearch(ctx context.Context, executable, dir, query, extension string) (searchResponse, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	cmd := exec.CommandContext(ctx, executable, searchArgs(query, extension)...)
	cmd.Dir = dir
	cmd.Stderr = io.Discard // Do not accumulate unbounded diagnostics or leak paths.
	cmd.WaitDelay = time.Second
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return searchResponse{}, err
	}
	if err = cmd.Start(); err != nil {
		return searchResponse{}, err
	}
	result := parseSearchOutput(stdout, dir)
	if result.Truncated {
		cancel()
	}
	err = cmd.Wait()
	if ctx.Err() != nil && !result.Truncated {
		result.Truncated = true
		result.Warnings = append(result.Warnings, "timeout")
	} else if err != nil && !result.Truncated {
		var exit *exec.ExitError
		if !errors.As(err, &exit) || exit.ExitCode() != 1 {
			result.Truncated = true
			result.Warnings = append(result.Warnings, "searchError")
		}
	}
	return result, nil
}

func parseSearchOutput(reader io.Reader, dir string) searchResponse {
	result := searchResponse{Directory: dir, Files: []searchFile{}, Warnings: []string{}}
	files := make(map[string]int)
	warnings := make(map[string]bool)
	warn := func(code string) {
		if !warnings[code] {
			result.Warnings = append(result.Warnings, code)
			warnings[code] = true
		}
	}
	scanner := bufio.NewScanner(io.LimitReader(reader, searchMaxOutput+1))
	scanner.Buffer(make([]byte, 4096), searchMaxRecord)
	consumed := 0
	for scanner.Scan() {
		consumed += len(scanner.Bytes()) + 1
		if consumed > searchMaxOutput {
			result.Truncated = true
			warn("outputLimit")
			break
		}
		var event rgEvent
		if json.Unmarshal(scanner.Bytes(), &event) != nil {
			result.Truncated = true
			warn("invalidOutput")
			break
		}
		if event.Type != "match" {
			continue
		}
		data := event.Data
		// rg's bytes variant denotes non-UTF-8 input. The file API and Monaco
		// use UTF-8 paths/content, so skip explicitly rather than corrupt it.
		if data.Path.Text == nil || data.Lines.Text == nil || !utf8.ValidString(*data.Path.Text) || !utf8.ValidString(*data.Lines.Text) {
			warn("unsupportedEncoding")
			continue
		}
		path := filepath.Clean(filepath.Join(dir, *data.Path.Text))
		rel, err := filepath.Rel(dir, path)
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			warn("invalidOutput")
			continue
		}
		text := *data.Lines.Text
		for _, sub := range data.Submatches {
			if sub.Start < 0 || sub.End < sub.Start || sub.End > len(text) || data.LineNumber < 1 {
				warn("invalidOutput")
				continue
			}
			if result.ReturnedMatches >= searchMaxMatches {
				result.Truncated = true
				warn("matchLimit")
				break
			}
			line, column := searchPosition(text, sub.Start, data.LineNumber)
			endLine, endColumn := searchPosition(text, sub.End, data.LineNumber)
			preview, start, end := searchPreview(text, sub.Start, sub.End)
			idx, exists := files[path]
			if !exists {
				idx = len(result.Files)
				files[path] = idx
				result.Files = append(result.Files, searchFile{Path: path, RelativePath: rel, Matches: []searchMatch{}})
			}
			result.Files[idx].Matches = append(result.Files[idx].Matches, searchMatch{line, column, endLine, endColumn, preview, start, end})
			result.ReturnedMatches++
		}
		if result.Truncated {
			break
		}
	}
	if scanner.Err() != nil {
		result.Truncated = true
		warn("outputLimit")
	}
	sort.Slice(result.Files, func(i, j int) bool { return result.Files[i].RelativePath < result.Files[j].RelativePath })
	return result
}

// rg offsets count UTF-8 bytes; Monaco columns and JS slices count UTF-16 units.
func searchPosition(text string, offset, firstLine int) (int, int) {
	line, column := firstLine, 1
	for _, r := range text[:offset] {
		if r == '\n' {
			line++
			column = 1
		} else if r != '\r' {
			column++
			if r > 0xffff {
				column++
			}
		}
	}
	return line, column
}

func searchPreview(text string, start, end int) (string, int, int) {
	left := strings.LastIndex(text[:start], "\n") + 1
	right := len(text)
	if next := strings.IndexByte(text[start:], '\n'); next >= 0 {
		right = start + next
	}
	// Keep previews bounded and centered near the occurrence, not the line start.
	if start-left > 160 {
		left = start - 160
		for left < start && !utf8.RuneStart(text[left]) {
			left++
		}
	}
	if right-start > 400 {
		right = start + 400
		for right > start && !utf8.RuneStart(text[right]) {
			right--
		}
	}
	preview := strings.TrimSuffix(text[left:right], "\r")
	_, col := searchPosition(text[left:start], start-left, 1)
	stop := min(end, left+len(preview))
	_, endCol := searchPosition(text[left:stop], stop-left, 1)
	return preview, col - 1, endCol - 1
}
