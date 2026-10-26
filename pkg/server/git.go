// Git API handlers for the git graph visualization
package server

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// GitCommit represents a commit in the git graph
type GitCommit struct {
	Hash    string      `json:"hash"`
	Parents []string    `json:"parents"`
	Author  string      `json:"author"`
	Date    int64       `json:"date"`
	Message string      `json:"message"`
	Heads   []string    `json:"heads"`
	Tags    []GitTag    `json:"tags"`
	Remotes []GitRemote `json:"remotes"`
	Stash   *GitStash   `json:"stash"`
}

// GitTag represents a git tag
type GitTag struct {
	Name      string `json:"name"`
	Annotated bool   `json:"annotated"`
}

// GitRemote represents a remote branch reference
type GitRemote struct {
	Name   string `json:"name"`
	Remote string `json:"remote"`
}

// GitStash represents a git stash entry
type GitStash struct {
	Hash     string `json:"hash"`
	BaseHash string `json:"baseHash"`
	Selector string `json:"selector"`
	Message  string `json:"message"`
}

// GitPushBranch describes one local branch that could carry a commit to a
// remote. Upstream/Remote/RemoteBranch are empty when the branch does not track
// a remote.
type GitPushBranch struct {
	Name         string `json:"name"`
	Tip          string `json:"tip"`
	TipMatches   bool   `json:"tipMatches"`
	Current      bool   `json:"current"`
	Contains     bool   `json:"contains"`
	Upstream     string `json:"upstream"`
	Remote       string `json:"remote"`
	RemoteBranch string `json:"remoteBranch"`
}

// GitPushSuggestion is the default push target for a commit.
type GitPushSuggestion struct {
	// LocalBranch to push (empty when the commit is on no local branch).
	LocalBranch string `json:"localBranch"`
	Remote      string `json:"remote"`
	// RemoteBranch is the remote-tracking branch, or the suggested new name.
	RemoteBranch string `json:"remoteBranch"`
	// Tracking reports whether the suggestion comes from a configured upstream,
	// in which case no dialog is needed.
	Tracking bool   `json:"tracking"`
	Reason   string `json:"reason"`
}

// GitPushInfo describes how a commit can be pushed to a remote.
type GitPushInfo struct {
	Hash          string            `json:"hash"`
	CurrentBranch string            `json:"currentBranch"`
	Branches      []GitPushBranch   `json:"branches"`
	Remotes       []string          `json:"remotes"`
	Suggested     GitPushSuggestion `json:"suggested"`
}

// GitCommitDetails represents detailed commit information
type GitCommitDetails struct {
	GitCommit
	Committer     string          `json:"committer"`
	CommitterDate int64           `json:"committerDate"`
	Body          string          `json:"body"`
	FileChanges   []GitFileChange `json:"fileChanges"`
}

// GitFileChange represents a file change in a commit
type GitFileChange struct {
	OldPath string `json:"oldPath"`
	NewPath string `json:"newPath"`
	Type    string `json:"type"`
	Adds    int    `json:"adds"`
	Dels    int    `json:"dels"`
}

// GitGraphResponse is the response for the git graph API
type GitGraphResponse struct {
	Commits []GitCommit `json:"commits"`
	Head    string      `json:"head"`
}

// GitWorktree represents a git worktree
type GitWorktree struct {
	Path       string `json:"path"`
	Head       string `json:"head"`
	Branch     string `json:"branch"`
	IsMain     bool   `json:"isMain"`
	Ahead      int    `json:"ahead"`
	Behind     int    `json:"behind"`
	LastActive int64  `json:"lastActive"` // unix millis of most recent commit
}

// GitWorktreesResponse is the response for the git worktrees API
type GitWorktreesResponse struct {
	Worktrees []GitWorktree `json:"worktrees"`
}

// writeGitError writes a JSON error response with a human-readable message.
func writeGitError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

// isGitRepo checks if the given path contains a .git directory (strict check).
func isGitRepo(path string) bool {
	gitDir := filepath.Join(path, ".git")
	info, err := os.Stat(gitDir)
	if err != nil {
		return false
	}
	return info.IsDir()
}

// userToolDirs are user-scoped bin directories, relative to $HOME, that
// commonly hold tools git shells out to: git-lfs (invoked by the pre-push
// hook and the clean/smudge filters), credential helpers and ssh wrappers.
// A server started by systemd inherits a minimal PATH that omits them, which
// makes git report "git-lfs was not found on your path" even when the user
// has it installed.
var userToolDirs = []string{".local/bin", "bin", ".cargo/bin", ".asdf/shims", ".bun/bin"}

// systemToolDirs are fallback locations for user-installed tooling that is not
// on the inherited PATH (Homebrew on Apple Silicon, Linuxbrew).
var systemToolDirs = []string{"/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"}

// prependPathDirs returns the PATH value made of dirs first, then the entries
// of current that are not already present. Empty entries are dropped: in a
// POSIX PATH an empty entry means the current directory, which we never want.
func prependPathDirs(dirs []string, current string) string {
	seen := make(map[string]bool, len(dirs)+8)
	out := make([]string, 0, len(dirs)+8)
	add := func(dir string) {
		if dir == "" || seen[dir] {
			return
		}
		seen[dir] = true
		out = append(out, dir)
	}
	for _, dir := range dirs {
		add(dir)
	}
	for _, dir := range strings.Split(current, string(os.PathListSeparator)) {
		add(dir)
	}
	return strings.Join(out, string(os.PathListSeparator))
}

// gitEnv returns the process environment with PATH extended by the user tool
// directories that exist on disk, so git and the hooks it runs can find tools
// like git-lfs regardless of how suwu was launched.
func gitEnv() []string {
	env := os.Environ()
	extra := make([]string, 0, len(userToolDirs)+len(systemToolDirs))
	if home, err := os.UserHomeDir(); err == nil {
		for _, rel := range userToolDirs {
			dir := filepath.Join(home, rel)
			if info, err := os.Stat(dir); err == nil && info.IsDir() {
				extra = append(extra, dir)
			}
		}
	}
	extra = append(extra, systemToolDirs...)
	entry := "PATH=" + prependPathDirs(extra, os.Getenv("PATH"))

	for i, kv := range env {
		if strings.HasPrefix(kv, "PATH=") {
			env[i] = entry
			return env
		}
	}
	return append(env, entry)
}

// newGitCmd builds a git command rooted at repoPath, running with gitEnv so
// hooks and filters (git-lfs) resolve.
func newGitCmd(repoPath string, args ...string) *exec.Cmd {
	cmd := exec.Command("git", append([]string{"-C", repoPath}, args...)...)
	cmd.Env = gitEnv()
	return cmd
}

// git runs a git command and returns combined stdout+stderr, or a friendly error.
func git(repoPath string, args ...string) (string, error) {
	// Strict check: only allow if the path itself contains .git
	if !isGitRepo(repoPath) {
		return "", fmt.Errorf("'%s' is not a git repository (no .git folder found)", repoPath)
	}
	cmd := newGitCmd(repoPath, args...)
	out, err := cmd.CombinedOutput()
	msg := strings.TrimSpace(string(out))
	if err != nil {
		if msg == "" {
			msg = err.Error()
		}
		// Downcast common git errors to something a user can act on.
		switch {
		case strings.Contains(msg, "not a git repository"):
			return "", fmt.Errorf("'%s' is not a git repository", repoPath)
		case strings.Contains(msg, "does not have any commits"):
			return "", fmt.Errorf("'%s' is an empty repository (no commits yet)", repoPath)
		case strings.Contains(msg, "unknown revision"):
			return "", fmt.Errorf("branch or revision %q was not found", strings.Join(args, " "))
		default:
			return "", fmt.Errorf("%s", msg)
		}
	}
	return msg, nil
}

// handleGitCommits handles GET /api/git/commits
func (s *Server) handleGitCommits(w http.ResponseWriter, r *http.Request) {
	if s.validateRequest(w, r) == "" {
		return
	}

	if r.Method != http.MethodGet {
		writeGitError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}

	repoPath := r.URL.Query().Get("path")
	if repoPath == "" {
		repoPath = "."
	}

	countStr := r.URL.Query().Get("count")
	count := 100
	if countStr != "" {
		if c, err := strconv.Atoi(countStr); err == nil && c > 0 {
			count = c
		}
	}

	skipStr := r.URL.Query().Get("skip")
	skip := 0
	if skipStr != "" {
		if s, err := strconv.Atoi(skipStr); err == nil && s >= 0 {
			skip = s
		}
	}

	branch := r.URL.Query().Get("branch")
	if branch == "" {
		branch = "HEAD"
	}

	// base: when provided, show only commits on branch not in base (worktree diff mode)
	base := r.URL.Query().Get("base")
	logBranch := branch
	if base != "" {
		logBranch = base + ".." + branch
	}
	// all: when true, include commits from all branches (git log --all).
	all := r.URL.Query().Get("all") == "true"
	// The frontend counts the UNCOMMITTED entry (prepended on first load) in
	// commits.length, so skip is off by 1 on subsequent loads. Adjust here.
	if skip > 0 {
		skip--
	}

	commits, head, err := getGitCommits(repoPath, logBranch, count, skip, all)
	if err != nil {
		slog.Error("failed to get git commits", "error", err, "path", repoPath)
		writeGitError(w, http.StatusBadRequest, err.Error())
		return
	}

	// Check for uncommitted changes and prepend if present
	uncommittedCount := 0
	if statusOut, err := git(repoPath, "status", "--untracked-files=all", "--porcelain"); err == nil {
		lines := strings.Split(strings.TrimSpace(statusOut), "\n")
		if len(lines) > 0 && lines[0] != "" {
			uncommittedCount = len(lines)
		}
	}

	if uncommittedCount > 0 && skip == 0 && head != "" {
		commits = append([]GitCommit{{
			Hash:    "UNCOMMITTED",
			Parents: []string{head},
			Author:  "*",
			Date:    time.Now().UnixMilli(),
			Message: fmt.Sprintf("Uncommitted Changes (%d)", uncommittedCount),
			Heads:   []string{},
			Tags:    []GitTag{},
			Remotes: []GitRemote{},
			Stash:   nil,
		}}, commits...)
	}

	resp := GitGraphResponse{
		Commits: commits,
		Head:    head,
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

// handleGitWorktrees handles GET /api/git/worktrees
func (s *Server) handleGitWorktrees(w http.ResponseWriter, r *http.Request) {
	if s.validateRequest(w, r) == "" {
		return
	}

	if r.Method != http.MethodGet {
		writeGitError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}

	repoPath := r.URL.Query().Get("path")
	if repoPath == "" {
		repoPath = "."
	}

	worktrees, err := getGitWorktrees(repoPath)
	if err != nil {
		slog.Error("failed to get git worktrees", "error", err, "path", repoPath)
		writeGitError(w, http.StatusBadRequest, err.Error())
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(GitWorktreesResponse{Worktrees: worktrees})
}

// getGitWorktrees lists all worktrees and computes ahead/behind vs main
func getGitWorktrees(repoPath string) ([]GitWorktree, error) {
	output, err := git(repoPath, "worktree", "list", "--porcelain")
	if err != nil {
		return nil, err
	}

	// Parse porcelain output: blocks separated by blank lines
	// Each block has lines like: worktree /path, HEAD hash, branch refs/heads/xxx
	var raw []struct {
		path   string
		head   string
		branch string
	}

	current := struct {
		path   string
		head   string
		branch string
	}{}

	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			if current.path != "" {
				raw = append(raw, current)
				current = struct {
					path   string
					head   string
					branch string
				}{}
			}
			continue
		}
		if strings.HasPrefix(line, "worktree ") {
			current.path = strings.TrimPrefix(line, "worktree ")
			current.path = strings.TrimRight(current.path, "'\" ")
		} else if strings.HasPrefix(line, "HEAD ") {
			current.head = strings.TrimPrefix(line, "HEAD ")
			current.head = strings.TrimRight(current.head, "'\" ")
		} else if strings.HasPrefix(line, "branch ") {
			// branch refs/heads/feature-x
			ref := strings.TrimPrefix(line, "branch ")
			ref = strings.TrimRight(ref, "'\" ")
			current.branch = strings.TrimPrefix(ref, "refs/heads/")
		}
	}
	if current.path != "" {
		raw = append(raw, current)
	}

	if len(raw) == 0 {
		return nil, fmt.Errorf("no worktrees found")
	}

	// Find the main worktree (the one matching repoPath, or the first one)
	mainIdx := 0
	mainPath := ""
	for i, wt := range raw {
		// Normalize paths for comparison
		if wt.path == repoPath || strings.TrimSuffix(wt.path, "/") == strings.TrimSuffix(repoPath, "/") {
			mainIdx = i
			mainPath = wt.path
			break
		}
	}
	if mainPath == "" {
		mainPath = raw[0].path
		mainIdx = 0
	}

	// Get main branch name
	mainBranch := raw[mainIdx].branch
	if mainBranch == "" {
		// fallback: try to resolve main branch name
		if out, err := git(mainPath, "symbolic-ref", "--short", "HEAD"); err == nil {
			mainBranch = strings.TrimSpace(out)
		}
	}
	if mainBranch == "" {
		mainBranch = "HEAD"
	}

	// Build result with ahead/behind counts and last active time
	var worktrees []GitWorktree
	for i, wt := range raw {
		isMain := i == mainIdx
		ahead, behind := 0, 0

		if !isMain && mainBranch != "" {
			// Count commits ahead: main..worktree
			if out, err := git(wt.path, "rev-list", "--count", mainBranch+"..HEAD"); err == nil {
				ahead, _ = strconv.Atoi(strings.TrimSpace(out))
			}
			// Count commits behind: worktree..main
			if out, err := git(wt.path, "rev-list", "--count", "HEAD.."+mainBranch); err == nil {
				behind, _ = strconv.Atoi(strings.TrimSpace(out))
			}
		}

		// Get last commit time
		var lastActive int64
		if logOut, err := git(wt.path, "log", "-1", "--format=%aI", "HEAD"); err == nil {
			if t, err := time.Parse(time.RFC3339, strings.TrimSpace(logOut)); err == nil {
				lastActive = t.UnixMilli()
			}
		}

		worktrees = append(worktrees, GitWorktree{
			Path:       wt.path,
			Head:       wt.head,
			Branch:     wt.branch,
			IsMain:     isMain,
			Ahead:      ahead,
			Behind:     behind,
			LastActive: lastActive,
		})
	}

	return worktrees, nil
}

// handleGitCommitDetails handles GET /api/git/commit
func (s *Server) handleGitCommitDetails(w http.ResponseWriter, r *http.Request) {
	if s.validateRequest(w, r) == "" {
		return
	}

	if r.Method != http.MethodGet {
		writeGitError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}

	repoPath := r.URL.Query().Get("path")
	if repoPath == "" {
		repoPath = "."
	}

	hash := r.URL.Query().Get("hash")
	if hash == "" {
		writeGitError(w, http.StatusBadRequest, "Missing hash parameter")
		return
	}

	// Handle uncommitted changes specially
	if hash == "UNCOMMITTED" {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"hash":        "UNCOMMITTED",
			"parents":     []string{},
			"author":      "*",
			"date":        time.Now().UnixMilli(),
			"committer":   "*",
			"message":     "Uncommitted Changes",
			"body":        "",
			"fileChanges": getUncommittedFileChanges(repoPath),
		})
		return
	}

	details, err := getGitCommitDetails(repoPath, hash)
	if err != nil {
		slog.Error("failed to get commit details", "error", err, "hash", hash)
		writeGitError(w, http.StatusBadRequest, err.Error())
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(details)
}

// handleGitBranches handles GET /api/git/branches
func (s *Server) handleGitBranches(w http.ResponseWriter, r *http.Request) {
	if s.validateRequest(w, r) == "" {
		return
	}

	if r.Method != http.MethodGet {
		writeGitError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}

	repoPath := r.URL.Query().Get("path")
	if repoPath == "" {
		repoPath = "."
	}

	branches, current, err := getGitBranches(repoPath)
	if err != nil {
		slog.Error("failed to get git branches", "error", err, "path", repoPath)
		writeGitError(w, http.StatusBadRequest, err.Error())
		return
	}

	resp := map[string]interface{}{
		"branches": branches,
		"current":  current,
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

// handleGitPushInfo handles GET /api/git/push-info — where a commit would be
// pushed (its tracking branch, or a suggested remote branch).
func (s *Server) handleGitPushInfo(w http.ResponseWriter, r *http.Request) {
	if s.validateRequest(w, r) == "" {
		return
	}
	if r.Method != http.MethodGet {
		writeGitError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}

	repoPath := r.URL.Query().Get("path")
	if repoPath == "" {
		repoPath = "."
	}
	hash := strings.TrimSpace(r.URL.Query().Get("hash"))

	info, err := getGitPushInfo(repoPath, hash)
	if err != nil {
		slog.Error("failed to get push info", "error", err, "path", repoPath, "hash", hash)
		writeGitError(w, http.StatusBadRequest, err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(info)
}

// getGitCommits fetches commits from a git repository
func getGitCommits(repoPath, branch string, maxCount, skip int, all bool) ([]GitCommit, string, error) {
	// Validate the repository is reachable, then fetch commits
	logArgs := []string{"log",
		"--format=%H|%P|%an|%ae|%aI|%s",
	}

	// When using range notation (A..B), --skip doesn't paginate correctly.
	// Workaround: fetch skip+count, then drop the first skip entries in Go.
	if skip > 0 && strings.Contains(branch, "..") {
		logArgs = append(logArgs, "--max-count="+strconv.Itoa(skip+maxCount))
	} else {
		logArgs = append(logArgs, "--max-count="+strconv.Itoa(maxCount))
		if skip > 0 {
			logArgs = append(logArgs, "--skip="+strconv.Itoa(skip))
		}
	}
	// --all: include commits from every local and remote-tracking branch,
	// not just those reachable from the selected branch ("all branches" view).
	if all {
		logArgs = append(logArgs, "--all")
	}
	logArgs = append(logArgs, branch)

	output, err := git(repoPath, logArgs...)
	if err != nil {
		return nil, "", err
	}

	// Get HEAD
	headOut, err := git(repoPath, "rev-parse", "HEAD")
	head := headOut
	if err != nil {
		head = ""
	}

	// Get branch names mapped to commit hashes
	branches := map[string][]string{}
	if out, err := git(repoPath, "branch", "--format=%(objectname)|%(refname:short)"); err == nil {
		for _, line := range strings.Split(out, "\n") {
			if line == "" {
				continue
			}
			parts := strings.SplitN(line, "|", 2)
			if len(parts) == 2 {
				branches[parts[0]] = append(branches[parts[0]], parts[1])
			}
		}
	}
	if out, err := git(repoPath, "branch", "-r", "--format=%(objectname)|%(refname:short)"); err == nil {
		for _, line := range strings.Split(out, "\n") {
			if line == "" {
				continue
			}
			parts := strings.SplitN(line, "|", 2)
			if len(parts) == 2 {
				branches[parts[0]] = append(branches[parts[0]], parts[1])
			}
		}
	}

	// Get tags mapped to commit hashes
	tags := map[string]GitTag{}
	if out, err := git(repoPath, "tag", "--format=%(objectname)|%(refname:short)|%(objecttype)"); err == nil {
		for _, line := range strings.Split(out, "\n") {
			if line == "" {
				continue
			}
			parts := strings.SplitN(line, "|", 3)
			if len(parts) >= 2 {
				tags[parts[0]] = GitTag{
					Name:      parts[1],
					Annotated: len(parts) > 2 && parts[2] == "tag",
				}
			}
		}
	}

	// Get stashes matched to commits
	stashList := []GitStash{}
	if stashOut, err := git(repoPath, "stash", "list", "--format=%H|%P|%gd|%gs"); err == nil {
		for _, line := range strings.Split(stashOut, "\n") {
			if line == "" {
				continue
			}
			parts := strings.SplitN(line, "|", 4)
			if len(parts) >= 4 {
				stashList = append(stashList, GitStash{
					Hash:     parts[0],
					BaseHash: parts[1],
					Selector: parts[2],
					Message:  parts[3],
				})
			}
		}
	}

	// Parse commit lines
	var commits []GitCommit
	for _, line := range strings.Split(output, "\n") {
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "|", 6)
		if len(parts) < 6 {
			continue
		}
		hash := parts[0]
		parents := []string{}
		if parts[1] != "" {
			parents = strings.Split(parts[1], " ")
		}
		date, _ := time.Parse(time.RFC3339, parts[4])

		commitTags := []GitTag{}
		if tag, ok := tags[hash]; ok {
			commitTags = append(commitTags, tag)
		}

		heads := []string{}
		if hs, ok := branches[hash]; ok {
			heads = hs
		}

		// Match stash to this commit if its base hash matches
		var stashInfo *GitStash
		for i := range stashList {
			if stashList[i].BaseHash == hash {
				stashInfo = &stashList[i]
				break
			}
		}

		commits = append(commits, GitCommit{
			Hash:    hash,
			Parents: parents,
			Author:  parts[2],
			Date:    date.UnixMilli(),
			Message: parts[5],
			Heads:   heads,
			Tags:    commitTags,
			Remotes: []GitRemote{},
			Stash:   stashInfo,
		})
	}

	// When using range notation, we fetched skip+count entries; trim the first skip.
	if skip > 0 && strings.Contains(branch, "..") && len(commits) > skip {
		commits = commits[skip:]
	}

	return commits, head, nil
}

// getGitCommitDetails gets detailed information about a specific commit
func getGitCommitDetails(repoPath, hash string) (*GitCommitDetails, error) {
	output, err := git(repoPath, "log",
		"--format=%H|%P|%an|%ae|%aI|%cn|%ce|%cI|%B",
		"-1",
		hash,
	)
	if err != nil {
		return nil, err
	}

	line := strings.TrimSpace(output)
	parts := strings.SplitN(line, "|", 9)
	if len(parts) < 9 {
		return nil, fmt.Errorf("unexpected git output for commit %s", hash)
	}

	commitDate, _ := time.Parse(time.RFC3339, parts[4])
	committerDate, _ := time.Parse(time.RFC3339, parts[7])

	parents := []string{}
	if parts[1] != "" {
		parents = strings.Split(parts[1], " ")
	}

	fileChanges, err := getGitFileChanges(repoPath, hash)
	if err != nil {
		fileChanges = []GitFileChange{}
	}

	details := &GitCommitDetails{
		GitCommit: GitCommit{
			Hash:    parts[0],
			Parents: parents,
			Author:  parts[2],
			Date:    commitDate.UnixMilli(),
			Message: parts[8],
			Heads:   []string{},
			Tags:    []GitTag{},
			Remotes: []GitRemote{},
			Stash:   nil,
		},
		Committer:     parts[5],
		CommitterDate: committerDate.UnixMilli(),
		Body:          parts[8],
		FileChanges:   fileChanges,
	}

	return details, nil
}

// getUncommittedFileChanges gets the file changes in the working directory.
func getUncommittedFileChanges(repoPath string) []GitFileChange {
	var changes []GitFileChange

	// Get staged changes
	if out, err := git(repoPath, "diff", "--cached", "--name-status"); err == nil {
		for _, line := range strings.Split(out, "\n") {
			if line == "" {
				continue
			}
			fields := strings.Fields(line)
			if len(fields) < 2 {
				continue
			}
			t := fields[0]
			changeType := "M"
			if strings.HasPrefix(t, "A") {
				changeType = "A"
			} else if strings.HasPrefix(t, "D") {
				changeType = "D"
			} else if strings.HasPrefix(t, "R") {
				changeType = "R"
			} else if strings.HasPrefix(t, "U") {
				changeType = "U"
			}
			newPath := fields[len(fields)-1]
			oldPath := newPath
			if changeType == "R" && len(fields) >= 3 {
				oldPath = fields[1]
			}
			changes = append(changes, GitFileChange{OldPath: oldPath, NewPath: newPath, Type: changeType, Adds: 0, Dels: 0})
		}
	}

	// Get unstaged changes
	if out, err := git(repoPath, "diff", "--name-status"); err == nil {
		for _, line := range strings.Split(out, "\n") {
			if line == "" {
				continue
			}
			fields := strings.Fields(line)
			if len(fields) < 2 {
				continue
			}
			t := fields[0]
			changeType := "M"
			if strings.HasPrefix(t, "D") {
				changeType = "D"
			} else if strings.HasPrefix(t, "R") {
				changeType = "R"
			}
			newPath := fields[len(fields)-1]
			oldPath := newPath
			if changeType == "R" && len(fields) >= 3 {
				oldPath = fields[1]
			}
			changes = append(changes, GitFileChange{OldPath: oldPath, NewPath: newPath, Type: changeType, Adds: 0, Dels: 0})
		}
	}

	// Get untracked files
	if out, err := git(repoPath, "ls-files", "--others", "--exclude-standard"); err == nil {
		for _, line := range strings.Split(out, "\n") {
			if line == "" {
				continue
			}
			changes = append(changes, GitFileChange{OldPath: line, NewPath: line, Type: "U", Adds: 0, Dels: 0})
		}
	}

	return changes
}

// getGitFileChanges gets the file changes for a commit (with add/del counts).
func getGitFileChanges(repoPath, hash string) ([]GitFileChange, error) {
	// --name-status gives the change type and paths (handles renames properly)
	nameOut, err := git(repoPath, "log", "--format=", "--name-status", "-1", hash)
	if err != nil {
		return nil, err
	}
	// --numstat gives added/deleted line counts (rename lines show '0 0 old => new')
	numOut, err := git(repoPath, "log", "--format=", "--numstat", "-1", hash)
	if err != nil {
		numOut = ""
	}

	// Parse numstat first: [adds, dels, pathSpec]
	type numstatLine struct {
		adds int
		dels int
		path string
	}
	var numstats []numstatLine
	for _, line := range strings.Split(numOut, "\n") {
		if line == "" {
			continue
		}
		toks := strings.Split(line, "\t")
		if len(toks) < 3 {
			continue
		}
		adds, _ := strconv.Atoi(toks[0])
		dels, _ := strconv.Atoi(toks[1])
		p := toks[2]
		if idx := strings.Index(p, " => "); idx >= 0 {
			// numstat shows 'old => new' for renames; keep the new path
			p = p[idx+4:]
		}
		numstats = append(numstats, numstatLine{adds: adds, dels: dels, path: p})
	}

	changes := make([]GitFileChange, 0)
	i := 0
	for _, line := range strings.Split(nameOut, "\n") {
		if line == "" || strings.HasPrefix(line, " ") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		t := fields[0]
		changeType := "M"
		if strings.HasPrefix(t, "A") {
			changeType = "A"
		} else if strings.HasPrefix(t, "D") {
			changeType = "D"
		} else if strings.HasPrefix(t, "R") {
			changeType = "R"
		} else if strings.HasPrefix(t, "U") {
			changeType = "U"
		}

		newPath := fields[len(fields)-1]
		oldPath := newPath
		if changeType == "R" && len(fields) >= 3 {
			oldPath = fields[1]
		}

		adds, dels := 0, 0
		if i < len(numstats) {
			adds, dels = numstats[i].adds, numstats[i].dels
		}
		i++

		changes = append(changes, GitFileChange{
			OldPath: oldPath,
			NewPath: newPath,
			Type:    changeType,
			Adds:    adds,
			Dels:    dels,
		})
	}

	return changes, nil
}

// handleGitDiff handles GET /api/git/diff
func (s *Server) handleGitDiff(w http.ResponseWriter, r *http.Request) {
	if s.validateRequest(w, r) == "" {
		return
	}

	if r.Method != http.MethodGet {
		writeGitError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}

	repoPath := r.URL.Query().Get("path")
	if repoPath == "" {
		repoPath = "."
	}
	hash := r.URL.Query().Get("hash")
	if hash == "" {
		writeGitError(w, http.StatusBadRequest, "Missing hash parameter")
		return
	}
	newPath := r.URL.Query().Get("newPath")
	oldPath := r.URL.Query().Get("oldPath")

	var cmd *exec.Cmd

	// Handle UNCOMMITTED: diff working directory against HEAD
	if hash == "UNCOMMITTED" {
		if newPath != "" {
			cmd = newGitCmd(repoPath, "diff", "HEAD", "--", newPath)
		} else {
			cmd = newGitCmd(repoPath, "diff", "HEAD")
		}
	} else {
		// Build git show args: hash -- [oldPath newPath]
		args := []string{"show", "--format=", "--no-renames", "-U3", hash, "--"}
		added := false
		if oldPath != "" && oldPath != newPath {
			args = append(args, "--renames")
			args = append(args, oldPath)
			added = true
		}
		if newPath != "" {
			args = append(args, newPath)
			added = true
		}
		if !added {
			writeGitError(w, http.StatusBadRequest, "Missing file parameter")
			return
		}
		cmd = newGitCmd(repoPath, args...)
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		// Fall back: diff against parent for the given path
		writeGitError(w, http.StatusBadRequest, strings.TrimSpace(string(out)))
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"diff": string(out)})
}

// getGitBranches returns all branches and the current branch
func getGitBranches(repoPath string) ([]string, string, error) {
	current := ""
	if out, err := git(repoPath, "branch", "--show-current"); err == nil {
		current = out
	}

	output, err := git(repoPath, "branch", "--format=%(refname:short)")
	if err != nil {
		return nil, "", err
	}

	var branches []string
	for _, line := range strings.Split(output, "\n") {
		if line != "" {
			branches = append(branches, line)
		}
	}

	return branches, current, nil
}

// getGitPushInfo inspects how a commit relates to local branches and their
// upstreams, and suggests a push target. A branch that tracks a remote yields
// Tracking=true (push it directly); otherwise the caller picks a remote branch.
func getGitPushInfo(repoPath, hash string) (*GitPushInfo, error) {
	if hash == "" {
		return nil, fmt.Errorf("commit hash is required")
	}
	if _, err := git(repoPath, "cat-file", "-e", hash+"^{commit}"); err != nil {
		return nil, fmt.Errorf("commit %s was not found", hash)
	}

	current := ""
	if out, err := git(repoPath, "branch", "--show-current"); err == nil {
		current = strings.TrimSpace(out)
	}

	// Which local branches contain the commit?
	contains := map[string]bool{}
	if out, err := git(repoPath, "branch", "--contains", hash, "--format=%(refname:short)"); err == nil {
		for _, line := range strings.Split(out, "\n") {
			if name := strings.TrimSpace(line); name != "" {
				contains[name] = true
			}
		}
	}

	// Every local branch, with its tip and upstream.
	const refFormat = "%(refname:short)|%(objectname)|%(upstream:short)|%(upstream:remotename)|%(upstream:remoteref)"
	refOut, err := git(repoPath, "for-each-ref", "--format="+refFormat, "refs/heads/")
	if err != nil {
		return nil, err
	}
	branches := []GitPushBranch{}
	for _, line := range strings.Split(refOut, "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		parts := strings.SplitN(line, "|", 5)
		for len(parts) < 5 {
			parts = append(parts, "")
		}
		name, tip := parts[0], parts[1]
		upstream, remote, remoteRef := parts[2], parts[3], parts[4]
		remoteBranch := strings.TrimPrefix(remoteRef, "refs/heads/")
		if remoteBranch == "" && upstream != "" && remote != "" {
			remoteBranch = strings.TrimPrefix(upstream, remote+"/")
		}
		branches = append(branches, GitPushBranch{
			Name:         name,
			Tip:          tip,
			TipMatches:   tip == hash,
			Current:      name == current,
			Contains:     contains[name],
			Upstream:     upstream,
			Remote:       remote,
			RemoteBranch: remoteBranch,
		})
	}

	remotes := []string{}
	if out, err := git(repoPath, "remote"); err == nil {
		for _, line := range strings.Split(out, "\n") {
			if name := strings.TrimSpace(line); name != "" {
				remotes = append(remotes, name)
			}
		}
	}
	defaultRemote := "origin"
	if len(remotes) > 0 {
		defaultRemote = remotes[0]
	}

	return &GitPushInfo{
		Hash:          hash,
		CurrentBranch: current,
		Branches:      branches,
		Remotes:       remotes,
		Suggested:     choosePushSuggestion(branches, current, defaultRemote, hash),
	}, nil
}

// choosePushSuggestion picks the best branch to carry the commit to a remote:
// the current branch or one whose tip is the commit, preferring a branch that
// already tracks a remote.
func choosePushSuggestion(branches []GitPushBranch, current, defaultRemote, hash string) GitPushSuggestion {
	suggest := func(b GitPushBranch, tracking bool, reason string) GitPushSuggestion {
		remote, remoteBranch := b.Remote, b.RemoteBranch
		if !tracking {
			if remote == "" {
				remote = defaultRemote
			}
			if remoteBranch == "" {
				remoteBranch = b.Name
			}
		}
		return GitPushSuggestion{
			LocalBranch:  b.Name,
			Remote:       remote,
			RemoteBranch: remoteBranch,
			Tracking:     tracking,
			Reason:       reason,
		}
	}

	ranked := []struct {
		match  func(GitPushBranch) bool
		tracks bool
		reason string
	}{
		{func(b GitPushBranch) bool { return b.Current && b.Contains && b.Upstream != "" }, true, "current-tracking"},
		{func(b GitPushBranch) bool { return b.TipMatches && b.Upstream != "" }, true, "tip-tracking"},
		{func(b GitPushBranch) bool { return b.Contains && b.Upstream != "" }, true, "contains-tracking"},
		{func(b GitPushBranch) bool { return b.Current && b.Contains }, false, "current"},
		{func(b GitPushBranch) bool { return b.TipMatches }, false, "tip"},
		{func(b GitPushBranch) bool { return b.Contains }, false, "contains"},
	}
	for _, r := range ranked {
		for _, b := range branches {
			if r.match(b) {
				return suggest(b, r.tracks, r.reason)
			}
		}
	}

	// The commit is on no local branch (e.g. only fetched): suggest a new
	// remote branch named after the current branch or the commit.
	branch := current
	remoteBranch := branch
	if remoteBranch == "" {
		remoteBranch = "commit-" + shortHash(hash)
	}
	return GitPushSuggestion{
		LocalBranch:  "",
		Remote:       defaultRemote,
		RemoteBranch: remoteBranch,
		Tracking:     false,
		Reason:       "none",
	}
}

// shortHash abbreviates a commit hash for display.
func shortHash(hash string) string {
	if len(hash) > 7 {
		return hash[:7]
	}
	return hash
}
