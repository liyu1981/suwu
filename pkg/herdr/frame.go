// Package herdr is a client of herdr-core (`herdr-core`, the `hc` CLI), the
// daemon that keeps terminals alive for coding agents.
//
// Suwu is the only client in this deployment: core listens on a local Unix
// socket with no API password of its own (docs/security.md in the herdr-core
// repository), so the browser never talks to it — this package does, and the
// server re-exports a narrow, authenticated view of it.
//
// The protocol is JSON-RPC 2.0. A connection starts in plain mode (one JSON
// message per line) and `hello {framed:true}` switches it to framed mode after
// the reply: every frame is [channel u32 LE][kind u8][len u32 LE][payload], with
// DATA carrying terminal bytes on an attach channel. See docs/BAIKAL_PLAN.md.
package herdr

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
)

// Frame kinds (herdr-core schema/README.md, "Framed mode").
const (
	KindData           byte = 0
	KindCredit         byte = 1
	KindClose          byte = 2
	KindResize         byte = 3
	KindFocus          byte = 4
	KindFacts          byte = 5
	KindAutomaticInput byte = 6
)

// MaxFramePayload mirrors core's limit.
const MaxFramePayload = 16 << 20

// Frame is one framed-mode message.
type Frame struct {
	Channel uint32
	Kind    byte
	Payload []byte
}

const frameHeaderLen = 9 // u32 + u8 + u32

// writeFrame writes one frame. The caller is responsible for serialising writes
// to a connection (Conn does it with a mutex).
func writeFrame(w io.Writer, f Frame) error {
	if len(f.Payload) > MaxFramePayload {
		return fmt.Errorf("herdr: frame payload %d exceeds %d", len(f.Payload), MaxFramePayload)
	}
	var hdr [frameHeaderLen]byte
	binary.LittleEndian.PutUint32(hdr[0:4], f.Channel)
	hdr[4] = f.Kind
	binary.LittleEndian.PutUint32(hdr[5:9], uint32(len(f.Payload)))
	if _, err := w.Write(hdr[:]); err != nil {
		return err
	}
	if len(f.Payload) > 0 {
		if _, err := w.Write(f.Payload); err != nil {
			return err
		}
	}
	return nil
}

// readFrame reads one frame from r.
func readFrame(r io.Reader) (Frame, error) {
	var hdr [frameHeaderLen]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return Frame{}, err
	}
	length := binary.LittleEndian.Uint32(hdr[5:9])
	if length > MaxFramePayload {
		return Frame{}, fmt.Errorf("herdr: frame payload %d exceeds %d", length, MaxFramePayload)
	}
	f := Frame{Channel: binary.LittleEndian.Uint32(hdr[0:4]), Kind: hdr[4]}
	if length > 0 {
		f.Payload = make([]byte, length)
		if _, err := io.ReadFull(r, f.Payload); err != nil {
			return Frame{}, err
		}
	}
	return f, nil
}

// creditPayload builds a CREDIT frame payload: bytes the viewer consumed.
func creditPayload(n int) []byte {
	var b [4]byte
	binary.LittleEndian.PutUint32(b[:], uint32(n))
	return b[:]
}

// resizePayload builds a RESIZE frame payload: cols, rows.
func resizePayload(cols, rows int) []byte {
	var b [4]byte
	binary.LittleEndian.PutUint16(b[0:2], uint16(cols))
	binary.LittleEndian.PutUint16(b[2:4], uint16(rows))
	return b[:]
}

// closeReason decodes the JSON reason of a core CLOSE frame, if any.
func closeReason(payload []byte) string {
	if len(payload) == 0 {
		return ""
	}
	return string(payload)
}

// errClosed is returned by writes after the connection is gone.
var errClosed = errors.New("herdr: connection closed")
