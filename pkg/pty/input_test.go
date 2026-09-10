package pty

import "testing"

func TestStripMouseReports(t *testing.T) {
	input := []byte("echo ok\r\x1b[<35;60;41M\x1b[<35;59;41m")
	got := string(StripMouseReports(input))
	if got != "echo ok\r" {
		t.Fatalf("got %q, want ordinary input only", got)
	}
}

func TestStripMouseReportsLeavesKeyboardCSI(t *testing.T) {
	input := []byte("\x1b[A\x1b[5~\x1b[1;5C")
	got := StripMouseReports(input)
	if string(got) != string(input) {
		t.Fatalf("keyboard input changed: got %q, want %q", got, input)
	}
}

func TestStripMouseReportsHandlesLegacyAndUrxvt(t *testing.T) {
	input := []byte("before\x1b[Mabc\x1b[35;60;41Mafter")
	got := string(StripMouseReports(input))
	if got != "beforeafter" {
		t.Fatalf("got %q, want %q", got, "beforeafter")
	}
}
