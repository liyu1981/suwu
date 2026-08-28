package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestResolveTLSEnvironmentPair(t *testing.T) {
	dir := t.TempDir()
	certPath := filepath.Join(dir, "cert.pem")
	keyPath := filepath.Join(dir, "key.pem")
	for path, content := range map[string]string{certPath: "c", keyPath: "k"} {
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("TLS_CERT_FILE", certPath)
	t.Setenv("TLS_KEY_FILE", keyPath)

	cert, key, source, err := resolveTLS()
	if err != nil {
		t.Fatal(err)
	}
	if cert != certPath || key != keyPath {
		t.Errorf("resolveTLS = %q, %q; want %q, %q", cert, key, certPath, keyPath)
	}
	if source != "TLS_CERT_FILE/TLS_KEY_FILE" {
		t.Errorf("source = %q", source)
	}
}

func TestResolveTLSEnvironmentExpandsHome(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skip("no home dir")
	}
	dir := filepath.Join(home, "resolve-tls-test")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	certPath := filepath.Join(dir, "cert.pem")
	keyPath := filepath.Join(dir, "key.pem")
	if err := os.WriteFile(certPath, []byte("c"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keyPath, []byte("k"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("TLS_CERT_FILE", "~/resolve-tls-test/cert.pem")
	t.Setenv("TLS_KEY_FILE", "~/resolve-tls-test/key.pem")

	cert, _, _, err := resolveTLS()
	if err != nil {
		t.Fatal(err)
	}
	if cert != certPath {
		t.Errorf("cert = %q, want %q", cert, certPath)
	}
}

func TestResolveTLSHalfEnvironment(t *testing.T) {
	t.Setenv("TLS_CERT_FILE", "/some/cert.pem")
	t.Setenv("TLS_KEY_FILE", "")
	if _, _, _, err := resolveTLS(); err == nil {
		t.Fatal("half-configured TLS pair should be an error")
	}
}

func TestResolveTLSEnvironmentMissingFile(t *testing.T) {
	t.Setenv("TLS_CERT_FILE", "/nonexistent/cert.pem")
	t.Setenv("TLS_KEY_FILE", "/nonexistent/key.pem")
	_, _, _, err := resolveTLS()
	if err == nil {
		t.Fatal("missing certificate file should be an error")
	}
	if !strings.Contains(err.Error(), "gencerts") {
		t.Errorf("error should hint at gencerts, got: %v", err)
	}
}

func TestResolveTLSDefaultPair(t *testing.T) {
	configRoot := t.TempDir() // becomes XDG_CONFIG_HOME; default dir is $XDG_CONFIG_HOME/suwu
	t.Setenv("XDG_CONFIG_HOME", configRoot)
	t.Setenv("TLS_CERT_FILE", "")
	t.Setenv("TLS_KEY_FILE", "")

	// No pair yet -> no TLS.
	cert, key, source, err := resolveTLS()
	if err != nil {
		t.Fatal(err)
	}
	if cert != "" || key != "" || source != "" {
		t.Errorf("without certs resolveTLS = %q, %q, %q; want empty", cert, key, source)
	}

	// Create the default pair -> picked up.
	pairDir := filepath.Join(configRoot, "suwu")
	if err := os.MkdirAll(pairDir, 0o700); err != nil {
		t.Fatal(err)
	}
	certPath := filepath.Join(pairDir, "tls-cert.pem")
	keyPath := filepath.Join(pairDir, "tls-key.pem")
	if err := os.WriteFile(certPath, []byte("c"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keyPath, []byte("k"), 0o600); err != nil {
		t.Fatal(err)
	}

	cert, key, source, err = resolveTLS()
	if err != nil {
		t.Fatal(err)
	}
	if cert != certPath || key != keyPath {
		t.Errorf("resolveTLS = %q, %q; want %q, %q", cert, key, certPath, keyPath)
	}
	if source != "~/.config/suwu" {
		t.Errorf("source = %q", source)
	}
}

func TestResolveTLSEnvironmentBeatsDefaultPair(t *testing.T) {
	configRoot := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configRoot)

	pairDir := filepath.Join(configRoot, "suwu")
	if err := os.MkdirAll(pairDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(pairDir, "tls-cert.pem"), []byte("c"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(pairDir, "tls-key.pem"), []byte("k"), 0o600); err != nil {
		t.Fatal(err)
	}

	envDir := t.TempDir()
	envCert := filepath.Join(envDir, "cert.pem")
	envKey := filepath.Join(envDir, "key.pem")
	if err := os.WriteFile(envCert, []byte("c"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(envKey, []byte("k"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("TLS_CERT_FILE", envCert)
	t.Setenv("TLS_KEY_FILE", envKey)

	cert, _, _, err := resolveTLS()
	if err != nil {
		t.Fatal(err)
	}
	if cert != envCert {
		t.Errorf("cert = %q, want environment pair %q to win", cert, envCert)
	}
}
