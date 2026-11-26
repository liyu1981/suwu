package suwudir

import (
	"os"
	"path/filepath"
	"testing"
)

func TestConfigAndCertPaths(t *testing.T) {
	dir := filepath.Join(string(filepath.Separator), "home", "u", ".suwu")
	if got, want := ConfigFile(dir), filepath.Join(dir, "suwu.env"); got != want {
		t.Errorf("ConfigFile = %q, want %q", got, want)
	}
	if got, want := CertDir(dir), filepath.Join(dir, "cert"); got != want {
		t.Errorf("CertDir = %q, want %q", got, want)
	}
}

func TestDataDirUsesSUWUVar(t *testing.T) {
	want := filepath.Join(t.TempDir(), "data")
	t.Setenv("SUWU_VAR", want)
	got, err := DataDir()
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Errorf("DataDir = %q, want %q", got, want)
	}
}

func TestDataDirExpandsHome(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skip("no home dir")
	}
	dir := filepath.Join(home, "suwudir-test")
	defer os.RemoveAll(dir)
	t.Setenv("SUWU_VAR", "~/suwudir-test")
	got, err := DataDir()
	if err != nil {
		t.Fatal(err)
	}
	if want := dir; got != want {
		t.Errorf("DataDir = %q, want %q", got, want)
	}
}
