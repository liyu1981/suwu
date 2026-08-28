package certs

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func hasExtKeyUsage(cert *x509.Certificate, want x509.ExtKeyUsage) bool {
	for _, eku := range cert.ExtKeyUsage {
		if eku == want {
			return true
		}
	}
	return false
}

func createCAIn(t *testing.T, dir string) *CA {
	t.Helper()
	ca, created, err := LoadOrCreateCA(dir)
	if err != nil {
		t.Fatal(err)
	}
	if !created {
		t.Fatal("first LoadOrCreateCA should create the CA")
	}
	return ca
}

func TestLoadOrCreateCACreates(t *testing.T) {
	dir := filepath.Join(t.TempDir(), CADirName)
	ca := createCAIn(t, dir)

	if !ca.Cert.IsCA {
		t.Error("generated certificate is not a CA")
	}
	if !ca.Cert.BasicConstraintsValid {
		t.Error("CA certificate lacks basic constraints")
	}
	if ca.Cert.KeyUsage&x509.KeyUsageCertSign == 0 {
		t.Error("CA certificate cannot sign certificates")
	}

	// Files and permissions.
	certPath, keyPath := filepath.Join(dir, CACertFileName), filepath.Join(dir, CAKeyFileName)
	for path, want := range map[string]os.FileMode{certPath: 0o644, keyPath: 0o600} {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if got := info.Mode().Perm(); got != want {
			t.Errorf("%s perm = %o, want %o", path, got, want)
		}
	}
}

func TestLoadOrCreateCAReuses(t *testing.T) {
	dir := filepath.Join(t.TempDir(), CADirName)
	first := createCAIn(t, dir)

	ca, created, err := LoadOrCreateCA(dir)
	if err != nil {
		t.Fatal(err)
	}
	if created {
		t.Error("second LoadOrCreateCA should reuse the CA")
	}
	if ca.Cert.SerialNumber.Cmp(first.Cert.SerialNumber) != 0 {
		t.Error("reused CA certificate differs from the created one")
	}
	if err := checkKeyMatches(ca.Cert, ca.Key); err != nil {
		t.Errorf("reused CA key does not match: %v", err)
	}
}

func TestLoadOrCreateCAMismatchedPair(t *testing.T) {
	dir := filepath.Join(t.TempDir(), CADirName)
	createCAIn(t, dir)

	// Overwrite the key with a different valid key.
	other, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalECPrivateKey(other)
	if err != nil {
		t.Fatal(err)
	}
	keyPath := filepath.Join(dir, CAKeyFileName)
	if err := os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: der}), 0o600); err != nil {
		t.Fatal(err)
	}

	if _, _, err := LoadOrCreateCA(dir); err == nil {
		t.Fatal("mismatched CA cert/key should be rejected")
	}
}

func TestLoadOrCreateCAHalfPair(t *testing.T) {
	dir := filepath.Join(t.TempDir(), CADirName)
	createCAIn(t, dir)
	if err := os.Remove(filepath.Join(dir, CAKeyFileName)); err != nil {
		t.Fatal(err)
	}
	if _, _, err := LoadOrCreateCA(dir); err == nil {
		t.Fatal("cert without key should be rejected")
	}
}

func TestIssueCoversSANsAndVerifies(t *testing.T) {
	ca := createCAIn(t, filepath.Join(t.TempDir(), CADirName))
	hosts := []string{"localhost", "myhost.lan", "192.168.1.5", "fd00::5"}

	certPEM, keyPEM, err := Issue(ca, hosts)
	if err != nil {
		t.Fatal(err)
	}

	block, _ := pem.Decode(certPEM)
	if block == nil {
		t.Fatal("no PEM certificate returned")
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		t.Fatal(err)
	}

	if len(cert.DNSNames) != 2 || cert.DNSNames[0] != "localhost" || cert.DNSNames[1] != "myhost.lan" {
		t.Errorf("DNSNames = %v", cert.DNSNames)
	}
	ips := map[string]bool{}
	for _, ip := range cert.IPAddresses {
		ips[ip.String()] = true
	}
	if !ips["192.168.1.5"] || !ips["fd00::5"] {
		t.Errorf("IPAddresses = %v", cert.IPAddresses)
	}
	if cert.Subject.CommonName != "localhost" {
		t.Errorf("CommonName = %q", cert.Subject.CommonName)
	}
	if !hasExtKeyUsage(cert, x509.ExtKeyUsageServerAuth) {
		t.Errorf("ExtKeyUsage = %v, want ServerAuth", cert.ExtKeyUsage)
	}
	// NotBefore is back-dated one hour for clock skew.
	if valid := cert.NotAfter.Sub(cert.NotBefore); valid > leafValidFor+time.Hour {
		t.Errorf("validity %v exceeds %v", valid, leafValidFor)
	}

	// The leaf must chain to the CA and validate for every SAN.
	roots := x509.NewCertPool()
	roots.AddCert(ca.Cert)
	if _, err := cert.Verify(x509.VerifyOptions{Roots: roots}); err != nil {
		t.Errorf("leaf does not verify against CA: %v", err)
	}

	// The key must parse and match the certificate.
	keyBlock, _ := pem.Decode(keyPEM)
	if keyBlock == nil {
		t.Fatal("no PEM key returned")
	}
	key, err := x509.ParseECPrivateKey(keyBlock.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	if err := checkKeyMatches(cert, key); err != nil {
		t.Errorf("leaf key does not match certificate: %v", err)
	}
}

func TestIssueRejectsInvalidHosts(t *testing.T) {
	ca := createCAIn(t, filepath.Join(t.TempDir(), CADirName))
	for _, host := range []string{"", "a b", "http://x", "x..y", "-bad-", "a.."} {
		if _, _, err := Issue(ca, []string{host}); err == nil {
			t.Errorf("host %q should be rejected", host)
		}
	}
	if _, _, err := Issue(ca, nil); err == nil {
		t.Error("empty host list should be rejected")
	}
}

func TestIssueAcceptsWildcard(t *testing.T) {
	ca := createCAIn(t, filepath.Join(t.TempDir(), CADirName))
	certPEM, _, err := Issue(ca, []string{"*.lan.example"})
	if err != nil {
		t.Fatal(err)
	}
	block, _ := pem.Decode(certPEM)
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	if len(cert.DNSNames) != 1 || cert.DNSNames[0] != "*.lan.example" {
		t.Errorf("DNSNames = %v", cert.DNSNames)
	}
}

func TestWritePairPerms(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "out")
	certPEM, keyPEM := []byte("cert"), []byte("key")
	if err := WritePair(dir, certPEM, keyPEM); err != nil {
		t.Fatal(err)
	}
	certPath, keyPath := PairPaths(dir)
	for path, want := range map[string]os.FileMode{certPath: 0o644, keyPath: 0o600} {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if got := info.Mode().Perm(); got != want {
			t.Errorf("%s perm = %o, want %o", path, got, want)
		}
	}
	info, err := os.Stat(dir)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0o700 {
		t.Errorf("dir perm = %o, want 700", got)
	}
	if !PairExists(dir) {
		t.Error("PairExists should be true after WritePair")
	}
}

func TestValidateHost(t *testing.T) {
	valid := []string{
		"localhost", "MyHost.LAN", "192.168.0.221", "fd00::5", "::1",
		"*.example.com", "a-b.c_d.example", "host-1",
	}
	for _, h := range valid {
		if err := ValidateHost(h); err != nil {
			t.Errorf("ValidateHost(%q) = %v, want nil", h, err)
		}
	}
	invalid := []string{
		"", "   ", "a b", "http://x", "x..y", "-bad", "bad-", "a/b", "a:b:c",
		"*", "*.  ", "*x.example",
	}
	for _, h := range invalid {
		if err := ValidateHost(h); err == nil {
			t.Errorf("ValidateHost(%q) = nil, want error", h)
		}
	}
}

func TestSplitHosts(t *testing.T) {
	got := SplitHosts(" a.com, b.com\t192.168.0.1\n,a.com, ")
	want := []string{"a.com", "b.com", "192.168.0.1"}
	if len(got) != len(want) {
		t.Fatalf("SplitHosts = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("SplitHosts = %v, want %v", got, want)
		}
	}
	if SplitHosts(",,") != nil {
		t.Error("SplitHosts of separators should be empty")
	}
}

func TestExpandPath(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skip("no home dir")
	}
	cases := map[string]string{
		"~/x":       filepath.Join(home, "x"),
		"~":         home,
		"/abs/path": "/abs/path",
		"rel/path":  "rel/path",
		"":          "",
		"~/":        home,
	}
	for in, want := range cases {
		got, err := ExpandPath(in)
		if err != nil {
			t.Errorf("ExpandPath(%q) = %v", in, err)
			continue
		}
		if got != want {
			t.Errorf("ExpandPath(%q) = %q, want %q", in, got, want)
		}
	}
	if _, err := ExpandPath("~bob/x"); err == nil {
		t.Error("~user expansion should be rejected")
	}
}

func TestDetectHosts(t *testing.T) {
	hosts := DetectHosts()
	if len(hosts) == 0 {
		t.Fatal("DetectHosts returned nothing")
	}
	found := map[string]bool{}
	for _, h := range hosts {
		found[h] = true
		if err := ValidateHost(h); err != nil {
			t.Errorf("detected host %q is invalid: %v", h, err)
		}
	}
	if !found["localhost"] {
		t.Error("DetectHosts should include localhost")
	}
}

func TestPairExists(t *testing.T) {
	dir := t.TempDir()
	if PairExists(dir) {
		t.Error("empty dir should not report a pair")
	}
	if err := os.WriteFile(filepath.Join(dir, CertFileName), []byte("c"), 0o644); err != nil {
		t.Fatal(err)
	}
	if PairExists(dir) {
		t.Error("half pair should not report existence")
	}
}

func TestCAValidity(t *testing.T) {
	dir := filepath.Join(t.TempDir(), CADirName)
	ca := createCAIn(t, dir)
	if valid := ca.Cert.NotAfter.Sub(ca.Cert.NotBefore); valid != caValidFor+time.Hour {
		t.Errorf("CA validity = %v, want %v", valid, caValidFor)
	}
	if time.Now().After(ca.Cert.NotAfter) {
		t.Error("CA already expired")
	}
	if net.ParseIP(ca.Cert.Subject.CommonName) != nil {
		t.Error("CA CommonName should not be an IP")
	}
}
