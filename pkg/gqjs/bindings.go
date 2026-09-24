package gqjs

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/fastschema/qjs"
)

// limitedWriter is a single-threaded output buffer with a hard cap.
type limitedWriter struct {
	buf      bytes.Buffer
	max      int
	overflow bool
}

func (w *limitedWriter) Write(p []byte) (int, error) {
	if w.max > 0 && w.buf.Len()+len(p) > w.max {
		remaining := w.max - w.buf.Len()
		if remaining > 0 {
			w.buf.Write(p[:remaining])
		}
		w.overflow = true
		return len(p), nil
	}
	w.buf.Write(p)
	return len(p), nil
}

func (w *limitedWriter) String() string { return w.buf.String() }

// jsonStringify renders a JS value using the engine's JSON.stringify.
//
// It deliberately avoids qjs's native QJS_JSONStringify helper, which has a
// use-after-free bug: it frees the backing C string before returning a pointer
// to it, corrupting results non-deterministically.
func jsonStringify(c *qjs.Context, v *qjs.Value) (string, bool) {
	if v == nil || v.IsUndefined() || v.IsNull() {
		return "null", true
	}
	jsonObj := c.Global().GetPropertyStr("JSON")
	stringify := jsonObj.GetPropertyStr("stringify")
	if !stringify.IsFunction() {
		return "", false
	}
	out, err := c.Invoke(stringify, jsonObj, v)
	if err != nil || out == nil || out.IsUndefined() || out.IsNull() {
		return "", false
	}
	return out.String(), true
}

// jsToString renders a JS value the way console.log would.
func jsToString(c *qjs.Context, v *qjs.Value) string {
	if v == nil {
		return "undefined"
	}
	if v.IsString() {
		return v.String()
	}
	if v.IsObject() || v.IsArray() || v.IsMap() || v.IsSet() {
		if s, ok := jsonStringify(c, v); ok && s != "" {
			return s
		}
	}
	return v.String()
}

func consoleFn(c *qjs.Context, w *limitedWriter) *qjs.Value {
	return c.Function(func(this *qjs.This) (*qjs.Value, error) {
		args := this.Args()
		parts := make([]string, 0, len(args))
		for _, a := range args {
			parts = append(parts, jsToString(this.Context(), a))
		}
		fmt.Fprintln(w, strings.Join(parts, " "))
		return this.Context().NewUndefined(), nil
	})
}

// bindHost installs console, process, fs, path and internal primitives.
func bindHost(c *qjs.Context, ctx context.Context, env Env, stdout, stderr *limitedWriter) {
	global := c.Global()

	console := c.NewObject()
	console.SetPropertyStr("log", consoleFn(c, stdout))
	console.SetPropertyStr("info", consoleFn(c, stdout))
	console.SetPropertyStr("debug", consoleFn(c, stdout))
	console.SetPropertyStr("warn", consoleFn(c, stderr))
	console.SetPropertyStr("error", consoleFn(c, stderr))
	global.SetPropertyStr("console", console)

	global.SetPropertyStr("process", buildProcess(c, env))
	global.SetPropertyStr("fs", buildFS(c, env))
	global.SetPropertyStr("path", buildPath(c, env))

	q := c.NewObject()
	q.SetPropertyStr("sleep", c.Function(func(this *qjs.This) (*qjs.Value, error) {
		var ms int64
		if args := this.Args(); len(args) > 0 {
			ms = args[0].Int64()
		}
		if ms < 0 {
			ms = 0
		}
		if ms > 0 {
			timer := time.NewTimer(time.Duration(ms) * time.Millisecond)
			defer timer.Stop()
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-timer.C:
			}
		}
		return this.Context().NewUndefined(), nil
	}))
	bindFetch(c, q, ctx, env)
	global.SetPropertyStr("__gqjs", q)
}

func buildProcess(c *qjs.Context, env Env) *qjs.Value {
	proc := c.NewObject()

	envObj := c.NewObject()
	for k, v := range env.Vars {
		envObj.SetPropertyStr(k, c.NewString(v))
	}
	proc.SetPropertyStr("env", envObj)

	argv := c.NewArray()
	for _, a := range env.Args {
		argv.Push(c.NewString(a))
	}
	proc.SetPropertyStr("argv", argv.Value)

	proc.SetPropertyStr("cwd", c.Function(func(this *qjs.This) (*qjs.Value, error) {
		return this.Context().NewString(env.CWD), nil
	}))
	proc.SetPropertyStr("platform", c.NewString(runtime.GOOS))
	proc.SetPropertyStr("pid", c.NewInt32(int32(os.Getpid())))
	proc.SetPropertyStr("version", c.NewString("gqjs"))
	return proc
}

func buildFS(c *qjs.Context, env Env) *qjs.Value {
	fs := c.NewObject()

	fs.SetPropertyStr("readFileSync", c.Function(func(this *qjs.This) (*qjs.Value, error) {
		args := this.Args()
		if len(args) == 0 {
			return nil, fmt.Errorf("readFileSync: missing path")
		}
		real, err := env.resolveVirtualPath(args[0].String())
		if err != nil {
			return nil, err
		}
		data, err := os.ReadFile(real)
		if err != nil {
			return nil, err
		}
		if len(args) > 1 && !args[1].IsUndefined() && !args[1].IsNull() {
			if enc := args[1].String(); enc == "buffer" || enc == "binary" {
				return this.Context().NewArrayBuffer(data), nil
			}
		}
		return this.Context().NewString(string(data)), nil
	}))

	fs.SetPropertyStr("existsSync", c.Function(func(this *qjs.This) (*qjs.Value, error) {
		args := this.Args()
		if len(args) == 0 {
			return this.Context().NewBool(false), nil
		}
		real, err := env.resolveVirtualPath(args[0].String())
		if err != nil {
			return this.Context().NewBool(false), nil
		}
		_, statErr := os.Stat(real)
		return this.Context().NewBool(statErr == nil), nil
	}))

	fs.SetPropertyStr("readdirSync", c.Function(func(this *qjs.This) (*qjs.Value, error) {
		args := this.Args()
		if len(args) == 0 {
			return nil, fmt.Errorf("readdirSync: missing path")
		}
		real, err := env.resolveVirtualPath(args[0].String())
		if err != nil {
			return nil, err
		}
		entries, err := os.ReadDir(real)
		if err != nil {
			return nil, err
		}
		names := make([]string, 0, len(entries))
		for _, e := range entries {
			names = append(names, e.Name())
		}
		sort.Strings(names)
		arr := this.Context().NewArray()
		for _, n := range names {
			arr.Push(this.Context().NewString(n))
		}
		return arr.Value, nil
	}))

	fs.SetPropertyStr("statSync", c.Function(func(this *qjs.This) (*qjs.Value, error) {
		args := this.Args()
		if len(args) == 0 {
			return nil, fmt.Errorf("statSync: missing path")
		}
		real, err := env.resolveVirtualPath(args[0].String())
		if err != nil {
			return nil, err
		}
		st, err := os.Stat(real)
		if err != nil {
			return nil, err
		}
		obj := this.Context().NewObject()
		obj.SetPropertyStr("size", this.Context().NewInt64(st.Size()))
		obj.SetPropertyStr("mtimeMs", this.Context().NewFloat64(float64(st.ModTime().UnixMilli())))
		obj.SetPropertyStr("isFile", this.Context().Function(func(*qjs.This) (*qjs.Value, error) {
			return this.Context().NewBool(st.Mode().IsRegular()), nil
		}))
		obj.SetPropertyStr("isDirectory", this.Context().Function(func(*qjs.This) (*qjs.Value, error) {
			return this.Context().NewBool(st.IsDir()), nil
		}))
		return obj, nil
	}))

	if !env.FS.ReadOnly {
		fs.SetPropertyStr("writeFileSync", c.Function(func(this *qjs.This) (*qjs.Value, error) {
			args := this.Args()
			if len(args) < 2 {
				return nil, fmt.Errorf("writeFileSync: missing arguments")
			}
			real, err := env.resolveVirtualPath(args[0].String())
			if err != nil {
				return nil, err
			}
			var data []byte
			if args[1].IsByteArray() {
				data = args[1].ToByteArray()
			} else {
				data = []byte(args[1].String())
			}
			if err := os.WriteFile(real, data, 0o644); err != nil {
				return nil, err
			}
			return this.Context().NewUndefined(), nil
		}))

		fs.SetPropertyStr("unlinkSync", c.Function(func(this *qjs.This) (*qjs.Value, error) {
			args := this.Args()
			if len(args) == 0 {
				return nil, fmt.Errorf("unlinkSync: missing path")
			}
			real, err := env.resolveVirtualPath(args[0].String())
			if err != nil {
				return nil, err
			}
			return this.Context().NewUndefined(), os.Remove(real)
		}))

		fs.SetPropertyStr("mkdirSync", c.Function(func(this *qjs.This) (*qjs.Value, error) {
			args := this.Args()
			if len(args) == 0 {
				return nil, fmt.Errorf("mkdirSync: missing path")
			}
			real, err := env.resolveVirtualPath(args[0].String())
			if err != nil {
				return nil, err
			}
			recursive := false
			if len(args) > 1 && args[1].IsObject() {
				recursive = args[1].GetPropertyStr("recursive").Bool()
			}
			if recursive {
				return this.Context().NewUndefined(), os.MkdirAll(real, 0o755)
			}
			return this.Context().NewUndefined(), os.Mkdir(real, 0o755)
		}))
	}

	return fs
}

func buildPath(c *qjs.Context, env Env) *qjs.Value {
	p := c.NewObject()
	p.SetPropertyStr("sep", c.NewString("/"))
	p.SetPropertyStr("delimiter", c.NewString(":"))

	p.SetPropertyStr("join", c.Function(func(this *qjs.This) (*qjs.Value, error) {
		parts := make([]string, 0, len(this.Args()))
		for _, a := range this.Args() {
			parts = append(parts, a.String())
		}
		return this.Context().NewString(path.Join(parts...)), nil
	}))

	p.SetPropertyStr("basename", c.Function(func(this *qjs.This) (*qjs.Value, error) {
		args := this.Args()
		if len(args) == 0 {
			return this.Context().NewString(""), nil
		}
		base := path.Base(args[0].String())
		if len(args) > 1 {
			ext := args[1].String()
			if ext != "" && strings.HasSuffix(base, ext) {
				base = base[:len(base)-len(ext)]
			}
		}
		return this.Context().NewString(base), nil
	}))

	p.SetPropertyStr("dirname", c.Function(func(this *qjs.This) (*qjs.Value, error) {
		args := this.Args()
		if len(args) == 0 {
			return this.Context().NewString("."), nil
		}
		return this.Context().NewString(path.Dir(args[0].String())), nil
	}))

	p.SetPropertyStr("extname", c.Function(func(this *qjs.This) (*qjs.Value, error) {
		args := this.Args()
		if len(args) == 0 {
			return this.Context().NewString(""), nil
		}
		base := path.Base(args[0].String())
		i := strings.LastIndex(base, ".")
		if i <= 0 {
			return this.Context().NewString(""), nil
		}
		return this.Context().NewString(base[i:]), nil
	}))

	p.SetPropertyStr("normalize", c.Function(func(this *qjs.This) (*qjs.Value, error) {
		args := this.Args()
		if len(args) == 0 || args[0].String() == "" {
			return this.Context().NewString("."), nil
		}
		return this.Context().NewString(path.Clean(args[0].String())), nil
	}))

	p.SetPropertyStr("isAbsolute", c.Function(func(this *qjs.This) (*qjs.Value, error) {
		args := this.Args()
		if len(args) == 0 {
			return this.Context().NewBool(false), nil
		}
		return this.Context().NewBool(strings.HasPrefix(args[0].String(), "/")), nil
	}))

	p.SetPropertyStr("resolve", c.Function(func(this *qjs.This) (*qjs.Value, error) {
		parts := make([]string, 0, len(this.Args()))
		for _, a := range this.Args() {
			parts = append(parts, a.String())
		}
		return this.Context().NewString(pathResolve(env.CWD, parts...)), nil
	}))

	p.SetPropertyStr("relative", c.Function(func(this *qjs.This) (*qjs.Value, error) {
		args := this.Args()
		if len(args) < 2 {
			return this.Context().NewString(""), nil
		}
		return this.Context().NewString(pathRelative(args[0].String(), args[1].String())), nil
	}))

	return p
}

func pathResolve(cwd string, parts ...string) string {
	resolved := ""
	found := false
	for i := len(parts) - 1; i >= 0 && !found; i-- {
		part := parts[i]
		if part == "" {
			continue
		}
		if resolved == "" {
			resolved = part
		} else {
			resolved = part + "/" + resolved
		}
		if strings.HasPrefix(part, "/") {
			found = true
		}
	}
	if !found {
		if resolved == "" {
			resolved = cwd
		} else {
			resolved = cwd + "/" + resolved
		}
	}
	return path.Clean(resolved)
}

func pathRelative(from, to string) string {
	if from == to {
		return ""
	}
	fromParts := splitPath(path.Clean(from))
	toParts := splitPath(path.Clean(to))
	i := 0
	for i < len(fromParts) && i < len(toParts) && fromParts[i] == toParts[i] {
		i++
	}
	segs := make([]string, 0, len(fromParts)-i+len(toParts)-i)
	for j := 0; j < len(fromParts)-i; j++ {
		segs = append(segs, "..")
	}
	segs = append(segs, toParts[i:]...)
	return strings.Join(segs, "/")
}

func splitPath(p string) []string {
	parts := strings.Split(strings.Trim(p, "/"), "/")
	out := parts[:0]
	for _, part := range parts {
		if part != "" {
			out = append(out, part)
		}
	}
	return out
}
