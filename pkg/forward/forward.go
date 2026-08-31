package forward

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net"
	"sync/atomic"
	"time"
)

type Forward struct {
	ID           string       `json:"id"`
	ExternalPort int          `json:"externalPort"`
	InternalHost string       `json:"internalHost"`
	InternalPort int          `json:"internalPort"`
	Protocol     string       `json:"protocol"`
	Status       string       `json:"status"`
	Error        string       `json:"error,omitempty"`
	ActiveConns  atomic.Int64 `json:"-"`
	TotalConns   atomic.Int64 `json:"-"`
	StartedAt    time.Time    `json:"-"`
	listener     net.Listener
	packetConn   net.PacketConn
	cancel       context.CancelFunc
}

func (f *Forward) Start(ctx context.Context) error {
	ctx, f.cancel = context.WithCancel(ctx)
	f.Status = "running"
	f.StartedAt = time.Now()

	addr := fmt.Sprintf(":%d", f.ExternalPort)

	if f.Protocol == "tcp" {
		return f.startTCP(ctx, addr)
	}
	return f.startUDP(ctx, addr)
}

func (f *Forward) startTCP(ctx context.Context, addr string) error {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		f.Status = "error"
		f.Error = err.Error()
		return err
	}
	f.listener = ln

	go f.acceptLoop(ctx, ln)
	return nil
}

func (f *Forward) acceptLoop(ctx context.Context, ln net.Listener) {
	for {
		conn, err := ln.Accept()
		if err != nil {
			select {
			case <-ctx.Done():
				return
			default:
				slog.Error("forward tcp accept", "id", f.ID, "err", err)
				continue
			}
		}
		f.ActiveConns.Add(1)
		f.TotalConns.Add(1)
		go f.handleTCPConn(ctx, conn)
	}
}

func (f *Forward) handleTCPConn(ctx context.Context, clientConn net.Conn) {
	defer func() {
		clientConn.Close()
		f.ActiveConns.Add(-1)
	}()

	targetAddr := fmt.Sprintf("%s:%d", f.InternalHost, f.InternalPort)
	targetConn, err := net.Dial("tcp", targetAddr)
	if err != nil {
		slog.Error("forward tcp dial", "id", f.ID, "target", targetAddr, "err", err)
		return
	}
	defer targetConn.Close()

	done := make(chan struct{}, 2)

	go func() {
		io.Copy(targetConn, clientConn)
		done <- struct{}{}
	}()
	go func() {
		io.Copy(clientConn, targetConn)
		done <- struct{}{}
	}()

	select {
	case <-done:
	case <-ctx.Done():
	}
}

func (f *Forward) startUDP(ctx context.Context, addr string) error {
	pc, err := net.ListenPacket("udp", addr)
	if err != nil {
		f.Status = "error"
		f.Error = err.Error()
		return err
	}
	f.packetConn = pc

	sm := newUDPSessionManager(f.InternalHost, f.InternalPort, 60*time.Second)
	go f.readLoop(ctx, pc, sm)
	go sm.cleanupLoop(ctx)
	return nil
}

func (f *Forward) readLoop(ctx context.Context, pc net.PacketConn, sm *udpSessionManager) {
	buf := make([]byte, 65535)
	for {
		select {
		case <-ctx.Done():
			pc.Close()
			sm.closeAll()
			return
		default:
		}

		pc.SetReadDeadline(time.Now().Add(1 * time.Second))
		n, clientAddr, err := pc.ReadFrom(buf)
		if err != nil {
			continue
		}

		datagram := make([]byte, n)
		copy(datagram, buf[:n])

		f.TotalConns.Add(1)
		f.ActiveConns.Add(1)

		go func() {
			defer f.ActiveConns.Add(-1)
			sm.forward(pc, clientAddr, datagram)
		}()
	}
}

func (f *Forward) Stop() {
	if f.cancel != nil {
		f.cancel()
	}
	if f.listener != nil {
		f.listener.Close()
	}
	if f.packetConn != nil {
		f.packetConn.Close()
	}
	f.Status = "stopped"
}
