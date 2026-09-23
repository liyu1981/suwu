package main

import _ "embed"

// suwuToolsSkill is the SKILL.md installed by `suwu agent`. It documents only
// the agent-facing Suwu commands: the tools an AI agent uses to surface work
// in the running Suwu browser session. Server-management commands (serve,
// daemon, onboard, gencerts, upgrade) are intentionally out of scope.
//
//go:embed agent_skill.md
var suwuToolsSkill string
