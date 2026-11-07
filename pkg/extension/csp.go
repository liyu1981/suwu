package extension

import (
	"fmt"
	"net"
	"net/url"
	"sort"
	"strconv"
	"strings"
)

// Extendable CSP directives. The extension may add sources to these; the
// backend always keeps its own core sources in front of them.
var extendableCSPDirectives = map[string]bool{
	"script-src":   true,
	"style-src":    true,
	"img-src":      true,
	"font-src":     true,
	"connect-src":  true,
	"media-src":    true,
	"worker-src":   true,
	"child-src":    true,
	"frame-src":    true,
	"manifest-src": true,
}

// Fixed CSP directives. An extension must never be able to relax these.
var forbiddenCSPDirectives = map[string]bool{
	"default-src":               true,
	"sandbox":                   true,
	"frame-ancestors":           true,
	"base-uri":                  true,
	"object-src":                true,
	"form-action":               true,
	"report-uri":                true,
	"report-to":                 true,
	"require-trusted-types-for": true,
	"trusted-types":             true,
	"upgrade-insecure-requests": true,
	"block-all-mixed-content":   true,
}

// Sandbox extras an extension may request. Keep this deliberately tiny:
// capabilities like allow-same-origin or allow-top-navigation would defeat the
// opaque-origin boundary and must never be declared by an extension.
// Kept deliberately tiny — every entry here is a capability the opaque-origin
// boundary would otherwise deny.
var allowedSandboxExtras = map[string]bool{
	// Exporting is a normal thing for a document tile to do.
	"allow-downloads": true,
	// allow-modals is what makes window.print() work inside a sandboxed frame
	// (Chrome treats print as a modal), which is how a document app produces a
	// PDF, and what a password prompt needs. The cost is that a hostile
	// extension can open dialogs and block its own tab until dismissed — a
	// nuisance confined to the tile, and only for an extension the user chose to
	// install. Bento Slides needs both.
	"allow-modals": true,
}

const (
	maxCSPDirectives   = 16
	maxCSPSources      = 32
	maxCSPSourceLength = 512
	maxSandboxExtras   = 8
)

// normalizeCSP validates and canonicalizes suwu.csp. Empty input is allowed.
// Unknown/forbidden directives and invalid source expressions fail resolution
// so a typo can never silently grant or drop a capability.
func normalizeCSP(in map[string][]string) (map[string][]string, error) {
	if len(in) == 0 {
		return nil, nil
	}
	if len(in) > maxCSPDirectives {
		return nil, fmt.Errorf("suwu.csp has too many directives (max %d)", maxCSPDirectives)
	}
	out := make(map[string][]string, len(in))
	for directive, sources := range in {
		if forbiddenCSPDirectives[directive] {
			return nil, fmt.Errorf("suwu.csp directive %q is fixed by Suwu and cannot be declared", directive)
		}
		if !extendableCSPDirectives[directive] {
			return nil, fmt.Errorf("suwu.csp directive %q is not supported", directive)
		}
		if len(sources) == 0 {
			return nil, fmt.Errorf("suwu.csp directive %q has no sources", directive)
		}
		if len(sources) > maxCSPSources {
			return nil, fmt.Errorf("suwu.csp directive %q has too many sources (max %d)", directive, maxCSPSources)
		}
		seen := make(map[string]bool, len(sources))
		clean := make([]string, 0, len(sources))
		for _, source := range sources {
			if source == "" || source != strings.TrimSpace(source) {
				return nil, fmt.Errorf("suwu.csp directive %q has an empty or padded source", directive)
			}
			if len(source) > maxCSPSourceLength {
				return nil, fmt.Errorf("suwu.csp directive %q has an overlong source", directive)
			}
			if !validCSPSource(source) {
				return nil, fmt.Errorf("suwu.csp directive %q has invalid source %q", directive, source)
			}
			if seen[source] {
				continue
			}
			seen[source] = true
			clean = append(clean, source)
		}
		sort.Strings(clean)
		out[directive] = clean
	}
	return out, nil
}

func normalizeSandbox(in []string) ([]string, error) {
	if len(in) == 0 {
		return nil, nil
	}
	if len(in) > maxSandboxExtras {
		return nil, fmt.Errorf("suwu.sandbox has too many extras (max %d)", maxSandboxExtras)
	}
	seen := make(map[string]bool, len(in))
	out := make([]string, 0, len(in))
	for _, token := range in {
		if token == "" || token != strings.TrimSpace(token) {
			return nil, fmt.Errorf("suwu.sandbox has an empty or padded token")
		}
		if !allowedSandboxExtras[token] {
			return nil, fmt.Errorf("suwu.sandbox token %q is not allowed", token)
		}
		if seen[token] {
			continue
		}
		seen[token] = true
		out = append(out, token)
	}
	sort.Strings(out)
	return out, nil
}

// validCSPSource accepts the small set of source expressions extensions
// actually need. Bare "*" and other broad sources are rejected on purpose.
func validCSPSource(source string) bool {
	if strings.ContainsAny(source, " \t\r\n;") {
		return false
	}
	switch source {
	case "'self'", "'unsafe-eval'", "'wasm-unsafe-eval'", "'unsafe-hashes'":
		return true
	case "http:", "https:", "ws:", "wss:", "data:", "blob:", "mediastream:", "filesystem:":
		return true
	}
	if strings.HasPrefix(source, "'") {
		return false
	}

	u, err := url.Parse(source)
	if err != nil || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return false
	}
	switch u.Scheme {
	case "http", "https", "ws", "wss":
	default:
		return false
	}
	if u.Host == "" {
		return false
	}
	host := u.Hostname()
	if host == "" {
		return false
	}
	if ip := net.ParseIP(host); ip == nil {
		labels := strings.Split(host, ".")
		if len(labels) == 1 && labels[0] == "*" {
			return false
		}
		for _, label := range labels {
			if label == "*" {
				continue
			}
			if label == "" || len(label) > 63 {
				return false
			}
			if !isDNSLabel(label) {
				return false
			}
		}
	}
	if port := u.Port(); port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || n < 1 || n > 65535 {
			return false
		}
	}
	if strings.ContainsAny(u.Path, " \\") || strings.Contains(u.Path, "*") {
		return false
	}
	return true
}

func isDNSLabel(label string) bool {
	if label == "" {
		return false
	}
	for i, r := range label {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case r == '-' && i > 0 && i < len(label)-1:
		default:
			return false
		}
	}
	return true
}
