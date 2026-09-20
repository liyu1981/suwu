package server

// Read-only snapshot comparisons. Keep the legacy inline-diff API independent.
import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const compareLimit = 4 << 20

// worktreeRef is the pseudo-revision for uncommitted changes. It is not a
// commit, so `loadComparison` resolves it to a `git diff <base>` against the
// working tree instead of going through `resolveCompareCommit`.
const worktreeRef = "WORKTREE"

var errCompareLimit = errors.New("comparison exceeds the output limit")

// Bound stdout while it is produced, not after allocating the entire patch.
type compareOutput struct {
	bytes.Buffer
	limit    int
	cancel   context.CancelFunc
	exceeded bool
}

func (b *compareOutput) Write(p []byte) (int, error) {
	if b.Len()+len(p) > b.limit {
		b.exceeded = true
		b.cancel()
		return 0, errCompareLimit
	}
	return b.Buffer.Write(p)
}
func compareGit(ctx context.Context, repo string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", append([]string{"--no-pager", "--literal-pathspecs", "-C", repo}, args...)...)
	cmd.WaitDelay = time.Second
	out := &compareOutput{limit: compareLimit, cancel: cancel}
	stderr := &compareOutput{limit: 16 << 10, cancel: cancel}
	cmd.Stdout, cmd.Stderr = out, stderr
	if err := cmd.Run(); err != nil {
		if out.exceeded || stderr.exceeded {
			return nil, errCompareLimit
		}
		if ctx.Err() != nil {
			return nil, fmt.Errorf("comparison cancelled or timed out: %w", ctx.Err())
		}
		return nil, errors.New("git could not read this repository or comparison")
	}
	return out.Bytes(), nil
}

func resolveCompareCommit(ctx context.Context, repo, ref string) (string, error) {
	if ref == "" || len(ref) > 1024 || strings.HasPrefix(ref, "-") || strings.ContainsRune(ref, 0) {
		return "", errors.New("invalid commit reference")
	}
	out, err := compareGit(ctx, repo, "rev-parse", "--verify", "--end-of-options", ref+"^{commit}")
	if err != nil {
		return "", errors.New("commit reference not found or ambiguous")
	}
	return strings.TrimSpace(string(out)), nil
}

type compareFile struct {
	ID        string `json:"id"`
	OldPath   string `json:"oldPath"`
	NewPath   string `json:"newPath"`
	Status    string `json:"status"`
	OldMode   string `json:"oldMode"`
	NewMode   string `json:"newMode"`
	Adds      int    `json:"adds"`
	Dels      int    `json:"dels"`
	Binary    bool   `json:"binary"`
	Submodule bool   `json:"submodule"`
}
type gitComparison struct {
	Base    string        `json:"base"`
	Target  string        `json:"target"`
	Parents []string      `json:"parents"`
	Files   []compareFile `json:"files"`
	Adds    int           `json:"adds"`
	Dels    int           `json:"dels"`
}

// Raw and numstat are NUL-delimited: paths can contain tabs, newlines or arrows.
func parseCompareFiles(raw, stats []byte) ([]compareFile, error) {
	files := []compareFile{}
	tokens := strings.Split(string(raw), "\x00")
	for i := 0; i < len(tokens) && tokens[i] != ""; {
		fields := strings.Fields(tokens[i])
		i++
		if len(fields) != 5 || !strings.HasPrefix(fields[0], ":") || i >= len(tokens) {
			return nil, errors.New("invalid Git file metadata")
		}
		f := compareFile{OldMode: strings.TrimPrefix(fields[0], ":"), NewMode: fields[1], Status: fields[4][:1], OldPath: tokens[i], NewPath: tokens[i]}
		i++
		if f.Status == "R" || f.Status == "C" {
			if i >= len(tokens) {
				return nil, errors.New("invalid rename metadata")
			}
			f.NewPath = tokens[i]
			i++
		}
		f.Submodule = f.OldMode == "160000" || f.NewMode == "160000"
		id := sha256.Sum256([]byte(f.OldPath + "\x00" + f.NewPath))
		f.ID = hex.EncodeToString(id[:])
		files = append(files, f)
	}
	byPath := map[string]int{}
	for i, f := range files {
		byPath[f.NewPath] = i
	}
	tokens = strings.Split(string(stats), "\x00")
	for i := 0; i < len(tokens) && tokens[i] != ""; {
		fields := strings.SplitN(tokens[i], "\t", 3)
		i++
		if len(fields) != 3 {
			return nil, errors.New("invalid Git statistics")
		}
		path := fields[2]
		if path == "" {
			if i+1 >= len(tokens) {
				return nil, errors.New("invalid rename statistics")
			}
			path = tokens[i+1]
			i += 2
		}
		if idx, ok := byPath[path]; ok {
			f := &files[idx]
			f.Binary = fields[0] == "-"
			f.Adds, _ = strconv.Atoi(fields[0])
			f.Dels, _ = strconv.Atoi(fields[1])
		}
	}
	return files, nil
}

// Exclude personal environment files before Git computes any diff content.
// Explicit pathspec magic is enabled only for these fixed server-owned patterns.
func compareDiff(ctx context.Context, repo, base, target string, options []string, paths ...string) ([]byte, error) {
	args := []string{"--glob-pathspecs", "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-abbrev", "--find-renames", "-l1000"}
	args = append(args, options...)
	args = append(args, base)
	// An empty target compares the base to the working tree (uncommitted changes).
	if target != "" {
		args = append(args, target)
	}
	if len(paths) == 0 {
		args = append(args, ":(top,glob)**")
	} else {
		for _, p := range paths {
			args = append(args, ":(top,literal)"+p)
		}
	}
	args = append(args, ":(top,exclude,glob)**/.env*", ":(top,exclude,glob).env*")
	// --literal-pathspecs conflicts with magic; use a separate command invocation
	// through compareGit with an explicit --no-literal-pathspecs override.
	return compareGit(ctx, repo, append([]string{"--no-literal-pathspecs"}, args...)...)
}
func loadComparison(ctx context.Context, repo, baseRef, targetRef string, parent int) (*gitComparison, error) {
	if targetRef == worktreeRef {
		return loadWorktreeComparison(ctx, repo, baseRef)
	}
	target, err := resolveCompareCommit(ctx, repo, targetRef)
	if err != nil {
		return nil, err
	}
	out, err := compareGit(ctx, repo, "rev-list", "--parents", "-n", "1", target)
	if err != nil {
		return nil, err
	}
	fields := strings.Fields(string(out))
	parents := []string{}
	if len(fields) > 1 {
		parents = fields[1:]
	}
	base := baseRef
	if base == "" {
		if len(parents) == 0 {
			base = "EMPTY"
		} else {
			if parent < 1 || parent > len(parents) {
				return nil, errors.New("invalid parent selection")
			}
			base = parents[parent-1]
		}
	}
	resolvedBase := base
	if base == "EMPTY" {
		out, err = compareGit(ctx, repo, "hash-object", "-t", "tree", "--stdin")
		resolvedBase = strings.TrimSpace(string(out))
	} else {
		resolvedBase, err = resolveCompareCommit(ctx, repo, base)
	}
	if err != nil {
		return nil, err
	}
	raw, err := compareDiff(ctx, repo, resolvedBase, target, []string{"--raw", "-z"})
	if err != nil {
		return nil, err
	}
	stats, err := compareDiff(ctx, repo, resolvedBase, target, []string{"--numstat", "-z"})
	if err != nil {
		return nil, err
	}
	files, err := parseCompareFiles(raw, stats)
	if err != nil {
		return nil, err
	}
	c := &gitComparison{Base: resolvedBase, Target: target, Parents: parents, Files: files}
	if base == "EMPTY" {
		c.Base = "EMPTY"
	}
	for _, f := range files {
		c.Adds += f.Adds
		c.Dels += f.Dels
	}
	return c, nil
}

// loadWorktreeComparison diffs the base commit against the working tree
// (uncommitted changes). `git diff <base>` with no second revision is the same
// comparison the inline UNCOMMITTED view uses, so untracked files are excluded
// here too.
func loadWorktreeComparison(ctx context.Context, repo, baseRef string) (*gitComparison, error) {
	if baseRef == "" {
		baseRef = "HEAD"
	}
	base, err := resolveCompareCommit(ctx, repo, baseRef)
	if err != nil {
		return nil, err
	}
	raw, err := compareDiff(ctx, repo, base, "", []string{"--raw", "-z"})
	if err != nil {
		return nil, err
	}
	stats, err := compareDiff(ctx, repo, base, "", []string{"--numstat", "-z"})
	if err != nil {
		return nil, err
	}
	files, err := parseCompareFiles(raw, stats)
	if err != nil {
		return nil, err
	}
	c := &gitComparison{Base: base, Target: worktreeRef, Parents: []string{}, Files: files}
	for _, f := range files {
		c.Adds += f.Adds
		c.Dels += f.Dels
	}
	return c, nil
}

// gitTarget maps a comparison's target to a git revision. The worktree
// pseudo-revision becomes an empty second revision: `git diff <base>`.
func gitTarget(c *gitComparison) string {
	if c.Target == worktreeRef {
		return ""
	}
	return c.Target
}

type compareLine struct {
	Kind string `json:"kind"`
	Text string `json:"text"`
	Old  *int   `json:"old"`
	New  *int   `json:"new"`
}
type compareHunk struct {
	Header string        `json:"header"`
	Lines  []compareLine `json:"lines"`
}
type comparePatch struct {
	Hunks   []compareHunk `json:"hunks"`
	Limited bool          `json:"limited"`
}

var compareHunkRE = regexp.MustCompile(`^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@`)

func parseComparePatch(raw []byte) []compareHunk {
	hunks := []compareHunk{}
	oldLine, newLine := 0, 0
	for _, line := range strings.Split(string(raw), "\n") {
		if m := compareHunkRE.FindStringSubmatch(line); m != nil {
			oldLine, _ = strconv.Atoi(m[1])
			newLine, _ = strconv.Atoi(m[2])
			hunks = append(hunks, compareHunk{Header: line, Lines: []compareLine{}})
			continue
		}
		if len(hunks) == 0 || len(line) == 0 {
			continue
		}
		row := compareLine{Text: line[1:]}
		switch line[0] {
		case ' ':
			row.Kind = "context"
			o, n := oldLine, newLine
			row.Old = &o
			row.New = &n
			oldLine++
			newLine++
		case '-':
			row.Kind = "remove"
			o := oldLine
			row.Old = &o
			oldLine++
		case '+':
			row.Kind = "add"
			n := newLine
			row.New = &n
			newLine++
		case '\\':
			row.Kind = "note"
			row.Text = line
		default:
			continue
		}
		idx := len(hunks) - 1
		hunks[idx].Lines = append(hunks[idx].Lines, row)
	}
	return hunks
}
func (s *Server) handleGitCompare(w http.ResponseWriter, r *http.Request) {
	if s.validateRequest(w, r) == "" {
		return
	}
	if r.Method != http.MethodGet {
		writeGitError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}
	q := r.URL.Query()
	repo := q.Get("path")
	if repo == "" {
		writeGitError(w, 400, "Missing repository path")
		return
	}
	parent := 1
	if q.Has("parent") {
		parent, _ = strconv.Atoi(q.Get("parent"))
	}
	c, err := loadComparison(r.Context(), repo, q.Get("base"), q.Get("target"), parent)
	if err != nil {
		code := http.StatusBadRequest
		if errors.Is(err, errCompareLimit) {
			code = http.StatusRequestEntityTooLarge
		}
		writeGitError(w, code, err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if r.URL.Path == "/api/git/compare" {
		json.NewEncoder(w).Encode(c)
		return
	}
	var file *compareFile
	for i := range c.Files {
		if c.Files[i].ID == q.Get("file") {
			file = &c.Files[i]
			break
		}
	}
	if file == nil {
		writeGitError(w, 404, "File not found in comparison")
		return
	}
	patch := comparePatch{Hunks: []compareHunk{}}
	if !file.Binary {
		base := c.Base
		if base == "EMPTY" {
			out, e := compareGit(r.Context(), repo, "hash-object", "-t", "tree", "--stdin")
			if e != nil {
				writeGitError(w, 400, e.Error())
				return
			}
			base = strings.TrimSpace(string(out))
		}
		raw, e := compareDiff(r.Context(), repo, base, gitTarget(c), []string{"--patch", "-U3"}, file.OldPath, file.NewPath)
		if errors.Is(e, errCompareLimit) {
			patch.Limited = true
		} else if e != nil {
			writeGitError(w, 400, e.Error())
			return
		} else {
			patch.Hunks = parseComparePatch(raw)
		}
	}
	json.NewEncoder(w).Encode(patch)
}
