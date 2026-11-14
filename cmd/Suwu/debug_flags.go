package main

import (
	"fmt"
	"strconv"
	"strings"
	"time"

	"suwu/pkg/diagnostics"
)

// Hidden debug flags.
//
// These are parsed by hand, before the flag package sees the arguments, so they
// never appear in `suwu serve -h`. The reason is not coyness: a heap profile
// names every type and every stack in the process, so this switch should be a
// deliberate act, not something a user finds in the help text and leaves on.
// They are documented in docs/MEMORY_GROWTH_INVESTIGATION.md §7.
//
//	--pprof                     enable the pprof listener + periodic snapshots
//	--pprof=127.0.0.1:6061      same, on a specific loopback address
//	--pprof-addr=HOST:PORT      set the address (also enables it)
//	--heap-dump-interval=2h     how often to write a snapshot (minimum 1m)
//	--heap-dump-keep=12         how many snapshots to retain (negative: all)
const (
	flagPprof        = "--pprof"
	flagPprofAddr    = "--pprof-addr"
	flagHeapInterval = "--heap-dump-interval"
	flagHeapKeep     = "--heap-dump-keep"
)

// debugConfig is what the hidden flags resolve to.
type debugConfig struct {
	Enabled  bool
	Addr     string
	Interval time.Duration
	Keep     int
}

func defaultDebugConfig() debugConfig {
	return debugConfig{
		Addr:     diagnostics.DefaultAddr,
		Interval: diagnostics.DefaultInterval,
		Keep:     diagnostics.DefaultKeep,
	}
}

// parseDebugFlags consumes the hidden flags from args and returns everything
// that remains, plus the resolved configuration. Both "--flag=value" and
// "--flag value" are accepted. Unknown flags are left untouched for the flag
// package.
func parseDebugFlags(args []string) (debugConfig, []string, error) {
	cfg := defaultDebugConfig()
	rest := make([]string, 0, len(args))

	for i := 0; i < len(args); i++ {
		arg := args[i]
		value := ""
		hasValue := false
		if name, v, ok := strings.Cut(arg, "="); ok {
			arg, value, hasValue = name, v, true
		}

		switch arg {
		case flagPprof:
			cfg.Enabled = true
			if hasValue {
				cfg.Addr = value
			}
		case flagPprofAddr, flagHeapInterval, flagHeapKeep:
			if !hasValue {
				if i+1 >= len(args) {
					return cfg, rest, fmt.Errorf("%s needs a value", arg)
				}
				i++
				value = args[i]
			}
			switch arg {
			case flagPprofAddr:
				cfg.Addr = value
				cfg.Enabled = true
			case flagHeapInterval:
				d, err := time.ParseDuration(value)
				if err != nil {
					return cfg, rest, fmt.Errorf("%s: %w", arg, err)
				}
				if d < time.Minute {
					return cfg, rest, fmt.Errorf("%s: %s is shorter than the 1m minimum", arg, d)
				}
				cfg.Interval = d
			case flagHeapKeep:
				n, err := strconv.Atoi(value)
				if err != nil {
					return cfg, rest, fmt.Errorf("%s: %w", arg, err)
				}
				cfg.Keep = n
			}
		default:
			rest = append(rest, args[i])
		}
	}
	return cfg, rest, nil
}
