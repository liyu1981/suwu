// Package update provides self-update functionality for the Suwu binary.
// It checks GitHub Releases for new versions, downloads the appropriate
// archive, and atomically replaces the running binary.
package update

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"suwu/pkg/version"

	"golang.org/x/mod/semver"
)

const (
	// ReleaseRepo is the GitHub owner/repo for releases.
	ReleaseRepo = "liyu1981/suwu"

	checkTimeout     = 10 * time.Second
	downloadTimeout  = 5 * time.Minute
	daemonStopTimeout = 5 * time.Second
)

// ReleaseInfo holds the metadata for a GitHub release.
type ReleaseInfo struct {
	Version      string         // semver tag, e.g. "v0.1.4"
	ReleaseNotes string         // body of the release
	Assets       []ReleaseAsset // downloadable assets
}

// ReleaseAsset is a single downloadable file in a release.
type ReleaseAsset struct {
	Name               string // e.g. "suwu-0.1.4-linux-amd64.tar.gz"
	BrowserDownloadURL string
	Size               int64
}

// CurrentVersion returns the build-time version string.
func CurrentVersion() string {
	return version.Version
}

// IsDevBuild returns true if the binary was built without a version tag.
func IsDevBuild() bool {
	return version.Version == "dev"
}

// CheckLatest fetches the latest release from GitHub.
func CheckLatest(ctx context.Context) (*ReleaseInfo, error) {
	ctx, cancel := context.WithTimeout(ctx, checkTimeout)
	defer cancel()

	url := fmt.Sprintf("https://api.github.com/repos/%s/releases/latest", ReleaseRepo)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}

	if token := os.Getenv("GITHUB_TOKEN"); token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.Header.Set("Accept", "application/vnd.github+json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch release: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		return nil, fmt.Errorf("no releases found for %s", ReleaseRepo)
	}
	if resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusTooManyRequests {
		return nil, fmt.Errorf("github api rate limited (set GITHUB_TOKEN to increase limits)")
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("github api returned HTTP %d", resp.StatusCode)
	}

	var ghResp struct {
		TagName string `json:"tag_name"`
		Body    string `json:"body"`
		Assets  []struct {
			Name               string `json:"name"`
			BrowserDownloadURL string `json:"browser_download_url"`
			Size               int64  `json:"size"`
		} `json:"assets"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&ghResp); err != nil {
		return nil, fmt.Errorf("decode release: %w", err)
	}

	info := &ReleaseInfo{
		Version:      ghResp.TagName,
		ReleaseNotes: ghResp.Body,
		Assets:       make([]ReleaseAsset, len(ghResp.Assets)),
	}
	for i, a := range ghResp.Assets {
		info.Assets[i] = ReleaseAsset{
			Name:               a.Name,
			BrowserDownloadURL: a.BrowserDownloadURL,
			Size:               a.Size,
		}
	}
	return info, nil
}

// CompareVersions returns -1, 0, or 1 comparing the two semver strings.
// Versions may or may not have a leading "v".
func CompareVersions(a, b string) int {
	return semver.Compare(cleanVersion(a), cleanVersion(b))
}

// IsNewer returns true if newVersion is strictly newer than currentVersion.
func IsNewer(currentVersion, newVersion string) bool {
	return CompareVersions(newVersion, currentVersion) > 0
}

// FindAsset finds the asset matching the current OS and architecture.
func FindAsset(assets []ReleaseAsset) (*ReleaseAsset, error) {
	goos := runtime.GOOS
	goarch := runtime.GOARCH

	// Try exact match first: suwu-<version>-<goos>-<goarch>.tar.gz
	// Also try with "linux" shorthand since releases use that.
	patterns := []string{
		fmt.Sprintf("-%s-%s.tar.gz", goos, goarch),
	}

	for _, asset := range assets {
		name := strings.ToLower(asset.Name)
		for _, pat := range patterns {
			if strings.HasSuffix(name, pat) {
				return &asset, nil
			}
		}
	}

	return nil, fmt.Errorf("no update available for %s/%s", goos, goarch)
}

// DownloadAndReplace downloads the release asset and atomically replaces the
// binary at currentBinPath. On success the old binary is backed up to
// currentBinPath.bak.
func DownloadAndReplace(ctx context.Context, asset ReleaseAsset, currentBinPath string) error {
	ctx, cancel := context.WithTimeout(ctx, downloadTimeout)
	defer cancel()

	binDir := filepath.Dir(currentBinPath)

	// Download to a temp file in the same directory (for atomic rename).
	tmpFile, err := os.CreateTemp(binDir, "suwu-update-*.tar.gz")
	if err != nil {
		return fmt.Errorf("create temp file: %w", err)
	}
	tmpPath := tmpFile.Name()
	defer os.Remove(tmpPath) // clean up on failure

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, asset.BrowserDownloadURL, nil)
	if err != nil {
		tmpFile.Close()
		return fmt.Errorf("create request: %w", err)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		tmpFile.Close()
		return fmt.Errorf("download: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		tmpFile.Close()
		return fmt.Errorf("download returned HTTP %d", resp.StatusCode)
	}

	if _, err := io.Copy(tmpFile, resp.Body); err != nil {
		tmpFile.Close()
		return fmt.Errorf("write download: %w", err)
	}
	tmpFile.Close()

	// Extract the binary from the tarball.
	binData, err := extractBinary(tmpPath)
	if err != nil {
		return fmt.Errorf("extract binary: %w", err)
	}

	// Write extracted binary to a temp executable.
	binTmp, err := os.CreateTemp(binDir, "suwu-bin-*")
	if err != nil {
		return fmt.Errorf("create binary temp: %w", err)
	}
	binTmpPath := binTmp.Name()
	defer os.Remove(binTmpPath)

	if _, err := binTmp.Write(binData); err != nil {
		binTmp.Close()
		return fmt.Errorf("write binary: %w", err)
	}
	binTmp.Close()

	if err := os.Chmod(binTmpPath, 0755); err != nil {
		return fmt.Errorf("chmod: %w", err)
	}

	// Backup current binary.
	backupPath := currentBinPath + ".bak"
	_ = os.Remove(backupPath) // remove old backup
	if err := os.Rename(currentBinPath, backupPath); err != nil {
		return fmt.Errorf("backup current binary: %w", err)
	}

	// Atomic replace.
	if err := os.Rename(binTmpPath, currentBinPath); err != nil {
		// Restore from backup.
		_ = os.Rename(backupPath, currentBinPath)
		return fmt.Errorf("replace binary: %w", err)
	}

	return nil
}

// extractBinary reads a tar.gz archive and returns the first "suwu" binary found.
func extractBinary(tarGzPath string) ([]byte, error) {
	f, err := os.Open(tarGzPath)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	gz, err := gzip.NewReader(f)
	if err != nil {
		return nil, fmt.Errorf("gzip reader: %w", err)
	}
	defer gz.Close()

	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("tar reader: %w", err)
		}

		// Match "suwu" binary (exact name or ends with /suwu).
		base := filepath.Base(hdr.Name)
		if base == "suwu" && !hdr.FileInfo().IsDir() {
			data, err := io.ReadAll(tr)
			if err != nil {
				return nil, fmt.Errorf("read binary: %w", err)
			}
			return data, nil
		}
	}

	return nil, fmt.Errorf("suwu binary not found in archive")
}

// IsDaemonRunning checks if the daemon process is alive by looking for the
// PID file in the default data directory (~/.suwu/suwu.pid).
func IsDaemonRunning() bool {
	home, err := os.UserHomeDir()
	if err != nil {
		return false
	}
	pidFile := filepath.Join(home, ".suwu", "suwu.pid")
	return checkPIDFile(pidFile)
}

// StopDaemon sends SIGINT to the daemon process and waits for it to stop.
func StopDaemon() error {
	home, err := os.UserHomeDir()
	if err != nil {
		return fmt.Errorf("resolve home: %w", err)
	}
	pidFile := filepath.Join(home, ".suwu", "suwu.pid")
	return stopDaemonByPIDFile(pidFile)
}

// StartDaemon starts the daemon by re-executing "suwu daemon start".
func StartDaemon() error {
	bin, err := os.Executable()
	if err != nil {
		return fmt.Errorf("resolve executable: %w", err)
	}
	bin, err = filepath.EvalSymlinks(bin)
	if err != nil {
		return fmt.Errorf("resolve symlinks: %w", err)
	}

	cmd := exec.Command(bin, "daemon", "start")
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

// --- helpers ---

func cleanVersion(v string) string {
	if !strings.HasPrefix(v, "v") {
		return "v" + v
	}
	return v
}

func checkPIDFile(pidFile string) bool {
	data, err := os.ReadFile(pidFile)
	if err != nil {
		return false
	}
	pid := strings.TrimSpace(string(data))
	if pid == "" {
		return false
	}
	// Check if process group exists (daemon uses setsid).
	cmd := exec.Command("kill", "-0", "-"+pid)
	return cmd.Run() == nil
}

func stopDaemonByPIDFile(pidFile string) error {
	data, err := os.ReadFile(pidFile)
	if err != nil {
		return nil // no PID file, nothing to stop
	}
	pid := strings.TrimSpace(string(data))
	if pid == "" {
		return nil
	}

	// Graceful: SIGINT.
	_ = exec.Command("kill", "-INT", "-"+pid).Run()

	// Wait up to daemonStopTimeout for process to exit.
	deadline := time.Now().Add(daemonStopTimeout)
	for time.Now().Before(deadline) {
		if !checkPIDFile(pidFile) {
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}

	// Force: SIGTERM.
	_ = exec.Command("kill", "-TERM", "-"+pid).Run()
	time.Sleep(500 * time.Millisecond)

	// Last resort: SIGKILL.
	_ = exec.Command("kill", "-9", "-"+pid).Run()
	time.Sleep(200 * time.Millisecond)

	return nil
}
