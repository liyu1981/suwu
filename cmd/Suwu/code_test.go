package main

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestParseCodeSpec(t *testing.T) {
	tests := []struct {
		name       string
		spec       string
		wantPath   string
		wantRanges []codeRange
		wantErr    bool
	}{
		{name: "bare path", spec: "README.md", wantPath: "README.md"},
		{
			name:       "single range",
			spec:       "src/a.ts:10",
			wantPath:   "src/a.ts",
			wantRanges: []codeRange{{Start: 10, End: 10}},
		},
		{
			name:       "span and multiple ranges",
			spec:       "notes.md:50-55,40-41",
			wantPath:   "notes.md",
			wantRanges: []codeRange{{Start: 50, End: 55}, {Start: 40, End: 41}},
		},
		{name: "colon not a range stays in path", spec: "weird:name.md", wantPath: "weird:name.md"},
		{name: "empty path", spec: "", wantErr: true},
		{name: "zero start", spec: "a.ts:0", wantErr: true},
		{name: "reversed range", spec: "a.ts:20-10", wantErr: true},
		{name: "garbage range", spec: "a.ts:1-x", wantErr: true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			path, ranges, err := parseCodeSpec(tc.spec)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected error, got path=%q ranges=%v", path, ranges)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if path != tc.wantPath {
				t.Fatalf("path = %q, want %q", path, tc.wantPath)
			}
			if !reflect.DeepEqual(ranges, tc.wantRanges) {
				t.Fatalf("ranges = %v, want %v", ranges, tc.wantRanges)
			}
		})
	}
}

func TestCodeSummary(t *testing.T) {
	files := []codeFile{
		{Path: "/tmp/a.ts", Ranges: []codeRange{{Start: 1, End: 2}}},
		{Path: "/tmp/b.md"},
	}
	if got, want := codeSummary(files), "a.ts (1), b.md"; got != want {
		t.Fatalf("codeSummary = %q, want %q", got, want)
	}
}

func TestResolveCodeTargetFiles(t *testing.T) {
	dir := t.TempDir()
	t.Chdir(dir)
	file := filepath.Join(dir, "a.ts")
	if err := os.WriteFile(file, []byte("one\ntwo\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	files, defaultDir, err := resolveCodeTarget([]string{"a.ts:1-2"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(files) != 1 || files[0].Path != file {
		t.Fatalf("files = %+v, want one file at %s", files, file)
	}
	if defaultDir != dir {
		t.Fatalf("defaultDir = %q, want %q", defaultDir, dir)
	}
}

func TestResolveCodeTargetDot(t *testing.T) {
	cwd := t.TempDir()
	t.Chdir(cwd)

	files, defaultDir, err := resolveCodeTarget([]string{"."})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(files) != 0 {
		t.Fatalf("files = %+v, want none", files)
	}
	if defaultDir != cwd {
		t.Fatalf("defaultDir = %q, want %q", defaultDir, cwd)
	}
}

func TestResolveCodeTargetRejectsDirectory(t *testing.T) {
	dir := t.TempDir()

	if _, _, err := resolveCodeTarget([]string{dir}); err == nil {
		t.Fatal("expected error for a directory argument")
	}
}
