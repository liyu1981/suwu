// Git API handlers for the git graph visualization
package server

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os/exec"
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

// writeGitError writes a JSON error response with a human-readable message.
func writeGitError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

// git runs a git command and returns combined stdout+stderr, or a friendly error.
func git(repoPath string, args ...string) (string, error) {
	full := append([]string{"-C", repoPath}, args...)
	cmd := exec.Command("git", full...)
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

	commits, head, err := getGitCommits(repoPath, branch, count, skip)
	if err != nil {
		slog.Error("failed to get git commits", "error", err, "path", repoPath)
		writeGitError(w, http.StatusBadRequest, err.Error())
		return
	}

	resp := GitGraphResponse{
		Commits: commits,
		Head:    head,
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

// handleGitCommitDetails handles GET /api/git/commit
func (s *Server) handleGitCommitDetails(w http.ResponseWriter, r *http.Request) {
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

// getGitCommits fetches commits from a git repository
func getGitCommits(repoPath, branch string, maxCount, skip int) ([]GitCommit, string, error) {
	// Validate the repository is reachable, then fetch commits
	logArgs := []string{"log",
		"--format=%H|%P|%an|%ae|%aI|%s",
		"--max-count=" + strconv.Itoa(maxCount),
	}
	if skip > 0 {
		logArgs = append(logArgs, "--skip="+strconv.Itoa(skip))
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

	var changes []GitFileChange
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

	// Build git show args: hash -- [oldPath newPath]
	args := []string{"-C", repoPath, "show", "--format=", "--no-renames", "-U3", hash, "--"}
	added := false
	if oldPath != "" && oldPath != newPath {
		// Reverts: the text before the arrow (old name) is the file as changed
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

	cmd := exec.Command("git", args...)
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