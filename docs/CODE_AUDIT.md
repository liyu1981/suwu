# Code audit — ongoing

This is a source-review and regression-test audit, not certification that the
project is free of defects. Static checks and race tests cover only the paths
that they execute. No live exploitation, production database queries, upgrade,
release, or deployment operations are part of this audit. Environment files,
private keys, generated assets, and third-party implementation code are excluded.

## Fixed in the current working tree

| Area | Finding and remedy | Verification |
| --- | --- | --- |
| Git API | Six Git handlers omitted shared request authentication. Added guards before request processing. Frontend callers already use authenticated fetch. | `TestGitHandlersRequireAuthentication`: rejection and authenticated method guards, no Git execution |
| DB results | SQLite NULL expressions can return a nil scan type, causing a panic. Handle it as `unknown`; serialize empty result rows as `[]`. | `TestExecuteQueryNullAndEmptyResults`, failed before fix and passed afterward |
| Session shutdown | Manager shutdown did not signal state pollers to exit. Close their stop channels and wait for completion outside the manager mutex. | `TestCloseStopsSessionPoller`, failed before fix and passed afterward; package race tests |
| Forward status | Empty status lists serialized as `null`. Return an allocated empty slice. | `TestForwardStatusRoutes`, failed before fix and passed afterward |
| Code Explorer | Save completion marked edits made during the request as saved. Capture the submitted version; preserve dirty state for later edits; avoid duplicate concurrent saves for a tab and ignore disposed models. | `check-code-save.mjs`, frontend typecheck and check suite; browser interaction remains untested |

The suspected forward-status routing failure was **not confirmed**: the existing
path parsing correctly routes both list URLs. No routing change was made.

## Open findings from source inspection

These require focused validation and remediation; they are not fixed by this batch.

- Database schema description builds SQL using table names rather than bound
  values or properly quoted identifiers (`pkg/db/{mysql,postgres,sqlite}.go`).
- Database cleanup starts with a background context that server shutdown does not
  cancel. Connection and schema operations also need bounded/request contexts.
- Forward mutable status fields are read and written without a shared lock.
  UDP shutdown and session creation need a lifecycle review.
- Editor file opening/reloading needs cancellation and disposed-model guards;
  model URIs may collide when multiple tiles open the same file in one realm.
  Reload and open currently apply different size checks.
- File-write existence/mtime checks are separate from the final rename; atomic
  replacement alone does not guarantee the documented no-clobber behavior.
- Upload parsing's memory threshold is described as a total upload-size limit,
  but `ParseMultipartForm` does not impose such a limit.
- Git worktrees use `.git` files, but repository detection accepts only directories.
  Git output parsing and pagination need dedicated correctness tests.
- Token rotation, expiry, shared configuration access, and consistency of request
  validation paths need a dedicated authentication lifecycle review.
- Update lifecycle needs cancellation/concurrency/error-recovery review, including
  daemon self-stop and restart behavior. Do not exercise against a running install.
- X display cleanup timers and stream reader shutdown need lifecycle tests.

## Coverage and remaining work

| Area | Status |
| --- | --- |
| HTTP routing, file handlers, Git handlers | Source reviewed; focused fixes/tests above; remaining issues listed |
| DB drivers, sessions, query execution | Source reviewed; NULL/empty-result regression fixed; real MySQL/Postgres integration pending |
| PTY/session, notification hub, forwarding | Core source reviewed across audit passes; shutdown fix tested; lifecycle review incomplete |
| X display, update | Partial source review; no X server or self-update integration tests |
| Frontend editor, API helpers, DB hooks, notification/background lifecycle | Partial source review; editor save helper tested |
| Remaining frontend routes, WM, GPU/video renderers, accessibility | Not comprehensively reviewed; browser tests pending |
| CLI/onboarding, certificates, logging, environment-loader implementation | Not comprehensively reviewed in this batch |
| Scripts, CI/release, website | CI and package scripts inspected; remaining source/deployment review pending |
| Dependencies | No dependency vulnerability audit performed |

## Validation so far

- `go test ./...` and `go vet ./...` pass after backend fixes.
- `go test -race ./...` passed earlier in this audit.
- `go test -race ./pkg/session ./pkg/server ./pkg/db` passes after shutdown fix.
- `npm run check` and `npm run typecheck` in `frontend` pass after save fix.
- `git diff --check` passes.

No changes in this batch have been committed. Continue by resolving open findings
one at a time and updating this checklist; do not describe the audit as exhaustive
while the remaining areas and integration checks are outstanding.
