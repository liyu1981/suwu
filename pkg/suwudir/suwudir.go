// Package suwudir resolves Suwu's single on-disk root. Everything Suwu owns —
// configuration, TLS material, logs, PID, sessions and cached tools — lives
// under the data directory, ~/.suwu by default (override with SUWU_VAR).
package suwudir

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const (
	// DirName is the default data directory name inside the user's home.
	DirName = ".suwu"

	// ConfigFileName is the user-global configuration file inside the data
	// directory.
	ConfigFileName = "suwu.env"

	// CertDirName is the directory holding the local CA and the leaf pair.
	CertDirName = "cert"
)

// DataDir returns the Suwu data directory: SUWU_VAR when set, else ~/.suwu.
// A leading ~ or ~/ in SUWU_VAR is expanded.
func DataDir() (string, error) {
	if v := strings.TrimSpace(os.Getenv("SUWU_VAR")); v != "" {
		return absPath(v)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolve home dir: %w", err)
	}
	return filepath.Join(home, DirName), nil
}

// ConfigFile returns the user-global configuration path inside dir.
func ConfigFile(dir string) string {
	return filepath.Join(dir, ConfigFileName)
}

// CertDir returns the TLS directory inside dir: the local CA and the leaf
// certificate pair.
func CertDir(dir string) string {
	return filepath.Join(dir, CertDirName)
}

func absPath(p string) (string, error) {
	if p == "~" || strings.HasPrefix(p, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("resolve home dir: %w", err)
		}
		if p == "~" {
			p = home
		} else {
			p = filepath.Join(home, p[2:])
		}
	}
	abs, err := filepath.Abs(p)
	if err != nil {
		return "", fmt.Errorf("resolve path %q: %w", p, err)
	}
	return abs, nil
}
