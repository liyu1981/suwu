# GQJS Integration — Feature Plan

> **Status:** Implemented (v1). `pkg/gqjs` and `suwu gq` are built and tested.
> **Goal:** Vendor the [gqjs](../../gqjs) request-scoped JavaScript runtime into
> Suwu as `pkg/gqjs`, and add a `suwu gq` subcommand that runs a single
> JavaScript file exactly like the `gqjs` CLI does.

Source of truth: `/home/yli/gqjs` (local repo, HEAD `8916194`). See its
`plan/RESEARCH_AND_PLAN.md` for the runtime's own design rationale.

---

## 1. What gqjs is

A **PHP-like, request-scoped JavaScript runner** built on wazero + QuickJS. Each
`Run` does: fresh isolate → inject environment → evaluate one script async →
extract a JSON result + captured stdio → tear everything down. There is no
event loop and no cross-request state.

Design points that matter for this integration:

- **Synchronous host I/O at the Wasm boundary, async JS facade.** `fs` is
  synchronous in Go; `prelude.js` wraps it in `fs.promises`. No goroutine ever
  calls back into Wasm, which eliminates the wazero data race.
- **Deadline enforcement** via the request `context` plus wazero
  `CloseOnContextDone`; qjs panics and the module dies on a hard kill, so the
  runner `recover()`s and discards the isolate.
- **Result contract:** global `handler(input)` → non-empty `module.exports` →
  settled top-level value.
- **Capability-scoped FS** (`FSConfig{Roots map[virtual]real, ReadOnly}`),
  memory/stack limits, stdout/stderr caps.
- **Error kinds:** `*ScriptError`, `ErrTimeout`, `ErrOutputLimit`.

Layout: `runner/` (library), `cmd/gqjs/` (CLI), `examples/`, `plan/`.

---

## 2. Locked decisions

| # | Decision | Choice |
|---|---|---|
| D1 | Integration model | **Copy-and-own** the `runner` package into `pkg/gqjs`; no upstream module dependency (gqjs has no remote). |
| D2 | Scope | **Local execution only** — mirror the gqjs CLI. No server/notify integration in this phase. |
| D3 | Exit codes | **Preserve gqjs's codes:** `0` ok, `1` script/runtime error, `2` timeout, `3` output limit, `64` usage error. |
| D4 | Examples | **Add** the gqjs sample scripts under `examples/gqjs/`. |

---

## 3. wazero compatibility (the one real risk — resolved)

### 3.1 Current wazero in Suwu

**`github.com/tetratelabs/wazero v1.11.0`**, an indirect dependency:

```
suwu/pkg/session → github.com/shintaoku/libghostty-go → github.com/tetratelabs/wazero v1.11.0
```

gqjs's own `go.mod` pins **wazero v1.9.0** (qjs v0.0.6's tested version). Go's
minimum-version selection takes the maximum, so adding qjs resolves to
**v1.11.0**, not v1.9.0.

### 3.2 Verified: qjs v0.0.6 works on wazero v1.11.0

- `qjs.New()` + `Eval` succeeds under v1.11.0.
- The **entire gqjs `runner` test suite passes** with wazero forced to v1.11.0.

So no downgrade and no `replace` is needed; the module graph already satisfies
both `libghostty-go` and qjs.

### 3.3 Why wazero v1.12.0 breaks qjs

Reproduced against `qjs v0.0.6` + `wazero v1.12.0`:

```
failed to instantiate module: import func[env.jsFunctionProxy]:
signature mismatch: i32i64i32i32_i64 != i32i64i32i32_i64
```

The two signatures print **identically** — so the message alone is misleading.
Instrumenting wazero v1.12's `internal/wasm/store.go` reveals the real cause:

```
signature mismatch: i32i64i32i32_i64 != i32i64i32i32_i64
  [debug expectedID=4 actualID=17 descFunc=4 actualTypeIdx=0 ok=true
   expectedKey="i32i64i32i32_i64" actualKey="i32i64i32i32_i64"]
```

The keys are equal; the **`FunctionTypeID`s differ (4 vs 17)**.

**Mechanism.** wazero v1.12 introduced structural `FunctionTypeID`-based import
matching (for the function-references/GC work). In
`internal/wasm/store.go`, `resolveImports` changed from:

```go
// v1.11 — compares the structural signature
if !actual.EqualsSignature(expectedType.Params, expectedType.Results) { ... }
```

to:

```go
// v1.12 — prefers store-local numeric type IDs
matched := false
if m.TypeIDs != nil && importedModule.TypeIDs != nil {
    actualTypeIdx, ok := src.typeIndexOfFunction(imported.Index)
    matched = ok && importedModule.TypeIDs[actualTypeIdx] == m.TypeIDs[i.DescFunc]
} else {
    matched = actual.EqualsSignature(expectedType.Params, expectedType.Results)
}
```

`FunctionTypeID`s are **store-local, insertion-ordered counters**
(`Store.getFunctionTypeIDByKey`). They are only comparable within one store.

**Why qjs gets two different IDs.** `qjs` compiles its embedded `qjs.wasm` once
into a process-global cache (`runtime.go:createGlobalCompiledModule`) using a
**throwaway `wazero.Runtime`** whose store assigns the IDs. `qjs.New` then
creates a **fresh runtime/store**, builds the `env` host module there, and
instantiates the cached compiled module:

1. throwaway store compiles `qjs.wasm` → `jsFunctionProxy` import type gets ID **4**;
2. fresh store builds the `env` host module → same signature gets ID **17**;
3. `InstantiateModule` compares 4 vs 17 (v1.12 path) → mismatch, even though the
   signature keys are identical.

In v1.11 there is no ID path, so `EqualsSignature` compares the keys and passes.
This is a qjs cache-vs-store interaction with a wazero behavior change, not a
Suwu bug; it is out of scope to fix (we stay on v1.11.0).

### 3.4 Consequence

Pin the integration to wazero **v1.11.x**. Do not upgrade wazero past v1.11
while qjs v0.0.6 is in the module graph. Record this in the fork header and in
`go.mod`'s comment.

---

## 4. Part 1 — `pkg/gqjs`

Copy the gqjs `runner` package verbatim, rename `package runner` → `package
gqjs`, keep import path `suwu/pkg/gqjs`:

| Source (`~/gqjs/runner/`) | Target |
|---|---|
| `runner.go` | `pkg/gqjs/runner.go` |
| `env.go` | `pkg/gqjs/env.go` |
| `bindings.go` | `pkg/gqjs/bindings.go` |
| `errors.go` | `pkg/gqjs/errors.go` |
| `result.go` | `pkg/gqjs/result.go` |
| `prelude.js` | `pkg/gqjs/prelude.js` (kept as `//go:embed`) |
| `runner_test.go` | `pkg/gqjs/runner_test.go` (package renamed) |

Additional changes:

- Add a provenance header to `pkg/gqjs/doc.go` (or `runner.go`): source repo,
  HEAD `8916194`, copy date, and the "wazero pinned to v1.11.x" note.
- `go.mod`: add `github.com/fastschema/qjs v0.0.6`. wazero stays v1.11.0;
  add a comment explaining the pin.
- Keep the `gqjs:` error prefixes (they already match the package name).

---

## 5. Part 2 — `suwu gq`

New `cmd/Suwu/gq.go`, wired as `case "gq"` in `cmd/Suwu/main.go`.

```
suwu gq [flags] <script.js>
```

Flags (same semantics as `gqjs`):

| Flag | Meaning |
|---|---|
| `--timeout <dur>` | Per-request timeout (default 5s) |
| `--root <virtual=real>` | Mount a host dir (repeatable) |
| `--ro` | Read-only filesystem |
| `--env <KEY=VALUE>` | Environment variable (repeatable) |
| `--input <json>` | Input payload as JSON |
| `--input-file <file>` | Input payload from a file |
| `--cwd <dir>` | Virtual working directory (default `/`) |
| `--arg <value>` | Append to `process.argv` (repeatable) |
| `--print-result` | Print the JSON result to stdout |

Behavior:

- Port gqjs's `buildEnv` (roots/env/input parsing) into `gq.go`.
- Read the script, run `gqjs.New().Run(ctx, src, env)`, print `res.Stdout` to
  stdout and `res.Stderr` to stderr, optionally print `res.JSON` with
  `--print-result`.
- **Exit codes:** expose `gqMain(args []string) int` and have the dispatch call
  `os.Exit(gqMain(os.Args[2:]))`, so `2`/`3`/`64` survive. (The usual
  `log.Fatalf` path always exits 1 and would collapse them.)
- Add a usage line to `printUsage` and a `printSubcommandHelp("gq")` case.

---

## 6. Part 3 — examples

Copy `~/gqjs/examples/*.js` (`hello.js`, `handler.js`, `timeout.js`,
`data.txt`) to `examples/gqjs/`. These double as manual smoke tests and can be
referenced from `suwu help gq`.

---

## 7. Files touched

**New**

- `pkg/gqjs/runner.go`, `env.go`, `bindings.go`, `errors.go`, `result.go`,
  `prelude.js`, `runner_test.go`
- `cmd/Suwu/gq.go`, `cmd/Suwu/gq_test.go`
- `examples/gqjs/*.js`, `examples/gqjs/data.txt`
- `docs/GQJS_INTEGRATION_PLAN.md` (this file)

**Modified**

- `go.mod` / `go.sum` (add `fastschema/qjs v0.0.6`)
- `cmd/Suwu/main.go` (dispatch case, usage, subcommand help)

---

## 8. Verification

- `go build ./...`, `go vet ./...`, `go test ./...` (including the ported gqjs
  suite).
- Smoke tests:
  - `suwu gq --print-result examples/gqjs/hello.js`
  - `suwu gq --root /app=./examples/gqjs --input '{"n":21}' --print-result examples/gqjs/handler.js`
  - `suwu gq --timeout 300ms examples/gqjs/timeout.js` → expect exit code `2`
  - an output-limit script → expect exit code `3`
  - a usage error (no script) → expect exit code `64`
- Diff stdout/result against `~/gqjs/bin/gqjs` for the same scripts.
- Confirm `suwu help gq` and top-level usage render.

---

## 9. Risks and notes

| Risk | Mitigation |
|---|---|
| wazero silently upgraded past v1.11 (breaks qjs instantiation) | Pin + comment in `go.mod`; provenance note in `pkg/gqjs`. |
| Fork drifts from upstream gqjs | Provenance header records HEAD `8916194`; sync manually when upstream changes. |
| Binary size | qjs embeds a ~1 MiB `qjs.wasm`; wazero is already linked via `libghostty-go`. Modest increase. |
| Security | `suwu gq` runs local scripts; FS access is deny-by-default (no `--root` ⇒ no file access). Same capability model as gqjs. |
| Exit-code plumbing | `gqMain` returns an int; only the `gq` dispatch case uses `os.Exit`, leaving other subcommands unchanged. |

## 10. Out of scope (this phase)

- Exposing gqjs to the Suwu server (script tiles / API) or wiring results into
  `suwu send`/`suwu open`.
- Worker pooling, bytecode cache, and the QuickJS interrupt handler (gqjs
  Phase 1–3 items).
- Any module-system work beyond the existing builtins (`fs`, `path`, `process`,
  `console`).
