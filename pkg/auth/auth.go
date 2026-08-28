// Package auth implements the same-origin token and host/origin validation
// used by the original Node demo server. It is a direct port of bin/auth.js.
package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"net"
	"net/url"
	"os"
	"strings"
)

var (
	loopbackHosts = []string{"localhost", "127.0.0.1", "::1"}
	wildcardHosts = []string{"0.0.0.0", "::", "*"}
)

// Decision is the result of validating a request.
type Decision struct {
	OK     bool
	Status int
	Reason string
}

func decision(status int, reason string) Decision {
	return Decision{OK: false, Status: status, Reason: reason}
}

func badRequest() Decision   { return decision(400, "Bad Request") }
func forbidden() Decision    { return decision(403, "Forbidden") }
func unauthorized() Decision { return decision(401, "Unauthorized") }

func allowed() Decision { return Decision{OK: true} }

// Host is a parsed and normalized Host or Origin authority.
type Host struct {
	Hostname string
	Port     string
}

// Config is the immutable per-run auth configuration.
type Config struct {
	Token        string
	BindHost     string
	AllowedHosts []string
}

// GenerateSessionToken returns a URL-safe base64 random token with >= 256 bits.
func GenerateSessionToken() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

// NormalizeHostname lowercases and validates a hostname or IP literal.
// Returns "" (zero value) if invalid.
func normalizeHostname(hostname string) string {
	value := strings.TrimSpace(strings.ToLower(hostname))
	if value == "" || strings.ContainsAny(value, " \t\r\n") {
		return ""
	}

	// Handle bracketed IPv6 literal.
	if strings.HasPrefix(value, "[") || strings.HasSuffix(value, "]") {
		if !strings.HasPrefix(value, "[") || !strings.HasSuffix(value, "]") {
			return ""
		}
		value = value[1 : len(value)-1]
	}

	if value == "" || strings.ContainsAny(value, "/\\@") {
		return ""
	}

	if net.ParseIP(value) != nil {
		return value
	}

	if strings.Contains(value, ":") || !isDNSLabel(value) {
		return ""
	}

	return value
}

func isDNSLabel(value string) bool {
	if value == "" {
		return false
	}
	labels := strings.Split(value, ".")
	for _, label := range labels {
		if label == "" || len(label) > 63 {
			return false
		}
		if strings.HasPrefix(label, "-") || strings.HasSuffix(label, "-") {
			return false
		}
	}
	return true
}

func addAllowedHost(allowed []string, host string) ([]string, error) {
	normalized := normalizeHostname(host)
	if normalized == "" {
		return nil, errors.New("allowed host must be a hostname or IP address: " + host)
	}
	for _, h := range allowed {
		if h == normalized {
			return allowed, nil
		}
	}
	return append(allowed, normalized), nil
}

func parsePort(port string) string {
	if port == "" {
		return ""
	}
	for _, r := range port {
		if r < '0' || r > '9' {
			return ""
		}
	}
	n := 0
	for _, r := range port {
		n = n*10 + int(r-'0')
		if n > 65535 {
			return ""
		}
	}
	if n < 1 {
		return ""
	}
	return port
}

// ParseHostHeader parses and validates an HTTP Host header value.
func ParseHostHeader(hostHeader string) (Host, bool) {
	if hostHeader == "" || hostHeader != strings.TrimSpace(hostHeader) {
		return Host{}, false
	}

	var hostname, port string

	if strings.HasPrefix(hostHeader, "[") {
		// [ipv6] or [ipv6]:port
		closeIdx := strings.Index(hostHeader, "]")
		if closeIdx < 0 {
			return Host{}, false
		}
		hostname = hostHeader[1:closeIdx]
		rest := hostHeader[closeIdx+1:]
		if rest != "" {
			if !strings.HasPrefix(rest, ":") {
				return Host{}, false
			}
			port = parsePort(rest[1:])
			if port == "" {
				return Host{}, false
			}
		}
	} else {
		colonCount := strings.Count(hostHeader, ":")
		switch {
		case colonCount == 0:
			hostname = hostHeader
		case colonCount == 1:
			parts := strings.SplitN(hostHeader, ":", 2)
			hostname = parts[0]
			port = parsePort(parts[1])
			if port == "" {
				return Host{}, false
			}
		default:
			hostname = hostHeader
		}
	}

	normalized := normalizeHostname(hostname)
	if normalized == "" {
		return Host{}, false
	}
	return Host{Hostname: normalized, Port: port}, true
}

type origin struct {
	protocol string
	Host
}

func parseOriginHeader(originHeader string) (origin, bool) {
	if originHeader == "" || originHeader != strings.TrimSpace(originHeader) {
		return origin{}, false
	}
	u, err := url.Parse(originHeader)
	if err != nil {
		return origin{}, false
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return origin{}, false
	}
	if u.User != nil || u.Path != "/" && u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return origin{}, false
	}
	host, ok := ParseHostHeader(u.Host)
	if !ok {
		return origin{}, false
	}
	return origin{protocol: u.Scheme, Host: host}, true
}

func defaultPort(protocol string) string {
	if protocol == "https" {
		return "443"
	}
	return "80"
}

func originMatchesHost(o origin, h Host) bool {
	fallbackPort := defaultPort(o.protocol)
	oPort := o.Port
	if oPort == "" {
		oPort = fallbackPort
	}
	hPort := h.Port
	if hPort == "" {
		hPort = fallbackPort
	}
	return o.Hostname == h.Hostname && oPort == hPort
}

func validateAllowedHost(cfg *Config, hostHeader string) (Decision, Host) {
	host, ok := ParseHostHeader(hostHeader)
	if !ok {
		d := badRequest()
		return d, Host{}
	}
	if !contains(cfg.AllowedHosts, host.Hostname) {
		d := forbidden()
		return d, host
	}
	return allowed(), host
}

func validateMatchingOrigin(originHeader string, host Host, required bool) Decision {
	if originHeader == "" {
		if required {
			return forbidden()
		}
		return allowed()
	}
	o, ok := parseOriginHeader(originHeader)
	if !ok {
		return badRequest()
	}
	if !originMatchesHost(o, host) {
		return forbidden()
	}
	return allowed()
}

// safeTokenEquals compares two strings in constant time.
func safeTokenEquals(expected, actual string) bool {
	if actual == "" {
		return false
	}
	e := []byte(expected)
	a := []byte(actual)
	if len(e) != len(a) {
		return false
	}
	return subtle.ConstantTimeCompare(e, a) == 1
}

func contains(list []string, v string) bool {
	for _, s := range list {
		if s == v {
			return true
		}
	}
	return false
}

// IsWildcardBindHost reports whether host is a wildcard bind address.
func IsWildcardBindHost(host string) bool {
	normalized := normalizeHostname(host)
	for _, w := range wildcardHosts {
		if host == w || normalized == w {
			return true
		}
	}
	return false
}

// IsLoopbackHost reports whether host is a loopback hostname/IP.
func IsLoopbackHost(host string) bool {
	normalized := normalizeHostname(host)
	return normalized != "" && contains(loopbackHosts, normalized)
}

// CreateConfig builds the auth configuration from environment variables.
// env is the environment to read (defaults to os.Environ); nil means os.Getenv.
func CreateConfig(env func(string) string) (*Config, error) {
	get := env
	if get == nil {
		get = os.Getenv
	}

	bindHost := get("HOST")
	if bindHost == "" {
		bindHost = "127.0.0.1"
	}
	if normalizeHostname(bindHost) == "" {
		return nil, errors.New("bind host must be a valid hostname or IP address: " + bindHost)
	}

	token, err := GenerateSessionToken()
	if err != nil {
		return nil, err
	}

	// The server belongs to the machine it runs on: loopback names plus the
	// machine's own hostname and interface addresses are always accepted as
	// browser-visible hosts, so the terminal is reachable via any of the
	// machine's own names without extra configuration.
	allowed := append([]string{}, loopbackHosts...)
	for _, h := range localMachineHosts() {
		allowed, _ = addAllowedHost(allowed, h) // invalid auto-detected names are skipped
	}

	if !IsWildcardBindHost(bindHost) {
		allowed, err = addAllowedHost(allowed, bindHost)
		if err != nil {
			return nil, err
		}
	}

	return &Config{Token: token, BindHost: bindHost, AllowedHosts: allowed}, nil
}

// localMachineHosts lists the hostnames and addresses of the machine the
// server runs on: the OS hostname plus every non-link-local interface
// address.
func localMachineHosts() []string {
	var hosts []string
	if hostname, err := os.Hostname(); err == nil && hostname != "" {
		hosts = append(hosts, hostname)
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
				hosts = append(hosts, ip.String())
			}
		}
	}
	return hosts
}

// ValidateTokenRequest validates a /api/token request. Origin is optional.
func ValidateTokenRequest(cfg *Config, hostHeader, originHeader string) Decision {
	d, _ := validateAllowedHost(cfg, hostHeader)
	if !d.OK {
		return d
	}
	return validateMatchingOrigin(originHeader, hostFromHeader(hostHeader), false)
}

// ValidateWebSocketRequest validates a /ws upgrade. Origin is required.
func ValidateWebSocketRequest(cfg *Config, hostHeader, originHeader, token string) Decision {
	d, host := validateAllowedHost(cfg, hostHeader)
	if !d.OK {
		return d
	}
	d = validateMatchingOrigin(originHeader, host, true)
	if !d.OK {
		return d
	}
	if !safeTokenEquals(cfg.Token, token) {
		return unauthorized()
	}
	return allowed()
}

func hostFromHeader(hostHeader string) Host {
	h, _ := ParseHostHeader(hostHeader)
	return h
}
