package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
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
