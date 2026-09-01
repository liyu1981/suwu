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

	// Track which tools are installed or user chose to install.
	installed := map[string]bool{}
	// Pre-populate with already-installed tools.
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

	for _, item := range items {
		// Check dependencies (comma-separated).
		if item.Depends != "" {
			skip := false
			for _, dep := range strings.Split(item.Depends, ",") {
				dep = strings.TrimSpace(dep)
				if dep != "" && !installed[dep] {
					fmt.Printf("  ⏭️  %-16s skipped (%s not installed)\n", item.Name, dep)
					skip = true
					break
				}
			}
			if skip {
				continue
			}
		}

		if installed[item.ID] {
			fmt.Printf("  ✅ %-16s already installed\n", item.Name)
			continue
		}

		// Ask user whether to install.
		fmt.Printf("  ❌ %-16s not found\n", item.Name)
		var install bool
		prompt := huh.NewConfirm().
			Title(fmt.Sprintf("Install %s — %s?", item.Name, item.Description)).
			Value(&install)
		if err := huh.NewForm(huh.NewGroup(prompt)).WithTheme(huh.ThemeCatppuccin()).Run(); err != nil {
			return fmt.Errorf("install prompt: %w", err)
		}
		if !install {
			continue
		}

		var installErr error
		if item.GitHubRelease != nil {
			installErr = downloadGitHubBinary(item.GitHubRelease)
		} else if item.InstallCmd != "" {
			fmt.Printf("    → running install command...\n")
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
