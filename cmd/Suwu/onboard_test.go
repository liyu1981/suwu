package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestDevelopmentToolCategoriesAndDefaults(t *testing.T) {
	items, err := loadChecklist()
	if err != nil {
		t.Fatal(err)
	}

	wantAdvancedSelected := map[string]bool{
		"fzf":   true,
		"herdr": true,
		"pi":    true,
		"witr":  true,
	}
	wantAdvancedUnselected := map[string]bool{
		"fresh":    true,
		"opencode": true,
		"lazygit":  true,
	}

	for _, item := range items {
		if wantAdvancedSelected[item.ID] {
			if item.Category != "advanced" || !item.DefaultSelected {
				t.Errorf("%s = category %q, default_selected=%v; want advanced/true", item.ID, item.Category, item.DefaultSelected)
			}
		}
		if wantAdvancedUnselected[item.ID] && (item.Category != "advanced" || item.DefaultSelected) {
			t.Errorf("%s should be an unselected advanced tool", item.ID)
		}
	}
}

// TestRipgrepReleaseAssetPattern pins the ripgrep installer to the real
// release layout on https://github.com/BurntSushi/ripgrep/releases:
// tags are bare versions (15.2.0, no "v" prefix) and Linux assets are
// named ripgrep-<version>-<rust-target>.tar.gz — x86_64 ships only the
// musl triple. If upstream changes any of this, this test fails and the
// checklist entry must be updated rather than silently 404-ing.
func TestRipgrepReleaseAssetPattern(t *testing.T) {
	items, err := loadChecklist()
	if err != nil {
		t.Fatal(err)
	}
	var rel *githubRelease
	for _, item := range items {
		if item.ID == "ripgrep" {
			if item.Category != "essential" {
				t.Errorf("ripgrep category = %q, want essential", item.Category)
			}
			if item.CheckBinary != "rg" {
				t.Errorf("ripgrep check_binary = %q, want rg", item.CheckBinary)
			}
			rel = item.GitHubRelease
		}
	}
	if rel == nil {
		t.Fatal("ripgrep entry missing from devenv checklist")
	}
	if rel.TagPrefix == nil || *rel.TagPrefix {
		t.Errorf("ripgrep tag_prefix must be false: release tags are bare versions (15.2.0)")
	}
	if !rel.InstallLocalBin {
		t.Errorf("ripgrep install_to_local_bin = false, want true (~/.local/bin)")
	}

	// Render for both supported architectures and compare with the real
	// asset names from the 15.2.0 release page.
	for _, arch := range []string{"amd64", "arm64"} {
		name, err := renderAssetName(rel.AssetPattern, "15.2.0", "")
		if err != nil {
			t.Fatal(err)
		}
		_ = arch // rustTarget is derived from goarch(); see TestRustTarget below
		if !strings.HasPrefix(name, "ripgrep-15.2.0-") || !strings.HasSuffix(name, "-unknown-linux-musl.tar.gz") {
			t.Errorf("ripgrep asset %q does not match the release pattern ripgrep-<version>-<rust-target>.tar.gz", name)
		}
	}
	url := fmt.Sprintf("https://github.com/%s/releases/download/%s%s/%s", rel.Repo, tagPrefix(rel), "15.2.0", "ripgrep-15.2.0-x86_64-unknown-linux-musl.tar.gz")
	want := "https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/ripgrep-15.2.0-x86_64-unknown-linux-musl.tar.gz"
	if url != want {
		t.Errorf("ripgrep download url = %q, want %q", url, want)
	}
}

func TestRustTarget(t *testing.T) {
	for arch, want := range map[string]string{
		"amd64": "x86_64-unknown-linux-musl",
		"arm64": "aarch64-unknown-linux-musl",
	} {
		if got := rustTarget(arch); got != want {
			t.Errorf("rustTarget(%q) = %q, want %q", arch, got, want)
		}
	}
	name, err := renderAssetName("ripgrep-{{ .Version }}-{{ .RustTarget }}.tar.gz", "15.2.0", "")
	if err != nil {
		t.Fatal(err)
	}
	want := "ripgrep-15.2.0-"
	switch runtime.GOARCH {
	case "amd64":
		want += "x86_64-unknown-linux-musl.tar.gz"
	case "arm64":
		want += "aarch64-unknown-linux-musl.tar.gz"
	default:
		t.Skipf("no rust target mapping for %s", runtime.GOARCH)
	}
	if name != want {
		t.Errorf("rendered asset = %q, want %q", name, want)
	}
}

func TestUpsertEnvPreservesCommentsAndUsesSecureMode(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".env")
	content := "# Suwu config\n#AUTH_PASS=\nHOST=127.0.0.1\n"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := upsertEnv(path, map[string]string{
		"AUTH_PASS": "hash",
		"HOST":      "0.0.0.0",
	}); err != nil {
		t.Fatal(err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	if !strings.Contains(text, "AUTH_PASS=hash") || !strings.Contains(text, "HOST=0.0.0.0") {
		t.Fatalf("updated env missing values: %q", text)
	}
	if !strings.Contains(text, "# Suwu config") {
		t.Fatalf("comments were not preserved: %q", text)
	}
	if mode := fileMode(t, path); mode&0o077 != 0 {
		t.Errorf("config mode = %o; expected owner-only permissions", mode)
	}
}

func TestRemoveLegacyOnboardKeys(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".env")
	content := "PORT=8080\nNO_TLS=true\nSUWU_PASSWORD=secret\nSERVER_MODE=https\n"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := removeLegacyOnboardKeys(path); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	for _, key := range []string{"PORT=", "NO_TLS=", "SUWU_PASSWORD="} {
		if strings.Contains(text, key) {
			t.Errorf("legacy key %s was retained in %q", key, text)
		}
	}
	if !strings.Contains(text, "SERVER_MODE=https") {
		t.Errorf("current key was removed: %q", text)
	}
}

func fileMode(t *testing.T, path string) os.FileMode {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return info.Mode().Perm()
}

func TestParseOnboardSections(t *testing.T) {
	tests := []struct {
		name string
		args []string
		want []onboardSection
	}{
		{name: "no flags is the full wizard", args: nil, want: nil},
		{name: "single section", args: []string{"--password"}, want: []onboardSection{sectionPassword}},
		{name: "tools only", args: []string{"--tools"}, want: []onboardSection{sectionTools}},
		{
			name: "server implies TLS",
			args: []string{"--server"},
			want: []onboardSection{sectionServer, sectionTLS},
		},
		{
			name: "multiple sections run in canonical order",
			args: []string{"--tools", "--tls"},
			want: []onboardSection{sectionTLS, sectionTools},
		},
		{
			name: "all sections",
			args: []string{"--shell", "--runtime", "--password", "--tls", "--server", "--tools"},
			want: []onboardSection{
				sectionServer,
				sectionPassword,
				sectionTLS,
				sectionRuntime,
				sectionTools,
				sectionShell,
			},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseOnboardSections(tc.args)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("sections = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestParseOnboardSectionsRejectsBadInput(t *testing.T) {
	if _, err := parseOnboardSections([]string{"password"}); err == nil {
		t.Fatal("expected an error for a positional argument")
	}
	if _, err := parseOnboardSections([]string{"--bogus"}); err == nil {
		t.Fatal("expected an error for an unknown flag")
	}
	if _, err := parseOnboardSections([]string{"--help"}); !errors.Is(err, errOnboardHelp) {
		t.Fatalf("help error = %v, want errOnboardHelp", err)
	}
}

func TestOnboardHasSection(t *testing.T) {
	if !onboardHasSection(nil, sectionPassword) {
		t.Fatal("empty selection should include every section (full wizard)")
	}
	if onboardHasSection([]onboardSection{sectionTools}, sectionPassword) {
		t.Fatal("tools-only selection must not include the password section")
	}
	if !onboardHasSection([]onboardSection{sectionPassword, sectionTools}, sectionPassword) {
		t.Fatal("selected section should be reported as included")
	}
}

func TestOnboardEnvValuesFiltersBySection(t *testing.T) {
	plan := onboardPlan{
		host:       "127.0.0.1",
		mode:       "https",
		httpsPort:  8181,
		httpPort:   8180,
		extraHosts: "example.com",
		sessionTTL: 24 * time.Hour,
		varDir:     "/home/u/.suwu",
		authHash:   "deadbeef",
		certFile:   "/cfg/cert.pem",
		keyFile:    "/cfg/key.pem",
	}

	full := onboardEnvValues(plan, nil)
	for _, key := range []string{
		"HOST", "SERVER_MODE", "HTTPS_PORT", "HTTP_PORT", "EXTRA_HOSTS",
		"SESSION_TTL", "SUWU_VAR", "AUTH_PASS", "TLS_CERT_FILE", "TLS_KEY_FILE",
	} {
		if _, ok := full[key]; !ok {
			t.Errorf("full selection missing %s", key)
		}
	}

	password := onboardEnvValues(plan, []onboardSection{sectionPassword})
	if len(password) != 1 || password["AUTH_PASS"] != "deadbeef" {
		t.Fatalf("password-only values = %v, want only AUTH_PASS", password)
	}

	tools := onboardEnvValues(plan, []onboardSection{sectionTools})
	if len(tools) != 0 {
		t.Fatalf("tools-only values = %v, want none", tools)
	}

	runtimeOnly := onboardEnvValues(plan, []onboardSection{sectionRuntime})
	if len(runtimeOnly) != 1 || runtimeOnly["SUWU_VAR"] != "/home/u/.suwu" {
		t.Fatalf("runtime-only values = %v, want only SUWU_VAR", runtimeOnly)
	}

	httpPlan := plan
	httpPlan.mode = "http"
	tlsHTTP := onboardEnvValues(httpPlan, []onboardSection{sectionTLS})
	if len(tlsHTTP) != 0 {
		t.Fatalf("TLS values under http mode = %v, want none", tlsHTTP)
	}
}

func TestCollectOnboardSectionRejectsUnknown(t *testing.T) {
	var plan onboardPlan
	if err := collectOnboardSection(&plan, onboardSection("bogus")); err == nil {
		t.Fatal("expected an error for an unknown section")
	}
}
