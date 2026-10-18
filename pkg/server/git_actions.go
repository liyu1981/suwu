// Git action handlers for performing git operations from the graph UI
package server

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
)

// GitAction represents the type of git action to perform
type GitAction string

const (
	// Branch actions
	ActionCreateBranch   GitAction = "create-branch"
	ActionCheckoutBranch GitAction = "checkout-branch"
	ActionDeleteBranch   GitAction = "delete-branch"
	ActionRenameBranch   GitAction = "rename-branch"
	ActionPushBranch     GitAction = "push-branch"
	ActionPullBranch     GitAction = "pull-branch"
	ActionFetch          GitAction = "fetch"

	// Commit actions
	ActionCheckoutCommit GitAction = "checkout-commit"
	ActionCherryPick     GitAction = "cherry-pick"
	ActionRevert         GitAction = "revert"
	ActionResetToCommit  GitAction = "reset-to-commit"
	ActionMerge          GitAction = "merge"
	ActionRebase         GitAction = "rebase"
	ActionDropCommit     GitAction = "drop-commit"
	ActionPushCommit     GitAction = "push-commit"

	// Tag actions
	ActionAddTag    GitAction = "add-tag"
	ActionDeleteTag GitAction = "delete-tag"
	ActionPushTag   GitAction = "push-tag"

	// Stash actions
	ActionStash           GitAction = "stash"
	ActionStashPop        GitAction = "stash-pop"
	ActionStashApply      GitAction = "stash-apply"
	ActionStashDrop       GitAction = "stash-drop"
	ActionBranchFromStash GitAction = "branch-from-stash"

	// Working directory
	ActionClean     GitAction = "clean"
	ActionResetHard GitAction = "reset-hard"
)

// GitActionRequest is the request body for /api/git/action
type GitActionRequest struct {
	Path   string            `json:"path"`
	Action GitAction         `json:"action"`
	Params map[string]string `json:"params"`
}

// handleGitAction handles POST /api/git/action
func (s *Server) handleGitAction(w http.ResponseWriter, r *http.Request) {
	if s.validateRequest(w, r) == "" {
		return
	}

	if r.Method != http.MethodPost {
		writeGitError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}

	var req GitActionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeGitError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	if req.Path == "" {
		req.Path = "."
	}
	if req.Params == nil {
		req.Params = map[string]string{}
	}

	slog.Info("git action", "action", req.Action, "path", req.Path, "params", req.Params)

	var err error
	switch req.Action {
	// Branch actions
	case ActionCreateBranch:
		err = actionCreateBranch(req.Path, req.Params)
	case ActionCheckoutBranch:
		err = actionCheckoutBranch(req.Path, req.Params)
	case ActionDeleteBranch:
		err = actionDeleteBranch(req.Path, req.Params)
	case ActionRenameBranch:
		err = actionRenameBranch(req.Path, req.Params)
	case ActionPushBranch:
		err = actionPushBranch(req.Path, req.Params)
	case ActionPullBranch:
		err = actionPullBranch(req.Path, req.Params)
	case ActionFetch:
		err = actionFetch(req.Path, req.Params)

	// Commit actions
	case ActionCheckoutCommit:
		err = actionCheckoutCommit(req.Path, req.Params)
	case ActionCherryPick:
		err = actionCherryPick(req.Path, req.Params)
	case ActionRevert:
		err = actionRevert(req.Path, req.Params)
	case ActionResetToCommit:
		err = actionResetToCommit(req.Path, req.Params)
	case ActionMerge:
		err = actionMerge(req.Path, req.Params)
	case ActionRebase:
		err = actionRebase(req.Path, req.Params)
	case ActionDropCommit:
		err = actionDropCommit(req.Path, req.Params)
	case ActionPushCommit:
		err = actionPushCommit(req.Path, req.Params)

	// Tag actions
	case ActionAddTag:
		err = actionAddTag(req.Path, req.Params)
	case ActionDeleteTag:
		err = actionDeleteTag(req.Path, req.Params)
	case ActionPushTag:
		err = actionPushTag(req.Path, req.Params)

	// Stash actions
	case ActionStash:
		err = actionStash(req.Path, req.Params)
	case ActionStashPop:
		err = actionStashPop(req.Path, req.Params)
	case ActionStashApply:
		err = actionStashApply(req.Path, req.Params)
	case ActionStashDrop:
		err = actionStashDrop(req.Path, req.Params)
	case ActionBranchFromStash:
		err = actionBranchFromStash(req.Path, req.Params)

	// Working directory
	case ActionClean:
		err = actionClean(req.Path, req.Params)
	case ActionResetHard:
		err = actionResetHard(req.Path, req.Params)

	default:
		err = fmt.Errorf("unknown action: %s", req.Action)
	}

	if err != nil {
		slog.Error("git action failed", "action", req.Action, "error", err)
		writeGitError(w, http.StatusBadRequest, err.Error())
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

// ── Branch actions ────────────────────────────────────────────────────

func actionCreateBranch(repoPath string, p map[string]string) error {
	name := p["name"]
	if name == "" {
		return fmt.Errorf("branch name is required")
	}
	startPoint := p["startPoint"] // optional

	args := []string{"-C", repoPath, "branch", name}
	if startPoint != "" {
		args = append(args, startPoint)
	}

	_, err := git(repoPath, args[1:]...)
	return err
}

func actionCheckoutBranch(repoPath string, p map[string]string) error {
	branch := p["branch"]
	if branch == "" {
		return fmt.Errorf("branch name is required")
	}
	_, err := git(repoPath, "checkout", branch)
	return err
}

func actionDeleteBranch(repoPath string, p map[string]string) error {
	branch := p["branch"]
	if branch == "" {
		return fmt.Errorf("branch name is required")
	}
	force := p["force"] == "true"

	args := []string{"branch"}
	if force {
		args = append(args, "-D")
	} else {
		args = append(args, "-d")
	}
	args = append(args, branch)

	_, err := git(repoPath, args...)
	return err
}

func actionRenameBranch(repoPath string, p map[string]string) error {
	oldName := p["oldName"]
	newName := p["newName"]
	if oldName == "" || newName == "" {
		return fmt.Errorf("old and new branch names are required")
	}
	_, err := git(repoPath, "branch", "-m", oldName, newName)
	return err
}

func actionPushBranch(repoPath string, p map[string]string) error {
	branch := p["branch"]
	remote := p["remote"]
	if branch == "" {
		return fmt.Errorf("branch name is required")
	}
	if remote == "" {
		remote = "origin"
	}

	args := []string{"push"}
	if p["setUpstream"] == "true" {
		args = append(args, "-u")
	}
	if p["force"] == "true" {
		args = append(args, "--force")
	} else if p["forceWithLease"] == "true" {
		args = append(args, "--force-with-lease")
	}
	args = append(args, remote, branch)

	_, err := git(repoPath, args...)
	return err
}

func actionPullBranch(repoPath string, p map[string]string) error {
	remote := strings.TrimSpace(p["remote"])

	// Commit-context pull: bring a specific local branch up to date with its
	// remote. That branch is often not the one checked out here.
	if localBranch := strings.TrimSpace(p["localBranch"]); localBranch != "" {
		remoteBranch := strings.TrimSpace(p["remoteBranch"])
		if remoteBranch == "" {
			remoteBranch = localBranch
		}
		if remote == "" {
			remote = "origin"
		}
		if err := validatePushName("remote", remote); err != nil {
			return err
		}
		if err := validatePushName("branch", remoteBranch); err != nil {
			return err
		}

		current, _ := git(repoPath, "branch", "--show-current")
		if strings.TrimSpace(current) == localBranch {
			// Checked out here: a real pull (fetch + merge).
			_, err := git(repoPath, "pull", remote, remoteBranch)
			return err
		}
		// Not checked out: fast-forward the local branch ref in place.
		_, err := git(repoPath, "fetch", remote, remoteBranch+":refs/heads/"+localBranch)
		return err
	}

	// Legacy: pull into the current branch.
	branch := strings.TrimSpace(p["branch"])
	if remote == "" {
		remote = "origin"
	}

	args := []string{"pull", remote}
	if branch != "" {
		args = append(args, branch)
	}

	_, err := git(repoPath, args...)
	return err
}

func actionFetch(repoPath string, p map[string]string) error {
	remote := p["remote"]
	args := []string{"fetch"}
	if remote != "" {
		args = append(args, remote)
	}
	if p["prune"] == "true" {
		args = append(args, "--prune")
	}

	_, err := git(repoPath, args...)
	return err
}

// ── Commit actions ────────────────────────────────────────────────────

func actionCheckoutCommit(repoPath string, p map[string]string) error {
	hash := p["hash"]
	if hash == "" {
		return fmt.Errorf("commit hash is required")
	}
	_, err := git(repoPath, "checkout", hash)
	return err
}

func actionCherryPick(repoPath string, p map[string]string) error {
	hash := p["hash"]
	if hash == "" {
		return fmt.Errorf("commit hash is required")
	}

	args := []string{"cherry-pick"}
	if p["noCommit"] == "true" {
		args = append(args, "--no-commit")
	}
	args = append(args, hash)

	_, err := git(repoPath, args...)
	return err
}

func actionRevert(repoPath string, p map[string]string) error {
	hash := p["hash"]
	if hash == "" {
		return fmt.Errorf("commit hash is required")
	}

	args := []string{"revert", hash}
	if parentIndex := p["parentIndex"]; parentIndex != "" && parentIndex != "0" {
		args = append(args, "-m", parentIndex)
	}

	_, err := git(repoPath, args...)
	return err
}

func actionResetToCommit(repoPath string, p map[string]string) error {
	hash := p["hash"]
	mode := p["mode"] // soft, mixed, hard
	if hash == "" {
		return fmt.Errorf("commit hash is required")
	}
	if mode == "" {
		mode = "mixed"
	}

	_, err := git(repoPath, "reset", "--"+mode, hash)
	return err
}

func actionMerge(repoPath string, p map[string]string) error {
	ref := p["ref"]
	if ref == "" {
		return fmt.Errorf("branch or commit ref is required")
	}

	args := []string{"merge", ref}
	if p["noff"] == "true" {
		args = append([]string{"merge", "--no-ff"}, ref)
	}

	_, err := git(repoPath, args...)
	return err
}

func actionRebase(repoPath string, p map[string]string) error {
	upstream := p["upstream"]
	if upstream == "" {
		return fmt.Errorf("upstream branch or commit is required")
	}

	args := []string{"rebase"}
	if p["interactive"] == "true" {
		args = append(args, "-i")
	}
	args = append(args, upstream)

	_, err := git(repoPath, args...)
	return err
}

func actionDropCommit(repoPath string, p map[string]string) error {
	hash := p["hash"]
	if hash == "" {
		return fmt.Errorf("commit hash is required")
	}

	// Get parent hash
	out, err := git(repoPath, "rev-parse", hash+"^")
	if err != nil {
		return fmt.Errorf("could not find parent of commit: %w", err)
	}
	parent := strings.TrimSpace(out)

	// Rebase onto parent^ to drop the commit
	_, err = git(repoPath, "rebase", "--onto", parent+"^", parent, hash)
	return err
}

// actionPushCommit pushes a commit to a remote. The caller may pin a local
// branch (pushing the branch, which carries the commit) and/or a remote branch;
// with neither, the commit's tracking branch is used. An untracked commit with
// only a remote branch is pushed by hash to refs/heads/<remoteBranch>.
func actionPushCommit(repoPath string, p map[string]string) error {
	hash := strings.TrimSpace(p["hash"])
	if hash == "" {
		return fmt.Errorf("commit hash is required")
	}
	localBranch := strings.TrimSpace(p["localBranch"])
	remote := strings.TrimSpace(p["remote"])
	remoteBranch := strings.TrimSpace(p["remoteBranch"])

	if localBranch == "" && remoteBranch == "" {
		info, err := getGitPushInfo(repoPath, hash)
		if err != nil {
			return err
		}
		if !info.Suggested.Tracking {
			return fmt.Errorf("commit %s is not tracking a remote branch", shortHash(hash))
		}
		localBranch = info.Suggested.LocalBranch
		remote = info.Suggested.Remote
		remoteBranch = info.Suggested.RemoteBranch
	}

	if err := validatePushName("remote", remote); err != nil {
		return err
	}
	if err := validatePushName("branch", remoteBranch); err != nil {
		return err
	}
	if remote == "" {
		remote = "origin"
	}

	args := []string{"push"}
	if localBranch != "" {
		refspec := localBranch
		if remoteBranch != "" && remoteBranch != localBranch {
			refspec = localBranch + ":refs/heads/" + remoteBranch
		}
		if p["setUpstream"] == "true" {
			args = append(args, "-u")
		}
		args = append(args, remote, refspec)
	} else {
		if remoteBranch == "" {
			return fmt.Errorf("a remote branch is required for an untracked commit")
		}
		args = append(args, remote, hash+":refs/heads/"+remoteBranch)
	}

	_, err := git(repoPath, args...)
	return err
}

// validatePushName rejects values that git would read as an option, so a user
// text field can never smuggle a flag into the push command line.
func validatePushName(kind, value string) error {
	if value == "" {
		return nil
	}
	if strings.HasPrefix(value, "-") || strings.ContainsAny(value, " \t\n") {
		return fmt.Errorf("invalid %s name %q", kind, value)
	}
	return nil
}

// ── Tag actions ───────────────────────────────────────────────────────

func actionAddTag(repoPath string, p map[string]string) error {
	name := p["name"]
	hash := p["hash"]
	if name == "" {
		return fmt.Errorf("tag name is required")
	}
	if hash == "" {
		hash = "HEAD"
	}

	args := []string{"tag"}
	if p["annotated"] == "true" || p["message"] != "" {
		args = append(args, "-a")
	}
	args = append(args, name)
	if p["message"] != "" {
		args = append(args, "-m", p["message"])
	}
	args = append(args, hash)

	_, err := git(repoPath, args...)
	return err
}

func actionDeleteTag(repoPath string, p map[string]string) error {
	name := p["name"]
	if name == "" {
		return fmt.Errorf("tag name is required")
	}
	_, err := git(repoPath, "tag", "-d", name)
	return err
}

func actionPushTag(repoPath string, p map[string]string) error {
	name := p["name"]
	remote := p["remote"]
	if name == "" {
		return fmt.Errorf("tag name is required")
	}
	if remote == "" {
		remote = "origin"
	}
	_, err := git(repoPath, "push", remote, "refs/tags/"+name)
	return err
}

// ── Stash actions ─────────────────────────────────────────────────────

func actionStash(repoPath string, p map[string]string) error {
	args := []string{"stash", "push"}
	if msg := p["message"]; msg != "" {
		args = append(args, "-m", msg)
	}
	if p["includeUntracked"] == "true" {
		args = append(args, "-u")
	}
	_, err := git(repoPath, args...)
	return err
}

func actionStashPop(repoPath string, p map[string]string) error {
	selector := p["selector"]
	args := []string{"stash", "pop"}
	if selector != "" {
		args = append(args, selector)
	}
	if p["reinstateIndex"] == "true" {
		args = append([]string{"stash", "pop", "--index"}, args[2:]...)
	}
	_, err := git(repoPath, args...)
	return err
}

func actionStashApply(repoPath string, p map[string]string) error {
	selector := p["selector"]
	args := []string{"stash", "apply"}
	if selector != "" {
		args = append(args, selector)
	}
	if p["reinstateIndex"] == "true" {
		args = append([]string{"stash", "apply", "--index"}, args[2:]...)
	}
	_, err := git(repoPath, args...)
	return err
}

func actionStashDrop(repoPath string, p map[string]string) error {
	selector := p["selector"]
	if selector == "" {
		return fmt.Errorf("stash selector is required")
	}
	_, err := git(repoPath, "stash", "drop", selector)
	return err
}

func actionBranchFromStash(repoPath string, p map[string]string) error {
	branch := p["branch"]
	selector := p["selector"]
	if branch == "" || selector == "" {
		return fmt.Errorf("branch name and stash selector are required")
	}
	_, err := git(repoPath, "stash", "branch", branch, selector)
	return err
}

// ── Working directory actions ──────────────────────────────────────────

func actionClean(repoPath string, p map[string]string) error {
	args := []string{"clean", "-fd"}
	if p["dryRun"] == "true" {
		args = append(args, "-n")
	}
	_, err := git(repoPath, args...)
	return err
}

func actionResetHard(repoPath string, p map[string]string) error {
	_, err := git(repoPath, "reset", "--hard", "HEAD")
	return err
}
