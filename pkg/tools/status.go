package tools

import (
	"os"
	"path/filepath"
)

// State is what the settings page shows for one catalog entry.
type State string

const (
	// StateMissing means the catalog has it for this platform and the bin dir
	// does not.
	StateMissing State = "missing"
	// StateInstalled means the stamp's version is the catalog's version.
	StateInstalled State = "installed"
	// StateUpdate means a different version is installed.
	StateUpdate State = "update"
	// StateUnsupported means the catalog has no asset for this platform. It is a
	// fact about the vendor, not an error, so the row is shown and inert.
	StateUnsupported State = "unsupported"
	// StateUnmanaged means a file with the tool's name is in the bin dir but no
	// stamp owns it: somebody installed it by hand, and the installer will not
	// touch it without --force.
	StateUnmanaged State = "unmanaged"
	// StateManual means the tool cannot be installed by Suwu (it is not a
	// single binary) and is not detected on this machine yet. The row shows
	// the instruction instead of an Install button.
	StateManual State = "manual"
)

// Status is one catalog entry resolved against this machine.
type Status struct {
	Name     string `json:"name"`
	Label    string `json:"label"`
	Version  string `json:"version"`
	Summary  string `json:"summary"`
	Homepage string `json:"homepage"`
	License  string `json:"license"`
	Requires []string
	Notes    string `json:"notes,omitempty"`
	Bundled  string `json:"bundled,omitempty"`
	State    State  `json:"state"`
	// Available is false when the catalog lists no asset for this platform.
	Available bool     `json:"available"`
	Archive   string   `json:"archive,omitempty"`
	URL       string   `json:"url,omitempty"`
	Installed *Stamp   `json:"installed,omitempty"`
	Path      string   `json:"path"`
	Platforms []string `json:"platforms"`
	// Manual marks a tool Suwu cannot install itself, only point at.
	Manual bool `json:"manual,omitempty"`
	// Instruction is the command a manual row asks the user to run.
	Instruction string `json:"instruction,omitempty"`
}

// Statuses resolves every catalog entry against a platform and a data dir.
func Statuses(cat *Catalog, goos, goarch, dataDir string) ([]Status, error) {
	stamps, err := Stamps(dataDir)
	if err != nil {
		return nil, err
	}
	out := make([]Status, 0, len(cat.Tools))
	for i := range cat.Tools {
		t := &cat.Tools[i]
		s := Status{
			Name: t.Name, Label: label(t), Version: t.Version, Summary: t.Summary,
			Homepage: t.Homepage, License: t.License, Requires: t.Requires,
			Notes: t.Notes, Bundled: t.Bundled,
			Path:      Path(dataDir, t.Name),
			Platforms: t.PlatformsList(),
		}
		if p, ok := t.For(goos, goarch); ok {
			s.Available = true
			s.Archive, s.URL = p.Archive, p.URL
		}
		stamp, stamped := stamps[t.Name]
		if stamped {
			cp := stamp
			s.Installed = &cp
		}
		switch {
		case !s.Available:
			s.State = StateUnsupported
		case stamped && stamp.Version == t.Version:
			s.State = StateInstalled
		case stamped:
			s.State = StateUpdate
		case fileExists(s.Path):
			s.State = StateUnmanaged
		default:
			s.State = StateMissing
		}
		out = append(out, s)
	}
	return out, nil
}

// ManualStatuses resolves the tools that are installable only by hand against
// this machine, so the Tools screen can list them beside the catalog.
func ManualStatuses() []Status {
	manual := ManualTools()
	out := make([]Status, 0, len(manual))
	for _, m := range manual {
		s := Status{
			Name:        m.Name,
			Label:       m.Label,
			Summary:     m.Summary,
			State:       StateManual,
			Path:        m.ResolvedPath(),
			Manual:      true,
			Instruction: m.Command,
		}
		if m.Installed() {
			s.State = StateInstalled
		}
		out = append(out, s)
	}
	return out
}

func label(t *Tool) string {
	if t.Label != "" {
		return t.Label
	}
	return t.Name
}

func fileExists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}

// InstalledNames lists the tools with a stamp, in name order.
func InstalledNames(dataDir string) ([]string, error) {
	stamps, err := Stamps(dataDir)
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(stamps))
	for name := range stamps {
		out = append(out, name)
	}
	// Stable output for `suwu exec --list` and the CLI.
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j] < out[j-1]; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out, nil
}

// ResolveExecutable returns the managed binary for a tool, and whether it is
// there. It is what `suwu exec` uses: never PATH, never the system copy.
func ResolveExecutable(dataDir, name string) (string, bool) {
	if !nameRe.MatchString(name) {
		return "", false
	}
	p := Path(dataDir, name)
	info, err := os.Lstat(p)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o111 == 0 {
		return "", false
	}
	// A path built from a validated name cannot escape, but the check is cheap
	// and this is the one place a tool's path becomes an exec.
	if err := withinDir(filepath.Dir(p), p); err != nil {
		return "", false
	}
	return p, true
}

func withinDir(base, target string) error {
	rel, err := filepath.Rel(base, target)
	if err != nil {
		return err
	}
	if rel == ".." || len(rel) > 2 && rel[:2] == ".." {
		return os.ErrInvalid
	}
	return nil
}
