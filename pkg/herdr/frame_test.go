package herdr

import (
	"bytes"
	"encoding/binary"
	"io"
	"testing"
)

func TestFrameRoundTrip(t *testing.T) {
	var buf bytes.Buffer
	want := Frame{Channel: 7, Kind: KindData, Payload: []byte("hello")}
	if err := writeFrame(&buf, want); err != nil {
		t.Fatal(err)
	}
	got, err := readFrame(&buf)
	if err != nil {
		t.Fatal(err)
	}
	if got.Channel != want.Channel || got.Kind != want.Kind || string(got.Payload) != "hello" {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestFrameHeaderLayout(t *testing.T) {
	var buf bytes.Buffer
	if err := writeFrame(&buf, Frame{Channel: 0x01020304, Kind: KindResize, Payload: []byte{0xAA}}); err != nil {
		t.Fatal(err)
	}
	b := buf.Bytes()
	if len(b) != frameHeaderLen+1 {
		t.Fatalf("len = %d", len(b))
	}
	if binary.LittleEndian.Uint32(b[0:4]) != 0x01020304 {
		t.Error("channel is not little-endian u32")
	}
	if b[4] != KindResize {
		t.Error("kind byte in the wrong place")
	}
	if binary.LittleEndian.Uint32(b[5:9]) != 1 {
		t.Error("length is not little-endian u32")
	}
	if b[9] != 0xAA {
		t.Error("payload follows the header")
	}
}

func TestFrameReadSplitAcrossReads(t *testing.T) {
	var buf bytes.Buffer
	if err := writeFrame(&buf, Frame{Channel: 3, Kind: KindData, Payload: []byte("abcdef")}); err != nil {
		t.Fatal(err)
	}
	// A reader that yields one byte at a time models a pipe that hands over
	// partial frames.
	r := &slowReader{data: buf.Bytes()}
	got, err := readFrame(r)
	if err != nil {
		t.Fatal(err)
	}
	if string(got.Payload) != "abcdef" {
		t.Fatalf("payload = %q", got.Payload)
	}
}

func TestFrameRejectsOversizedPayload(t *testing.T) {
	hdr := make([]byte, frameHeaderLen)
	binary.LittleEndian.PutUint32(hdr[0:4], 1)
	hdr[4] = KindData
	binary.LittleEndian.PutUint32(hdr[5:9], MaxFramePayload+1)
	if _, err := readFrame(bytes.NewReader(hdr)); err == nil {
		t.Fatal("want an error for an oversized frame")
	}
	if err := writeFrame(io.Discard, Frame{Payload: make([]byte, MaxFramePayload+1)}); err == nil {
		t.Fatal("want an error writing an oversized frame")
	}
}

func TestResizeAndCreditPayloads(t *testing.T) {
	r := resizePayload(120, 40)
	if binary.LittleEndian.Uint16(r[0:2]) != 120 || binary.LittleEndian.Uint16(r[2:4]) != 40 {
		t.Errorf("resize payload = %v", r)
	}
	c := creditPayload(4096)
	if binary.LittleEndian.Uint32(c) != 4096 {
		t.Errorf("credit payload = %v", c)
	}
}

type slowReader struct {
	data []byte
	pos  int
}

func (r *slowReader) Read(p []byte) (int, error) {
	if r.pos >= len(r.data) {
		return 0, io.EOF
	}
	if len(p) == 0 {
		return 0, nil
	}
	p[0] = r.data[r.pos]
	r.pos++
	return 1, nil
}
