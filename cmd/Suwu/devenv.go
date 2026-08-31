package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
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
	Depends        string           `json:"depends,omitempty"`
	InstallCmd     string           `json:"install_cmd,omitempty"`
	GitHubRelease  *githubRelease   `json:"github_release,omitempty"`
}

type githubRelease struct {
	Repo           string `json:"repo"`
	AssetPattern   string `json:"asset_pattern"`
	ExtractBinary  string `json:"extract_binary"`
}

func loadChecklist() ([]checklistItem, error) {
	var items []checklistItem
	if err := json.Unmarshal([]byte(devenvChecklistJSON), &items); err != nil {
		return nil, fmt.Errorf("parse checklist: %w", err)
	}
	return items, nil
}

func binaryExists(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
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

func renderAssetName(pattern, version string) (string, error) {
	t, err := template.New("asset").Parse(pattern)
	if err != nil {
		return "", err
	}
	var buf bytes.Buffer
	if err := t.Execute(&buf, map[string]string{
		"Version": version,
		"Arch":    goarch(),
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

	assetName, err := renderAssetName(rel.AssetPattern, version)
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
		if binaryExists(item.CheckBinary) {
			installed[item.ID] = true
		}
	}

	for _, item := range items {
		// Check dependency.
		if item.Depends != "" && !installed[item.Depends] {
			fmt.Printf("  ⏭️  %-16s skipped (%s not installed)\n", item.Name, item.Depends)
			continue
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
			cmd.Stdout = os.Stdout
			cmd.Stderr = os.Stderr
			installErr = cmd.Run()
		}

		if installErr != nil {
			fmt.Printf("    ⚠️  failed to install %s: %v\n", item.Name, installErr)
		} else {
			installed[item.ID] = true
		}
	}

	fmt.Println()
	fmt.Println("  ✅ dev environment setup complete")
	return nil
}
