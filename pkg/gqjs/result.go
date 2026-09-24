package gqjs

import (
	"time"
)

// Result is the outcome of a single request.
type Result struct {
	// Value is the JSON-decoded result value (map/slice/string/number/bool/nil).
	Value any
	// JSON is the raw JSON representation of the result.
	JSON string
	// Stdout holds everything the script wrote via console.log/info/debug.
	Stdout string
	// Stderr holds everything the script wrote via console.warn/error.
	Stderr string
	// Duration is the wall-clock execution time.
	Duration time.Duration
}
