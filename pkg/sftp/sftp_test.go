package sftp

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"strings"
	"testing"

	"golang.org/x/crypto/ssh"
)

func TestCleanRemote(t *testing.T) {
	cases := map[string]string{
		"":                  ".",
		"  ":                ".",
		"/home/user/../x":   "/home/x",
		"/home/user/./file": "/home/user/file",
		"relative/path":     "relative/path",
		"/a/b/":             "/a/b",
	}
	for in, want := range cases {
		if got := cleanRemote(in); got != want {
			t.Errorf("cleanRemote(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestAuthMethodsPassword(t *testing.T) {
	if _, err := authMethods(ConnectionParams{Auth: "password"}); err == nil {
		t.Fatal("expected an error when password is empty")
	}
	methods, err := authMethods(ConnectionParams{Auth: "password", Password: "secret"})
	if err != nil || len(methods) != 1 {
		t.Fatalf("password auth: methods=%d err=%v", len(methods), err)
	}
	if _, err := authMethods(ConnectionParams{Auth: "wat"}); err == nil {
		t.Fatal("expected an error for an unknown auth method")
	}
}

func TestAuthMethodsKey(t *testing.T) {
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	pemKey := string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))

	if _, err := authMethods(ConnectionParams{Auth: "key", PrivateKey: "not a key"}); err == nil {
		t.Fatal("expected a parse error for a bad key")
	}
	methods, err := authMethods(ConnectionParams{Auth: "key", PrivateKey: pemKey})
	if err != nil || len(methods) != 1 {
		t.Fatalf("key auth: methods=%d err=%v", len(methods), err)
	}
}

func TestFingerprintCallback(t *testing.T) {
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	var fp string
	if err := fingerprintCallback(&fp)("host", nil, signer.PublicKey()); err != nil {
		t.Fatalf("callback returned error: %v", err)
	}
	if !strings.HasPrefix(fp, "SHA256:") {
		t.Fatalf("fingerprint = %q, want SHA256: prefix", fp)
	}
}

func TestManagerUnknownSession(t *testing.T) {
	m := NewManager()
	defer m.Close()
	if _, err := m.Get("nope"); err == nil {
		t.Fatal("expected an error for an unknown session")
	}
	if len(m.List()) != 0 {
		t.Fatal("expected no sessions")
	}
	// Disconnecting an unknown session is a no-op.
	m.Disconnect("nope")
}

func TestConnectValidation(t *testing.T) {
	m := NewManager()
	defer m.Close()
	if _, err := m.Connect(context.Background(), ConnectionParams{User: "u", Password: "p"}); err == nil {
		t.Fatal("expected host validation error")
	}
	if _, err := m.Connect(context.Background(), ConnectionParams{Host: "h", Password: "p"}); err == nil {
		t.Fatal("expected user validation error")
	}
	if _, err := m.Connect(context.Background(), ConnectionParams{Host: "h", User: "u"}); err == nil {
		t.Fatal("expected password validation error")
	}
	if _, err := m.Connect(context.Background(), ConnectionParams{Host: "h", User: "u", Port: 99999, Password: "p"}); err == nil {
		t.Fatal("expected port validation error")
	}
}
