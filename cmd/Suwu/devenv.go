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
	ID             string           `json:"id"`
	Name           string           `json:"name"`
	Description    string           `json:"description"`
	CheckBinary    string           `json:"check_binary"`
	CheckCmd       string           `json:"check_cmd,omitempty"`
	Depends        string           `json:"depends,omitempty"`
	InstallCmd     string           `json:"install_cmd,omitempty"`
	PostInstallCmd string           `json:"post_install_cmd,omitempty"`
	GitHubRelease  *githubRelease   `json:"github_release,omitempty"`
}

type githubRelease struct {
	Repo           string `json:"repo"`
	AssetPattern   string `json:"asset_pattern"`
	ExtractBinary  string `json:"extract_binary"`
	ArchOverride   string `json:"arch_override,omitempty"`
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

func runDevenvSetup() error {
	var proceed bool
	confirm := huh.NewConfirm().
		Title("Would you like to prepare a local dev environment with recommended tools?").
		Value(&proceed)
	if err := huh.NewForm(huh.NewGroup(confirm)).WithTheme(huh.ThemeCatppuccin()).Run(); err != nil {
		return fmt.Errorf("devenv prompt: %w", err)
	}
	if !proceed {
		return nil
	}

	fmt.Println()
	fmt.Println("  ── checking tools ──")
	fmt.Println()

	items, err := loadChecklist()
	if err != nil {
		return err
	}

	// Detect which tools are already installed.
	installed := map[string]bool{}
	for _, item := range items {
		if item.CheckBinary != "" {
			if binaryExists(item.CheckBinary) {
				installed[item.ID] = true
			}
		} else if item.CheckCmd != "" {
			cmd := exec.Command("bash", "-c", item.CheckCmd)
			cmd.Env = os.Environ()
			if cmd.Run() == nil {
				installed[item.ID] = true
			}
		}
	}

	// Print detection results.
	for _, item := range items {
		if installed[item.ID] {
			fmt.Printf("  ✅ %-16s already installed\n", item.Name)
		} else {
			fmt.Printf("  ❌ %-16s not found\n", item.Name)
		}
	}
	fmt.Println()

	// Build list of items that need installation.
	var toInstall []checklistItem
	for _, item := range items {
		if !installed[item.ID] {
			toInstall = append(toInstall, item)
		}
	}

	if len(toInstall) == 0 {
		fmt.Println("  All tools are already installed.")
	} else {
		// Build dependency map: for each item, which IDs does it depend on.
		depMap := map[string][]string{}
		for _, item := range toInstall {
			if item.Depends != "" {
				var deps []string
				for _, dep := range strings.Split(item.Depends, ",") {
					dep = strings.TrimSpace(dep)
					if dep != "" && !installed[dep] {
						deps = append(deps, dep)
					}
				}
				if len(deps) > 0 {
					depMap[item.ID] = deps
				}
			}
		}

		// Show multi-select for the user to choose which tools to install.
		options := make([]huh.Option[string], 0, len(toInstall))
		for _, item := range toInstall {
			options = append(options, huh.NewOption(
				fmt.Sprintf("%s — %s", item.Name, item.Description),
				item.ID,
			).Selected(true))
		}

		var selected []string
		multiSelect := huh.NewMultiSelect[string]().
			Title("Select tools to install").
			Description("Already installed tools are shown above. Pick which missing tools to install.").
			Options(options...).
			Value(&selected).
			Filterable(true)

		if err := huh.NewForm(huh.NewGroup(multiSelect)).WithTheme(huh.ThemeCatppuccin()).Run(); err != nil {
			return fmt.Errorf("selection prompt: %w", err)
		}

		// Auto-select missing dependencies.
		selectedSet := map[string]bool{}
		for _, id := range selected {
			selectedSet[id] = true
		}
		// Iteratively resolve dependencies until stable.
		changed := true
		for changed {
			changed = false
			for _, item := range toInstall {
				if !selectedSet[item.ID] {
					continue
				}
				if deps, ok := depMap[item.ID]; ok {
					for _, dep := range deps {
						if !selectedSet[dep] {
							// Find the dep item to get its name.
							for _, d := range toInstall {
								if d.ID == dep {
									fmt.Printf("  ℹ️  auto-selecting %s (dependency of %s)\n", d.Name, item.Name)
									break
								}
							}
							selectedSet[dep] = true
							changed = true
						}
					}
				}
			}
		}

		// Rebuild ordered list from toInstall preserving checklist order.
		var installOrder []checklistItem
		for _, item := range toInstall {
			if selectedSet[item.ID] {
				installOrder = append(installOrder, item)
			}
		}

		if len(installOrder) == 0 {
			fmt.Println("  No tools selected for installation.")
		} else {
			fmt.Printf("  Installing %d tool(s)...\n\n", len(installOrder))

			for _, item := range installOrder {
				fmt.Printf("  → Installing %s...\n", item.Name)

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
					fmt.Printf("    ⚠️  failed to install %s: %v\n", item.Name, installErr)
				} else {
					installed[item.ID] = true

					// Run post-install hook if provided (e.g. asdf shims PATH setup)
					if item.PostInstallCmd != "" {
						fmt.Printf("    → running post-install setup...\n")
						cmd := exec.Command("bash", "-c", item.PostInstallCmd)
						cmd.Env = envWithAsdfShims()
						cmd.Stdout = os.Stdout
						cmd.Stderr = os.Stderr
						if err := cmd.Run(); err != nil {
							fmt.Printf("    ⚠️  post-install setup failed: %v\n", err)
						}
					}
				}
			}
		}
	}

	fmt.Println()
	fmt.Println("  ✅ dev environment setup complete")

	// Offer to start suwu daemon
	var startDaemon bool
	prompt := huh.NewConfirm().
		Title("Start suwu daemon now?").
		Description("Run 'suwu daemon start' to serve in the background.").
		Value(&startDaemon)
	if err := huh.NewForm(huh.NewGroup(prompt)).WithTheme(huh.ThemeCatppuccin()).Run(); err == nil && startDaemon {
		fmt.Println()
		cmd := exec.Command("suwu", "daemon", "start")
		cmd.Env = os.Environ()
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		if err := cmd.Run(); err != nil {
			fmt.Printf("  ⚠️  failed to start daemon: %v\n", err)
		} else {
			// Print IP-based access URLs so the user knows how to reach
			// the terminal from other devices on the network.
			if ips := localMachineIPs(); len(ips) > 0 {
				port := os.Getenv("PORT")
				if port == "" {
					port = "8181"
				}
				scheme := "https"
				if os.Getenv("TLS_CERT_FILE") == "" && os.Getenv("TLS_KEY_FILE") == "" {
					scheme = "http"
				}
				fmt.Println()
				fmt.Println("  📡 Other devices on this network can reach the terminal at:")
				for _, ip := range ips {
					fmt.Printf("     %s://%s:%s\n", scheme, ip, port)
				}
				fmt.Println("     (client devices must trust the CA once for https)")
			}
		}
	}

	return nil
}
