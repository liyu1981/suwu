package gqjs

import "errors"

// ErrTimeout is returned when a request exceeds its deadline.
var ErrTimeout = errors.New("gqjs: execution timed out")

// ErrOutputLimit is returned when the script writes more stdout/stderr than
// the configured limit.
var ErrOutputLimit = errors.New("gqjs: output limit exceeded")

// ScriptError wraps an error raised by JavaScript.
type ScriptError struct {
	Message string
}

func (e *ScriptError) Error() string { return "gqjs: " + e.Message }

func newScriptError(err error) *ScriptError {
	if err == nil {
		return nil
	}
	return &ScriptError{Message: err.Error()}
}
