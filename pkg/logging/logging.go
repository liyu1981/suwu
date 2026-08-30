// Package logging initialises the global slog logger from the
// SUWU_LOG_LEVEL environment variable. Call Init once at program start.
package logging

import (
	"log/slog"
	"os"
	"strings"
)

type earlyEntry struct {
	msg  string
	attrs []slog.Attr
}

var earlyLog []earlyEntry

// Debug caches a log message before the logger is initialised.
func Debug(msg string, args ...slog.Attr) {
	earlyLog = append(earlyLog, earlyEntry{msg: msg, attrs: args})
}

// Init configures the default slog logger at the default level (error).
func Init() {
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{
		Level: slog.LevelError,
	})))
}

// Reinit re-reads SUWU_LOG_LEVEL from the environment and reconfigures
// the default logger. If debug level is active, flushes cached early logs.
func Reinit() {
	lvl := parseLevel(os.Getenv("SUWU_LOG_LEVEL"))
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{
		Level: lvl,
	})))
	if lvl <= slog.LevelDebug {
		for _, e := range earlyLog {
			anyArgs := make([]any, 0, len(e.attrs))
			for _, a := range e.attrs {
				anyArgs = append(anyArgs, a)
			}
			slog.Debug(e.msg, anyArgs...)
		}
	}
	earlyLog = nil
}

func parseLevel(s string) slog.Level {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "debug":
		return slog.LevelDebug
	case "info":
		return slog.LevelInfo
	case "warn":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelError
	}
}
