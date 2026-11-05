package server

import (
	"net"
	"strings"
	"sync"
	"time"
)

// clientGate remembers which client IPs have recently authenticated against
// Suwu. The unauthenticated static-preview route is restricted to loopback and
// those IPs, so a LAN client must open Suwu in its browser before it can browse
// a served folder. Static requests refresh the entry, keeping an active preview
// alive without extending credentials to unrelated clients.
type clientGate struct {
	mu    sync.Mutex
	seen  map[string]time.Time
	ttl   time.Duration
	limit int
}

func newClientGate(ttl time.Duration) *clientGate {
	return &clientGate{seen: make(map[string]time.Time), ttl: ttl, limit: 1024}
}

func (g *clientGate) Touch(remoteAddr string) {
	ip := remoteIP(remoteAddr)
	if ip == "" {
		return
	}
	now := time.Now()
	g.mu.Lock()
	defer g.mu.Unlock()
	if len(g.seen) > g.limit {
		for candidate, expires := range g.seen {
			if now.After(expires) {
				delete(g.seen, candidate)
			}
		}
	}
	g.seen[ip] = now.Add(g.ttl)
}

func (g *clientGate) Allow(remoteAddr string) bool {
	ip := remoteIP(remoteAddr)
	if ip == "" {
		return false
	}
	if parsed := net.ParseIP(ip); parsed != nil && parsed.IsLoopback() {
		return true
	}
	now := time.Now()
	g.mu.Lock()
	defer g.mu.Unlock()
	expires, ok := g.seen[ip]
	if !ok {
		return false
	}
	if now.After(expires) {
		delete(g.seen, ip)
		return false
	}
	return true
}

func remoteIP(remoteAddr string) string {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		host = remoteAddr
	}
	host = strings.Trim(strings.TrimSpace(host), "[]")
	ip := net.ParseIP(host)
	if ip == nil {
		return ""
	}
	return ip.String()
}
