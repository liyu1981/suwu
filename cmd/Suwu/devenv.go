package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"text/template"
	"time"

	"github.com/charmbracelet/huh"
)

//go:embed devenv-checklist.json
var devenvChecklistJSON string

type checklistItem struct {
	ID              string         `json:"id"`
	Name            string         `json:"name"`
	Category        string         `json:"category"`
	DefaultSelected bool           `json:"default_selected"`
	Hidden          bool           `json:"hidden,omitempty"`
	Description     string         `json:"description"`
	CheckBinary     string         `json:"check_binary"`
	CheckCmd        string         `json:"check_cmd,omitempty"`
	Depends         string         `json:"depends,omitempty"`
	InstallCmd      string         `json:"install_cmd,omitempty"`
	PostInstallCmd  string         `json:"post_install_cmd,omitempty"`
	GitHubRelease   *githubRelease `json:"github_release,omitempty"`
}

type githubRelease struct {
	Repo          string `json:"repo"`
	AssetPattern  string `json:"asset_pattern"`
	ExtractBinary string `json:"extract_binary"`
	ArchOverride  string `json:"arch_override,omitempty"`
}

func loadChecklist() ([]checklistItem, error) {
	var items []checklistItem
	if err := json.Unmarshal([]byte(devenvChecklistJSON), &items); err != nil {
		return nil, fmt.Errorf("parse checklist: %w", err)
	}
	return items, nil
}

func binaryExists(name string) bool {
	if _, err := exec.LookPath(name); err == nil {
		return true
	}
	// Also check asdf shims directory — after `asdf install` the shim may
	// exist on disk but not yet be in the current shell's PATH.
	if asdfDir := os.Getenv("ASDF_DATA_DIR"); asdfDir != "" {
		if _, err := os.Stat(asdfDir + "/shims/" + name); err == nil {
			return true
		}
	}
	home, _ := os.UserHomeDir()
	if home != "" {
		if _, err := os.Stat(home + "/.asdf/shims/" + name); err == nil {
			return true
		}
	}
	return false
}

func goarch() string {
	switch runtime.GOARCH {
	case "amd64":
		return "amd64"
	case "arm64":
		return "arm64"
	default:
		return runtime.GOARCH
	}
}

// asdfShimsDir returns the asdf shims directory, checking ASDF_DATA_DIR first
// then falling back to ~/.asdf/shims.
func asdfShimsDir() string {
	if dir := os.Getenv("ASDF_DATA_DIR"); dir != "" {
		return dir + "/shims"
	}
	home, _ := os.UserHomeDir()
	if home != "" {
		return home + "/.asdf/shims"
	}
	return ""
}

// envWithAsdfShims returns os.Environ() with the asdf shims directory
// prepended to PATH so that shimmed binaries (npm, node, etc.) are found.
func envWithAsdfShims() []string {
	shims := asdfShimsDir()
	if shims == "" {
		return os.Environ()
	}
	path := os.Getenv("PATH")
	if strings.Contains(path, shims) {
		return os.Environ()
	}
	env := make([]string, 0, len(os.Environ())+1)
	env = append(env, "PATH="+shims+":"+path)
	for _, e := range os.Environ() {
		if !strings.HasPrefix(e, "PATH=") {
			env = append(env, e)
		}
	}
	return env
}

// localMachineIPs returns non-loopback, non-link-local IPv4 addresses.
func localMachineIPs() []string {
	var ips []string
	ifaces, err := net.Interfaces()
	if err != nil {
		return ips
	}
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			ipNet, ok := addr.(*net.IPNet)
			if !ok {
				continue
			}
			if ipNet.IP.IsLinkLocalUnicast() || ipNet.IP.IsLoopback() || ipNet.IP.To4() == nil {
				continue
			}
			ips = append(ips, ipNet.IP.String())
		}
	}
	return ips
}

func fetchLatestVersion(repo string) (string, error) {
	url := fmt.Sprintf("https://api.github.com/repos/%s/releases/latest", repo)
	client := &http.Client{Timeout: 15 * time.Second}
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	if token := os.Getenv("GITHUB_TOKEN"); token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}

	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("fetch release: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusTooManyRequests {
		return "", fmt.Errorf("github api rate limited (set GITHUB_TOKEN to increase limits)")
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("github api returned HTTP %d", resp.StatusCode)
	}

	var ghResp struct {
		TagName string `json:"tag_name"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&ghResp); err != nil {
		return "", fmt.Errorf("decode release: %w", err)
	}
	return ghResp.TagName, nil
}

func renderAssetName(pattern, version string, archOverride string) (string, error) {
	arch := goarch()
	if archOverride != "" {
		arch = archOverride
	}
	t, err := template.New("asset").Parse(pattern)
	if err != nil {
		return "", err
	}
	var buf bytes.Buffer
	if err := t.Execute(&buf, map[string]string{
		"Version": version,
		"Arch":    arch,
	}); err != nil {
		return "", err
	}
	return buf.String(), nil
}

func downloadGitHubBinary(rel *githubRelease) error {
	fmt.Printf("    → fetching latest version from GitHub...\n")
	version, err := fetchLatestVersion(rel.Repo)
	if err != nil {
		return err
	}
	version = strings.TrimPrefix(version, "v")

	assetName, err := renderAssetName(rel.AssetPattern, version, rel.ArchOverride)
	if err != nil {
		return fmt.Errorf("render asset name: %w", err)
	}

	downloadURL := fmt.Sprintf("https://github.com/%s/releases/download/v%s/%s", rel.Repo, version, assetName)
	fmt.Printf("    → downloading %s...\n", assetName)

	tmpDir, err := os.MkdirTemp("", "suwu-devenv-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmpDir)

	client := &http.Client{Timeout: 5 * time.Minute}
	resp, err := client.Get(downloadURL)
	if err != nil {
		return fmt.Errorf("download: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download returned HTTP %d", resp.StatusCode)
	}

	tarPath := tmpDir + "/" + assetName
	f, err := os.Create(tarPath)
	if err != nil {
		return err
	}
	if _, err := io.Copy(f, resp.Body); err != nil {
		f.Close()
		return err
	}
	f.Close()

	if strings.HasSuffix(assetName, ".tar.gz") {
		return extractAndInstall(tarPath, rel.ExtractBinary)
	}
	// Plain binary (e.g. herdr-linux-x86_64)
	return installBinary(tarPath, rel.ExtractBinary)
}

func extractAndInstall(tarPath, binaryName string) error {
	f, err := os.Open(tarPath)
	if err != nil {
		return err
	}
	defer f.Close()

	gz, err := gzip.NewReader(f)
	if err != nil {
		return fmt.Errorf("gzip: %w", err)
	}
	defer gz.Close()

	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return fmt.Errorf("tar: %w", err)
		}

		base := strings.TrimSuffix(hdr.Name, "/")
		base = base[strings.LastIndex(base, "/")+1:]
		if base == binaryName && !hdr.FileInfo().IsDir() {
			return installFromReader(tr, binaryName)
		}
	}
	return fmt.Errorf("%s not found in archive", binaryName)
}

func installFromReader(r io.Reader, name string) error {
	binPath := "/usr/local/bin/" + name
	tmpPath := binPath + ".tmp"

	data, err := io.ReadAll(r)
	if err != nil {
		return err
	}

	if err := os.WriteFile(tmpPath, data, 0o755); err != nil {
		// Try user-local if /usr/local/bin is not writable
		home, herr := os.UserHomeDir()
		if herr != nil {
			return err
		}
		localBin := home + "/.local/bin"
		if err2 := os.MkdirAll(localBin, 0o755); err2 != nil {
			return err
		}
		tmpPath = localBin + "/" + name + ".tmp"
		if err := os.WriteFile(tmpPath, data, 0o755); err != nil {
			return err
		}
		binPath = localBin + "/" + name
	}

	if err := os.Chmod(tmpPath, 0o755); err != nil {
		os.Remove(tmpPath)
		return err
	}
	if err := os.Rename(tmpPath, binPath); err != nil {
		os.Remove(tmpPath)
		return err
	}

	fmt.Printf("    ✅ installed %s\n", binPath)
	return nil
}

func installBinary(srcPath, name string) error {
	f := mustOpen(srcPath)
	defer f.Close()
	return installFromReader(f, name)
}

func mustOpen(path string) *os.File {
	f, err := os.Open(path)
	if err != nil {
		panic(err)
	}
	return f
}

type devenvPlan struct {
	Items     []checklistItem
	Installed map[string]bool
	Selected  map[string]bool
}

func detectDevenvTools(items []checklistItem) map[string]bool {
	installed := make(map[string]bool, len(items))
	for _, item := range items {
		if item.CheckBinary != "" {
			installed[item.ID] = binaryExists(item.CheckBinary)
		} else if item.CheckCmd != "" {
			cmd := exec.Command("bash", "-c", item.CheckCmd)
			cmd.Env = envWithAsdfShims()
			installed[item.ID] = cmd.Run() == nil
		}
	}
	return installed
}

func collectDevenvPlan() (devenvPlan, error) {
	items, err := loadChecklist()
	if err != nil {
		return devenvPlan{}, err
	}
	plan := devenvPlan{Items: items, Installed: detectDevenvTools(items), Selected: map[string]bool{}}

	fmt.Println()
	fmt.Println("  ── recommended development tools ──")
	for _, category := range []string{"essential", "advanced"} {
		label := "Advanced"
		if category == "essential" {
			label = "Essential"
		}
		fmt.Printf("\n  %s tools\n", label)
		for _, item := range items {
			if item.Category != category || item.Hidden {
				continue
			}
			if plan.Installed[item.ID] {
				fmt.Printf("    ✅ %-12s already installed\n", item.Name)
			} else {
				fmt.Printf("    ❌ %-12s not found\n", item.Name)
			}
		}
	}

	var missingEssential []checklistItem
	for _, item := range items {
		if item.Category == "essential" && !item.Hidden && !plan.Installed[item.ID] {
			missingEssential = append(missingEssential, item)
		}
	}
	if len(missingEssential) > 0 {
		install := true
		form := huh.NewForm(huh.NewGroup(
			huh.NewConfirm().
				Title("Install missing essential development tools?").
				Description("These tools support frontend development and recovery.").
				Value(&install),
		)).WithTheme(huh.ThemeCatppuccin())
		if err := form.Run(); err != nil {
			return devenvPlan{}, fmt.Errorf("essential tools prompt: %w", err)
		}
		if install {
			for _, item := range missingEssential {
				plan.Selected[item.ID] = true
			}
		}
	}

	var advancedOptions []huh.Option[string]
	for _, item := range items {
		if item.Category != "advanced" || item.Hidden || plan.Installed[item.ID] {
			continue
		}
		advancedOptions = append(advancedOptions, huh.NewOption(
			fmt.Sprintf("%s — %s", item.Name, item.Description), item.ID,
		).Selected(item.DefaultSelected))
	}
	if len(advancedOptions) > 0 {
		var selected []string
		form := huh.NewForm(huh.NewGroup(
			huh.NewMultiSelect[string]().
				Title("Select advanced development tools to install").
				Description("fzf, herdr, pi, and witr are selected by default.").
				Options(advancedOptions...).
				Value(&selected).
				Filterable(true),
		)).WithTheme(huh.ThemeCatppuccin())
		if err := form.Run(); err != nil {
			return devenvPlan{}, fmt.Errorf("advanced tools prompt: %w", err)
		}
		for _, id := range selected {
			plan.Selected[id] = true
		}
	}

	return plan, nil
}

func resolveDevenvInstallOrder(plan devenvPlan) ([]checklistItem, error) {
	byID := make(map[string]checklistItem, len(plan.Items))
	for _, item := range plan.Items {
		byID[item.ID] = item
	}

	requested := make(map[string]bool, len(plan.Selected))
	for id := range plan.Selected {
		requested[id] = true
	}
	visiting := map[string]bool{}
	visited := map[string]bool{}
	ordered := make([]checklistItem, 0, len(requested))

	var visit func(string) error
	visit = func(id string) error {
		if plan.Installed[id] || visited[id] {
			return nil
		}
		if visiting[id] {
			return fmt.Errorf("cyclic tool dependency involving %s", id)
		}
		item, ok := byID[id]
		if !ok {
			return fmt.Errorf("tool dependency %q is not in the checklist", id)
		}
		visiting[id] = true
		for _, dep := range strings.Split(item.Depends, ",") {
			dep = strings.TrimSpace(dep)
			if dep != "" {
				if err := visit(dep); err != nil {
					return err
				}
			}
		}
		delete(visiting, id)
		visited[id] = true
		ordered = append(ordered, item)
		return nil
	}

	for _, item := range plan.Items {
		if requested[item.ID] {
			if err := visit(item.ID); err != nil {
				return nil, err
			}
		}
	}
	return ordered, nil
}

func installDevenvPlan(plan devenvPlan) error {
	order, err := resolveDevenvInstallOrder(plan)
	if err != nil {
		return err
	}
	if len(order) == 0 {
		fmt.Println("  ✅ development tools are already ready")
		return nil
	}

	fmt.Printf("\n  Installing %d selected tool(s)...\n", len(order))
	failed := 0
	for index, item := range order {
		fmt.Printf("\n  [%d/%d] Installing %s\n", index+1, len(order), item.Name)
		var installErr error
		if item.GitHubRelease != nil {
			installErr = downloadGitHubBinary(item.GitHubRelease)
		} else if item.InstallCmd != "" {
			cmd := exec.Command("bash", "-c", item.InstallCmd)
			cmd.Env = envWithAsdfShims()
			cmd.Stdout = os.Stdout
			cmd.Stderr = os.Stderr
			installErr = cmd.Run()
		}
		if installErr != nil {
			failed++
			fmt.Printf("    ⚠️  failed to install %s: %v\n", item.Name, installErr)
			continue
		}
		plan.Installed[item.ID] = true
		if item.PostInstallCmd != "" {
			fmt.Println("    → applying post-install setup")
			cmd := exec.Command("bash", "-c", item.PostInstallCmd)
			cmd.Env = envWithAsdfShims()
			cmd.Stdout = os.Stdout
			cmd.Stderr = os.Stderr
			if err := cmd.Run(); err != nil {
				failed++
				fmt.Printf("    ⚠️  post-install setup failed: %v\n", err)
				continue
			}
		}
		fmt.Printf("    ✅ %s ready\n", item.Name)
	}
	if failed > 0 {
		return fmt.Errorf("%d development tool step(s) failed", failed)
	}
	return nil
}
