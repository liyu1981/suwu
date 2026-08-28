// Package certs generates and manages the local certificate authority and
// server certificate pairs used by 'suwu gencerts' and consumed by
// 'suwu serve'. It is mkcert-style: a persistent local CA is created once
// under the suwu config directory and reused, so client devices only need
// to trust the CA a single time for every cert this tool issues.
package certs

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	// CertFileName and KeyFileName are the default leaf pair file names
	// written by gencerts; they match the TLS_CERT_FILE / TLS_KEY_FILE
	// values recorded in the suwu config .env.
	CertFileName = "tls-cert.pem"
	KeyFileName  = "tls-key.pem"

	// CADirName is the sub-directory (inside the suwu config directory)
	// holding the local CA pair.
	CADirName = "CA"

	CACertFileName = "rootCA.pem"
	CAKeyFileName  = "rootCA-key.pem"

	organization = "suwu"
	caCommonName = "suwu local CA"
	caValidFor   = 10 * 365 * 24 * time.Hour
	// leafValidFor stays under Apple's 825-day limit for TLS certificates.
	leafValidFor = 825 * 24 * time.Hour
)

// DefaultDir returns the suwu config directory (XDG_CONFIG_HOME aware):
// ~/.config/suwu by default.
func DefaultDir() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("resolve config dir: %w", err)
	}
	return filepath.Join(base, "suwu"), nil
}

// ExpandPath resolves a leading ~ or ~/ to the user's home directory.
func ExpandPath(p string) (string, error) {
	if p == "" || p[0] != '~' {
		return p, nil
	}
	if len(p) > 1 && p[1] != '/' && p[1] != filepath.Separator {
		return "", fmt.Errorf("cannot expand path %q: only ~ and ~/ are supported", p)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolve home dir: %w", err)
	}
	if len(p) == 1 {
		return home, nil
	}
	return filepath.Join(home, p[2:]), nil
}

// CA is a loaded or freshly created local certificate authority.
type CA struct {
	Cert *x509.Certificate
	Key  crypto.Signer
}

// CADir returns the directory holding the local CA pair inside the suwu
// config directory.
func CADir(configDir string) string {
	return filepath.Join(configDir, CADirName)
}

// LoadOrCreateCA ensures a local CA exists in caDir. It returns the CA and
// whether it was newly created. An existing pair is validated (CA cert,
// matching key, unexpired) and reused, so previously trusted client devices
// keep working.
func LoadOrCreateCA(caDir string) (ca *CA, created bool, err error) {
	certPath := filepath.Join(caDir, CACertFileName)
	keyPath := filepath.Join(caDir, CAKeyFileName)

	_, certErr := os.Stat(certPath)
	_, keyErr := os.Stat(keyPath)
	switch {
	case os.IsNotExist(certErr) && os.IsNotExist(keyErr):
		if err := os.MkdirAll(caDir, 0o700); err != nil {
			return nil, false, err
		}
		ca, err := createCA()
		if err != nil {
			return nil, false, err
		}
		if err := writePEM(certPath, pemBlock("CERTIFICATE", ca.Cert.Raw), 0o644); err != nil {
			return nil, false, err
		}
		keyDER, err := x509.MarshalECPrivateKey(ca.Key.(*ecdsa.PrivateKey))
		if err != nil {
			return nil, false, err
		}
		if err := writePEM(keyPath, pemBlock("EC PRIVATE KEY", keyDER), 0o600); err != nil {
			return nil, false, err
		}
		return ca, true, nil
	case os.IsNotExist(certErr):
		return nil, false, fmt.Errorf("%s exists without %s; remove it and re-run gencerts", keyPath, certPath)
	case os.IsNotExist(keyErr):
		return nil, false, fmt.Errorf("%s exists without %s; remove it and re-run gencerts", certPath, keyPath)
	}

	cert, key, err := loadCA(certPath, keyPath)
	if err != nil {
		return nil, false, err
	}
	if !cert.IsCA {
		return nil, false, fmt.Errorf("%s is not a CA certificate", certPath)
	}
	if time.Now().After(cert.NotAfter) {
		return nil, false, fmt.Errorf("%s expired on %s; remove the CA pair and re-run gencerts", certPath, cert.NotAfter.Format(time.DateOnly))
	}
	if err := checkKeyMatches(cert, key); err != nil {
		return nil, false, err
	}
	return &CA{Cert: cert, Key: key}, false, nil
}

func createCA() (*CA, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("generate CA key: %w", err)
	}
	serial, err := randomSerial()
	if err != nil {
		return nil, err
	}
	now := time.Now()
	tpl := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{Organization: []string{organization}, CommonName: caCommonName},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(caValidFor),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign | x509.KeyUsageDigitalSignature,
		BasicConstraintsValid: true,
		IsCA:                  true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
	if err != nil {
		return nil, fmt.Errorf("create CA certificate: %w", err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, fmt.Errorf("parse CA certificate: %w", err)
	}
	return &CA{Cert: cert, Key: key}, nil
}

func loadCA(certPath, keyPath string) (*x509.Certificate, crypto.Signer, error) {
	cert, err := readCert(certPath)
	if err != nil {
		return nil, nil, err
	}
	key, err := readSigner(keyPath)
	if err != nil {
		return nil, nil, err
	}
	return cert, key, nil
}

func checkKeyMatches(cert *x509.Certificate, key crypto.Signer) error {
	want, err := x509.MarshalPKIXPublicKey(cert.PublicKey)
	if err != nil {
		return err
	}
	got, err := x509.MarshalPKIXPublicKey(key.Public())
	if err != nil {
		return err
	}
	if string(want) != string(got) {
		return errors.New("CA certificate and key do not match; remove the CA pair and re-run gencerts")
	}
	return nil
}

// Issue creates a leaf certificate and key signed by ca, valid for hosts
// (IP literals become IP SANs, everything else DNS SANs).
func Issue(ca *CA, hosts []string) (certPEM, keyPEM []byte, err error) {
	if len(hosts) == 0 {
		return nil, nil, errors.New("no hosts given for certificate")
	}
	var dnsNames []string
	var ips []net.IP
	for _, h := range hosts {
		if err := ValidateHost(h); err != nil {
			return nil, nil, err
		}
		if ip := net.ParseIP(h); ip != nil {
			ips = append(ips, ip)
		} else {
			dnsNames = append(dnsNames, strings.ToLower(h))
		}
	}
	if len(dnsNames) == 0 && len(ips) == 0 {
		return nil, nil, errors.New("no valid hosts given for certificate")
	}

	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, fmt.Errorf("generate server key: %w", err)
	}
	serial, err := randomSerial()
	if err != nil {
		return nil, nil, err
	}
	now := time.Now()
	cn := dnsNames
	if len(cn) == 0 {
		cn = []string{hosts[0]}
	}
	tpl := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{Organization: []string{organization}, CommonName: cn[0]},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(leafValidFor),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		DNSNames:              dnsNames,
		IPAddresses:           ips,
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, ca.Cert, &key.PublicKey, ca.Key)
	if err != nil {
		return nil, nil, fmt.Errorf("create server certificate: %w", err)
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return nil, nil, err
	}
	return pem.EncodeToMemory(pemBlock("CERTIFICATE", der)),
		pem.EncodeToMemory(pemBlock("EC PRIVATE KEY", keyDER)),
		nil
}

// PairPaths returns the leaf certificate and key file paths inside dir.
func PairPaths(dir string) (cert, key string) {
	return filepath.Join(dir, CertFileName), filepath.Join(dir, KeyFileName)
}

// PairExists reports whether both files of the leaf pair exist in dir.
func PairExists(dir string) bool {
	cert, key := PairPaths(dir)
	_, certErr := os.Stat(cert)
	_, keyErr := os.Stat(key)
	return certErr == nil && keyErr == nil
}

// WritePair writes the leaf PEM pair into dir with safe permissions
// (cert 0644, key 0600, dir 0700).
func WritePair(dir string, certPEM, keyPEM []byte) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	certPath, keyPath := PairPaths(dir)
	if err := os.WriteFile(certPath, certPEM, 0o644); err != nil {
		return err
	}
	return os.WriteFile(keyPath, keyPEM, 0o600)
}

// SplitHosts splits a comma- and/or whitespace-separated host list,
// trimming empty entries and duplicates.
func SplitHosts(s string) []string {
	fields := strings.FieldsFunc(s, func(r rune) bool {
		return r == ',' || r == ' ' || r == '\t' || r == '\n'
	})
	var out []string
	seen := map[string]bool{}
	for _, f := range fields {
		f = strings.TrimSpace(f)
		if f == "" || seen[f] {
			continue
		}
		seen[f] = true
		out = append(out, f)
	}
	return out
}

// ValidateHost checks that h is usable as a certificate SAN: an IP literal
// or a DNS name (a single leading "*.label" wildcard is allowed).
func ValidateHost(h string) error {
	h = strings.TrimSpace(h)
	if h == "" {
		return errors.New("empty host")
	}
	if net.ParseIP(h) != nil {
		return nil
	}
	if len(h) > 253 {
		return fmt.Errorf("host %q is longer than 253 characters", h)
	}
	name := strings.ToLower(h)
	if rest, ok := strings.CutPrefix(name, "*."); ok {
		if rest == "" {
			return fmt.Errorf("invalid wildcard host %q", h)
		}
		name = rest
	} else if strings.Contains(name, "*") {
		return fmt.Errorf("host %q: '*' is only allowed as a leading '*.wildcard'", h)
	}
	if strings.ContainsAny(name, " \t\r\n/@:*") {
		return fmt.Errorf("host %q contains invalid characters", h)
	}
	for _, label := range strings.Split(name, ".") {
		if label == "" {
			return fmt.Errorf("host %q has an empty label", h)
		}
		if label[0] == '-' || label[len(label)-1] == '-' {
			return fmt.Errorf("label %q in %q starts or ends with '-'", label, h)
		}
	}
	return nil
}

// DetectHosts returns hosts worth pre-selecting in the gencerts UI:
// localhost, the machine hostname, and every non-link-local IP of the
// machine's interfaces (loopback and LAN addresses included).
func DetectHosts() []string {
	var out []string
	seen := map[string]bool{}
	add := func(h string) {
		h = strings.TrimSpace(h)
		if h == "" || seen[h] {
			return
		}
		seen[h] = true
		out = append(out, h)
	}

	add("localhost")
	add("127.0.0.1")
	if hostname, err := os.Hostname(); err == nil && ValidateHost(hostname) == nil {
		add(strings.ToLower(hostname))
	}
	if interfaces, err := net.Interfaces(); err == nil {
		for _, iface := range interfaces {
			if iface.Flags&net.FlagUp == 0 {
				continue
			}
			addrs, err := iface.Addrs()
			if err != nil {
				continue
			}
			for _, addr := range addrs {
				ipNet, ok := addr.(*net.IPNet)
				if !ok {
					continue
				}
				ip := ipNet.IP
				if ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsUnspecified() {
					continue
				}
				add(ip.String())
			}
		}
	}
	return out
}

func readCert(path string) (*x509.Certificate, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	block, _ := pem.Decode(data)
	if block == nil || block.Type != "CERTIFICATE" {
		return nil, fmt.Errorf("%s: not a PEM certificate", path)
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	return cert, nil
}

func readSigner(path string) (crypto.Signer, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	block, _ := pem.Decode(data)
	if block == nil {
		return nil, fmt.Errorf("%s: not a PEM key", path)
	}
	switch block.Type {
	case "EC PRIVATE KEY":
		key, err := x509.ParseECPrivateKey(block.Bytes)
		if err != nil {
			return nil, fmt.Errorf("parse %s: %w", path, err)
		}
		return key, nil
	case "RSA PRIVATE KEY":
		key, err := x509.ParsePKCS1PrivateKey(block.Bytes)
		if err != nil {
			return nil, fmt.Errorf("parse %s: %w", path, err)
		}
		return key, nil
	case "PRIVATE KEY":
		key, err := x509.ParsePKCS8PrivateKey(block.Bytes)
		if err != nil {
			return nil, fmt.Errorf("parse %s: %w", path, err)
		}
		signer, ok := key.(crypto.Signer)
		if !ok {
			return nil, fmt.Errorf("%s: key cannot sign certificates", path)
		}
		return signer, nil
	default:
		return nil, fmt.Errorf("%s: unsupported PEM key type %q", path, block.Type)
	}
}

func randomSerial() (*big.Int, error) {
	limit := new(big.Int).Lsh(big.NewInt(1), 128)
	serial, err := rand.Int(rand.Reader, limit)
	if err != nil {
		return nil, fmt.Errorf("generate serial number: %w", err)
	}
	return serial, nil
}

func pemBlock(typ string, der []byte) *pem.Block {
	return &pem.Block{Type: typ, Bytes: der}
}

func writePEM(path string, block *pem.Block, perm os.FileMode) error {
	return os.WriteFile(path, pem.EncodeToMemory(block), perm)
}
