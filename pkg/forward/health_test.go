package forward

import (
	"fmt"
	"net"
	"testing"
	"time"
)

func freeTCPPort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	_ = ln.Close()
	return port
}

func freeUDPPort(t *testing.T) int {
	t.Helper()
	pc, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := pc.LocalAddr().(*net.UDPAddr).Port
	_ = pc.Close()
	return port
}

func TestNoteHealth(t *testing.T) {
	f := &Forward{}

	// A forward that never reached its target is left alone — the app may
	// simply not have started yet.
	for i := 0; i < healthFailures+2; i++ {
		if f.noteHealth(false) {
			t.Fatal("a never-healthy forward must not be removed")
		}
	}

	if f.noteHealth(true) {
		t.Fatal("a successful probe must not remove the forward")
	}
	for i := 0; i < healthFailures-1; i++ {
		if f.noteHealth(false) {
			t.Fatalf("forward removed after only %d failures", i+1)
		}
	}
	if !f.noteHealth(false) {
		t.Fatalf("forward should be dead after %d consecutive failures", healthFailures)
	}
	if !f.noteHealth(false) {
		t.Fatal("a dead forward must stay dead")
	}
}

func TestManagerAutoRemovesDeadTarget(t *testing.T) {
	target, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer target.Close()
	targetPort := target.Addr().(*net.TCPAddr).Port

	var removed []string
	m := NewManager()
	defer m.Close()
	m.SetOnAutoRemove(func(id, reason string) { removed = append(removed, id) })

	f, err := m.Start(ForwardConfig{
		ExternalPort: freeTCPPort(t),
		InternalHost: "127.0.0.1",
		InternalPort: targetPort,
		Protocol:     "tcp",
	})
	if err != nil {
		t.Fatal(err)
	}

	for i := 0; i < healthFailures; i++ {
		if f.probeTarget() {
			t.Fatal("a live target must not mark the forward dead")
		}
	}

	// The target app exits.
	_ = target.Close()
	for i := 0; i < healthFailures-1; i++ {
		m.probeAll()
		if _, err := m.Status(f.ID); err != nil {
			t.Fatalf("forward removed too early, after %d failures", i+1)
		}
	}
	m.probeAll()
	if _, err := m.Status(f.ID); err == nil {
		t.Fatal("dead forward should have been removed")
	}
	if len(removed) != 1 || removed[0] != f.ID {
		t.Fatalf("auto-remove callback = %v, want [%s]", removed, f.ID)
	}
}

func TestFailedConnectionContributesToHealth(t *testing.T) {
	target, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	targetPort := target.Addr().(*net.TCPAddr).Port

	m := NewManager()
	defer m.Close()
	f, err := m.Start(ForwardConfig{
		ExternalPort: freeTCPPort(t),
		InternalHost: "127.0.0.1",
		InternalPort: targetPort,
		Protocol:     "tcp",
	})
	if err != nil {
		t.Fatal(err)
	}
	if f.probeTarget() {
		t.Fatal("a live target must not mark the forward dead")
	}

	_ = target.Close()
	addr := fmt.Sprintf("127.0.0.1:%d", f.ExternalPort)
	for i := 0; i < healthFailures; i++ {
		conn, err := net.Dial("tcp", addr)
		if err != nil {
			t.Fatal(err)
		}
		_ = conn.Close()
	}

	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if _, err := m.Status(f.ID); err != nil {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("forward should be removed after repeated failed connections")
}

func TestProbeAllSkipsUDP(t *testing.T) {
	m := NewManager()
	defer m.Close()
	f, err := m.Start(ForwardConfig{
		ExternalPort: freeUDPPort(t),
		InternalHost: "127.0.0.1",
		InternalPort: freeUDPPort(t), // nothing is listening there
		Protocol:     "udp",
	})
	if err != nil {
		t.Fatal(err)
	}

	for i := 0; i < healthFailures+1; i++ {
		m.probeAll()
	}
	if _, err := m.Status(f.ID); err != nil {
		t.Fatal("UDP forwards must not be auto-removed by TCP probing")
	}
}
