package gqjs

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/fastschema/qjs"
)

//go:embed prelude.js
var preludeSource string

// Runner executes request-scoped JavaScript. It is safe for concurrent use:
// every Run gets its own isolate.
type Runner struct {
	prelude string
}

// New returns a Runner.
func New() *Runner {
	return &Runner{prelude: preludeSource}
}

// Run executes source with the given environment and returns the result.
//
// The script may use top-level await. The handled resolution order is:
//
//  1. a global function named "handler" is called with the `input` value;
//  2. a non-empty module.exports (CommonJS style);
//  3. otherwise the settled top-level evaluation value.
//
// Errors are either *ScriptError, ErrTimeout or ErrOutputLimit.
func (r *Runner) Run(parent context.Context, source string, env Env) (res *Result, err error) {
	env.applyDefaults()
	if parent == nil {
		parent = context.Background()
	}

	runCtx, cancel := context.WithTimeout(parent, env.Timeout)
	defer cancel()

	stdout := &limitedWriter{max: env.MaxOutputBytes}
	stderr := &limitedWriter{max: env.MaxOutputBytes}
	start := time.Now()

	var rt *qjs.Runtime

	// Always recover: qjs panics (and the module becomes unusable) when a
	// deadline closes the Wasm module mid-call.
	defer func() {
		if rec := recover(); rec != nil {
			if runCtx.Err() != nil {
				err = ErrTimeout
			} else {
				err = fmt.Errorf("gqjs: runtime aborted: %v", rec)
			}
			res = nil
		}
		if rt != nil {
			closeRuntime(rt)
		}
	}()

	rt, err = qjs.New(qjs.Option{
		Context:            runCtx,
		CloseOnContextDone: true,
		MemoryLimit:        env.MemoryLimit,
		MaxStackSize:       env.MaxStackSize,
	})
	if err != nil {
		if runCtx.Err() != nil {
			return nil, ErrTimeout
		}
		return nil, fmt.Errorf("gqjs: init runtime: %w", err)
	}

	c := rt.Context()
	bindHost(c, runCtx, env, stdout, stderr)

	if _, err = c.Eval("gqjs:prelude", qjs.Code(r.prelude)); err != nil {
		return nil, classify(runCtx, err)
	}
	if err = injectInput(c, env); err != nil {
		return nil, fmt.Errorf("gqjs: inject input: %w", err)
	}

	top, err := c.Eval("main.js", qjs.Code(source), qjs.FlagAsync())
	if err != nil {
		return nil, classify(runCtx, err)
	}

	result, err := resolveResult(c, top)
	if err != nil {
		return nil, classify(runCtx, err)
	}

	if stdout.overflow || stderr.overflow {
		return nil, ErrOutputLimit
	}

	res = &Result{
		JSON:     stringifyValue(c, result),
		Stdout:   stdout.String(),
		Stderr:   stderr.String(),
		Duration: time.Since(start),
	}
	res.Value = decodeJSON(res.JSON)
	return res, nil
}

func closeRuntime(rt *qjs.Runtime) {
	defer func() { _ = recover() }()
	rt.Close()
}

func classify(ctx context.Context, err error) error {
	if err == nil {
		return nil
	}
	if ctx.Err() != nil ||
		errors.Is(err, context.DeadlineExceeded) ||
		errors.Is(err, context.Canceled) {
		return ErrTimeout
	}
	return newScriptError(err)
}

func injectInput(c *qjs.Context, env Env) error {
	data := env.InputJSON
	if len(data) == 0 && env.Input != nil {
		b, err := json.Marshal(env.Input)
		if err != nil {
			return err
		}
		data = b
	}
	if len(data) == 0 {
		c.Global().SetPropertyStr("input", c.NewNull())
		return nil
	}
	v := c.ParseJSON(string(data))
	if v == nil || v.IsUninitialized() {
		return fmt.Errorf("failed to parse input JSON")
	}
	c.Global().SetPropertyStr("input", v)
	return nil
}

func resolveResult(c *qjs.Context, top *qjs.Value) (*qjs.Value, error) {
	handler := c.Global().GetPropertyStr("handler")
	if handler.IsFunction() {
		input := c.Global().GetPropertyStr("input")
		if input.IsUndefined() {
			input = c.NewNull()
		}
		out, err := c.Invoke(handler, c.NewUndefined(), input)
		if err != nil {
			return nil, err
		}
		if out.IsPromise() {
			return out.Await()
		}
		return out, nil
	}

	mod := c.Global().GetPropertyStr("module")
	if mod.IsObject() {
		exports := mod.GetPropertyStr("exports")
		if exports.IsFunction() {
			return exports, nil
		}
		if exports.IsObject() && !exports.IsArray() {
			if names, err := exports.GetOwnPropertyNames(); err == nil && len(names) > 0 {
				return exports, nil
			}
		}
	}

	if top.IsPromise() {
		return top.Await()
	}
	return top, nil
}

func stringifyValue(c *qjs.Context, v *qjs.Value) string {
	if s, ok := jsonStringify(c, v); ok {
		return s
	}
	if v == nil {
		return "null"
	}
	b, err := json.Marshal(v.String())
	if err != nil {
		return "null"
	}
	return string(b)
}

func decodeJSON(s string) any {
	if s == "" {
		return nil
	}
	var v any
	if err := json.Unmarshal([]byte(s), &v); err != nil {
		return s
	}
	return v
}
