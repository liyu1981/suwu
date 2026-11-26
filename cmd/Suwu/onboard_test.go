package main

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"suwu/pkg/certs"
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
		"pig":   true,
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
			args: []string{"--runtime", "--password", "--tls", "--server", "--tools"},
			want: []onboardSection{
				sectionServer,
				sectionPassword,
				sectionTLS,
				sectionRuntime,
				sectionTools,
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
	// Shell integration is gone: the PATH block is automatic and fzf/asdf
	// setup is an explicit action in the Tools screen.
	if _, err := parseOnboardSections([]string{"--shell"}); err == nil {
		t.Fatal("expected an error for the removed --shell flag")
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

// A custom data directory moves the config file and the default cert pair with
// it, but never rewrites certificate paths the user pinned elsewhere.
func TestSetDataDirFollowsDefaultsOnly(t *testing.T) {
	plan := onboardPlan{certDir: certs.CertDir("/old")}
	plan.certFile, plan.keyFile = certs.PairPaths(plan.certDir)

	plan.setDataDir("/new")
	if plan.cfgDir != "/new" || plan.varDir != "/new" {
		t.Errorf("cfgDir/varDir = %q/%q, want /new", plan.cfgDir, plan.varDir)
	}
	if want := filepath.Join("/new", "suwu.env"); plan.envPath != want {
		t.Errorf("envPath = %q, want %q", plan.envPath, want)
	}
	if want := certs.CertDir("/new"); plan.certDir != want {
		t.Errorf("certDir = %q, want %q", plan.certDir, want)
	}
	certPath, keyPath := certs.PairPaths(certs.CertDir("/new"))
	if plan.certFile != certPath || plan.keyFile != keyPath {
		t.Errorf("cert pair = %q/%q, want %q/%q", plan.certFile, plan.keyFile, certPath, keyPath)
	}

	pinned := onboardPlan{certDir: certs.CertDir("/old"), certFile: "/etc/ssl/suwu.pem", keyFile: "/etc/ssl/suwu-key.pem"}
	pinned.setDataDir("/new")
	if pinned.certFile != "/etc/ssl/suwu.pem" || pinned.keyFile != "/etc/ssl/suwu-key.pem" {
		t.Errorf("pinned cert paths were rewritten: %q/%q", pinned.certFile, pinned.keyFile)
	}
}

// 'suwu change-password' is a shortcut with no arguments of its own: anything
// extra is a usage error, reported without touching the configuration.
func TestChangePasswordRejectsArguments(t *testing.T) {
	err := changePassword([]string{"hunter2"})
	if err == nil {
		t.Fatal("changePassword with an argument = nil error, want usage error")
	}
	if !strings.Contains(err.Error(), "takes no arguments") {
		t.Fatalf("error = %q, want it to mention that no arguments are accepted", err)
	}
}
