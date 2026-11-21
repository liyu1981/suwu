package herdr

import (
	"context"
	"os/exec"
	"path"
	"strings"
	"sync"
	"time"
)

// Naming rules, copied from the Herdr app so a space is called what the TUI
// calls it (src/workspace.rs / src/workspace/git/discovery.rs):
//
//	derive_label_from_cwd(cwd) =
//	    in a git repo ? repo_root.file_name()      // the repository name
//	                  : home ? "~" : cwd.file_name()
//
// and a workspace's display name is its custom name, or that derivation of the
// identity cwd.

// SpaceColours is the palette spaces are coloured from, by a hash of their id
// (the id is stable; a path is not).
var SpaceColours = []string{
	"sky", "emerald", "amber", "violet", "rose", "cyan", "lime", "orange",
}

// ColourFor picks a stable palette entry for a space id.
func ColourFor(id string) string {
	if len(SpaceColours) == 0 {
		return "sky"
	}
	var h uint32 = 2166136261
	for i := 0; i < len(id); i++ {
		h ^= uint32(id[i])
		h *= 16777619
	}
	return SpaceColours[int(h%uint32(len(SpaceColours)))]
}

// BaseName is the last path element, with the home directory shown as "~".
func BaseName(cwd, home string) string {
	if cwd == "" {
		return ""
	}
	if home != "" && cwd == home {
		return "~"
	}
	if base := path.Base(cwd); base != "" && base != "/" && base != "." {
		return base
	}
	if cwd == "." {
		return ""
	}
	return cwd
}

// gitRootCache keeps the (bounded) git lookups that naming needs. Keyed by cwd;
// a miss is cached too, so a plain directory is not shelled out to repeatedly.
type gitRootCache struct {
	mu      sync.Mutex
	entries map[string]gitRootEntry
}

type gitRootEntry struct {
	root    string
	expires time.Time
}

const gitRootTTL = 60 * time.Second

func newGitRootCache() *gitRootCache {
	return &gitRootCache{entries: make(map[string]gitRootEntry)}
}

// repoRoot returns the git worktree root for cwd, or "".
func (c *gitRootCache) repoRoot(ctx context.Context, cwd string) string {
	if cwd == "" {
		return ""
	}
	c.mu.Lock()
	if e, ok := c.entries[cwd]; ok && time.Now().Before(e.expires) {
		c.mu.Unlock()
		return e.root
	}
	c.mu.Unlock()

	root := lookupGitRoot(ctx, cwd)
	c.mu.Lock()
	c.entries[cwd] = gitRootEntry{root: root, expires: time.Now().Add(gitRootTTL)}
	c.mu.Unlock()
	return root
}

func lookupGitRoot(ctx context.Context, cwd string) string {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "git", "-C", cwd, "rev-parse", "--show-toplevel").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// DeriveLabel is derive_label_from_cwd: the repo name inside a git worktree,
// otherwise "~" for home and the last path element otherwise.
func DeriveLabel(ctx context.Context, repoRoots *gitRootCache, cwd, home string) string {
	if cwd == "" {
		return ""
	}
	if root := repoRoots.repoRoot(ctx, cwd); root != "" {
		if base := path.Base(root); base != "" && base != "/" && base != "." {
			return base
		}
	}
	return BaseName(cwd, home)
}

// DisplayName is a space's name: the user's override, else the derivation.
func DisplayName(customName, cwd, home string, repoRoots *gitRootCache) string {
	if customName != "" {
		return customName
	}
	if name := DeriveLabel(context.Background(), repoRoots, cwd, home); name != "" {
		return name
	}
	return "workspace"
}
