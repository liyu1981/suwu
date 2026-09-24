// Package gqjs is Suwu's copy of the gqjs request-scoped JavaScript runner.
//
// It runs a single JavaScript file in a fresh QuickJS isolate on wazero:
// set up an environment, evaluate one script (which may await host calls),
// collect a JSON result plus captured stdio, then destroy the execution state.
// There is no event loop and no cross-request state.
//
// Host I/O is synchronous at the Wasm boundary, so no goroutine ever calls
// back into the WebAssembly module concurrently; the async JS facade lives in
// prelude.js.
//
// # Network (fetch)
//
// The global fetch() implements the modern Fetch API subset — fetch, Headers,
// Response with text()/json()/arrayBuffer() — and nothing else: no
// XMLHttpRequest, no WebSocket, no ReadableStream/Blob bodies, no cookie jar.
// The prelude builds the facade; the host primitive (__gqjs.fetch in net.go)
// performs the whole request synchronously, bounded by Env.Timeout, with
// keep-alives disabled so no connection outlives the call.
//
// fetch() is opt-in via Env.AllowNet (the `suwu gq --allow-net` flag; the
// extension renderer does not set it). Only http/https is allowed, response
// bodies are capped at Env.MaxFetchBody, and dial-time address filtering
// (net.go) denies loopback/private targets unless Env.AllowPrivate —
// link-local addresses, which hold cloud metadata endpoints, are never
// allowed.
//
// # Provenance
//
//	Source:  /home/yli/gqjs (local repository), HEAD 8916194
//	Package: runner (renamed to gqjs for this copy)
//	Copy:    vendor-and-own; upstream has no remote, so sync manually.
//
// # Compatibility
//
// This copy is pinned to wazero v1.11.x. wazero v1.12.0 compares store-local
// FunctionTypeIDs when resolving imports, which fails for qjs v0.0.6 because it
// compiles qjs.wasm in one wazero store (the global compiled-module cache) and
// instantiates it in another. Do not upgrade wazero past v1.11 while qjs v0.0.6
// is in the module graph. See docs/GQJS_INTEGRATION_PLAN.md §3 for the full
// analysis.
package gqjs
