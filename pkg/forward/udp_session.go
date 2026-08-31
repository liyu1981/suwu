package forward

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"sync"
	"time"
)

type udpSession struct {
	clientAddr net.Addr
	targetConn net.Conn
	lastActive time.Time
}

type udpSessionManager struct {
	mu         sync.Mutex
	sessions   map[string]*udpSession
	targetHost string
	targetPort int
	timeout    time.Duration
}

func newUDPSessionManager(host string, port int, timeout time.Duration) *udpSessionManager {
	return &udpSessionManager{
		sessions:   make(map[string]*udpSession),
		targetHost: host,
		targetPort: port,
		timeout:    timeout,
	}
}

func (sm *udpSessionManager) getOrCreate(clientAddr net.Addr) (*udpSession, error) {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	key := clientAddr.String()
	if s, ok := sm.sessions[key]; ok {
		s.lastActive = time.Now()
		return s, nil
	}

	targetAddr := fmt.Sprintf("%s:%d", sm.targetHost, sm.targetPort)
	conn, err := net.Dial("udp", targetAddr)
	if err != nil {
		return nil, err
	}

	s := &udpSession{
		clientAddr: clientAddr,
		targetConn: conn,
		lastActive: time.Now(),
	}
	sm.sessions[key] = s
	return s, nil
}

func (sm *udpSessionManager) forward(pc net.PacketConn, clientAddr net.Addr, datagram []byte) {
	session, err := sm.getOrCreate(clientAddr)
	if err != nil {
		slog.Error("udp session create", "client", clientAddr.String(), "err", err)
		return
	}

	if _, err := session.targetConn.Write(datagram); err != nil {
		slog.Error("udp forward to target", "client", clientAddr.String(), "err", err)
		return
	}

	buf := make([]byte, 65535)
	session.targetConn.(net.Conn).SetReadDeadline(time.Now().Add(5 * time.Second))
	n, err := session.targetConn.Read(buf)
	if err != nil {
		return
	}

	pc.WriteTo(buf[:n], clientAddr)
}

func (sm *udpSessionManager) cleanupLoop(ctx context.Context) {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			sm.cleanup()
		}
	}
}

func (sm *udpSessionManager) cleanup() {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	now := time.Now()
	for key, s := range sm.sessions {
		if now.Sub(s.lastActive) > sm.timeout {
			s.targetConn.Close()
			delete(sm.sessions, key)
		}
	}
}

func (sm *udpSessionManager) closeAll() {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	for _, s := range sm.sessions {
		s.targetConn.Close()
	}
	sm.sessions = make(map[string]*udpSession)
}
