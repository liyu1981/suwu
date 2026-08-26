---
name: git-workflow
description: "The git commit and workflow convention used in the mindx project — conventional-commit titles with detailed bodies, fix commits that state cause + solution, the \"generate git msg\" hand-off workflow (never run git commit yourself), and commit hygiene around staging, secrets, and diff review. Use when committing work or generating commit messages in this repo."
license: MIT
compatibility: opencode
metadata:
  tags: "git,commit,conventional-commits,workflow,commit-message,version-control,hygiene"
  source: "mindx (github)"
  stack: "git"
---

## Purpose
When committing work or producing a commit message in this project, follow
this taolu. The convention keeps every commit message self-contained,
reviewable, and greppable across a long history.

## 1. Commit message format

Every commit is a proper **title** followed by **detailed content**.

### Title
- Conventional-commit style: `<type>(<scope>): <summary>`.
- Types observed in this repo: `feat`, `fix`, `style`, `chore`, `refactor`,
  `docs`, `build`, `test`, `perf`, `revert`.
- Scopes name the affected area: `storage`, `markdown`, `mindmap`, `viewer`,
  `settings`, `llm`, `webmcp`, `ai-assistant`, `editor`, `ui`, `config`,
  `skills`, `idle`, etc.
- Concise and imperative: `feat(storage): wire mobile Safari OPFS backend at
  runtime`, `fix(markdown): render mermaid diagrams with theme-aware colors`,
  `style(settings): list Remote as the first AI provider option`.
- Use lowercase type/scope; keep the summary under ~50 chars when possible.

### Body (detailed content)
- A bulleted/summary list of what changed and **why**, not just one-liners.
- For meaningful commits, open with a short paragraph of context before the
  bullets — what the state was, the problem, and the approach taken.
- Enumerate the concrete changes as bullets, each naming the file/module
  touched and the behavior it changes.
- **For `fix` commits, the details MUST include:**
  - **Problem cause** — the root cause of the bug (e.g. "a static backend
    export hardcoded `createWritable()`, which iOS Safari lacks").
  - **Fix solution** — how the change resolves it (e.g. "resolve the backend
    at runtime via a capability probe and fall back to the msafari worker
    path").
- Record verification performed (e.g. "Verified: pnpm lint, tsc --noEmit,
  pnpm build") and call out anything that still needs manual verification.

## 2. The "generate git msg" workflow

When the user says **"generate git msg"**:

1. **Never run `git commit`.** Only generate and print the message for the
   user to use.
2. Base it on the most recent changes: `git diff`, `git status`, `git log`.
3. Look at recent history to match the repo's style and pick the right
   type/scope.
4. Print the full message (title + body) formatted for a single commit.
5. For `fix` commits, make sure the body states problem cause + fix solution.

## 3. Commit hygiene

- **Only commit when explicitly asked.** Never commit unprompted or as a
  side-effect of finishing a task.
- **Inspect before committing:** `git status`, `git diff`, and
  `git log --oneline -10` — stage only the intended files.
- **Never commit secrets** (API keys, private keys, credentials). The dev
  mkcert cert is committable; its CA/private material is not.
- Do not force-push, do not amend other people's or pushed commits unless
  asked, and keep history linear when the repo expects it.
- On a failed commit or rejected hook, fix the issue and make a **new**
  commit — do not amend the failed one.
- If a PR is requested, inspect status, diff, remote tracking, recent
  commits, and review every commit in the PR (not just the latest); return
  the PR URL when done.
