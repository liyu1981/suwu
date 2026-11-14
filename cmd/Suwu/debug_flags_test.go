package main

import (
	"reflect"
	"testing"
	"time"
)

func TestParseDebugFlagsOffByDefault(t *testing.T) {
	cfg, rest, err := parseDebugFlags([]string{"--env-file", "dev.env"})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Enabled {
		t.Error("diagnostics must be off unless asked for")
	}
	if !reflect.DeepEqual(rest, []string{"--env-file", "dev.env"}) {
		t.Errorf("rest = %v, want the arguments untouched", rest)
	}
	if cfg.Addr == "" || cfg.Interval != 2*time.Hour || cfg.Keep == 0 {
		t.Errorf("defaults = %+v, want the documented defaults", cfg)
	}
}

func TestParseDebugFlags(t *testing.T) {
	cases := []struct {
		name string
		args []string
		want debugConfig
		rest []string
	}{
		{
			name: "bare pprof",
			args: []string{"--pprof"},
			want: debugConfig{Enabled: true, Addr: "127.0.0.1:6060", Interval: 2 * time.Hour, Keep: 12},
		},
		{
			name: "pprof with address",
			args: []string{"--pprof=127.0.0.1:6100"},
			want: debugConfig{Enabled: true, Addr: "127.0.0.1:6100", Interval: 2 * time.Hour, Keep: 12},
		},
		{
			name: "separate values",
			args: []string{"--pprof-addr", "localhost:7000", "--heap-dump-interval", "30m", "--heap-dump-keep", "3"},
			want: debugConfig{Enabled: true, Addr: "localhost:7000", Interval: 30 * time.Minute, Keep: 3},
		},
		{
			name: "interval is only a modifier",
			args: []string{"--heap-dump-interval=15m"},
			want: debugConfig{Enabled: false, Addr: "127.0.0.1:6060", Interval: 15 * time.Minute, Keep: 12},
		},
		{
			name: "keeps unrelated arguments and their order",
			args: []string{"--env-file", "a.env", "--pprof", "extra", "--heap-dump-keep", "-1"},
			want: debugConfig{Enabled: true, Addr: "127.0.0.1:6060", Interval: 2 * time.Hour, Keep: -1},
			rest: []string{"--env-file", "a.env", "extra"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, rest, err := parseDebugFlags(tc.args)
			if err != nil {
				t.Fatal(err)
			}
			if got != tc.want {
				t.Errorf("config = %+v, want %+v", got, tc.want)
			}
			if tc.rest != nil && !reflect.DeepEqual(rest, tc.rest) {
				t.Errorf("rest = %v, want %v", rest, tc.rest)
			}
		})
	}
}

func TestParseDebugFlagsErrors(t *testing.T) {
	for _, args := range [][]string{
		{"--heap-dump-interval=10s"}, // below the floor
		{"--heap-dump-interval=nope"},
		{"--heap-dump-keep=abc"},
		{"--pprof-addr"}, // missing value
		{"--heap-dump-interval"},
	} {
		if _, _, err := parseDebugFlags(args); err == nil {
			t.Errorf("parseDebugFlags(%v) succeeded, want an error", args)
		}
	}
}
