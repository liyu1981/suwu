package main

import (
	"testing"

	"suwu/pkg/tools"
)

// Onboarding no longer installs development tools. Catalog tools are the Tools
// screen's job; everything else is an instruction. The manual list comes from
// pkg/tools, so onboarding and the Tools screen cannot drift apart.
func TestManualToolsExcludeCatalogTools(t *testing.T) {
	byName := map[string]tools.ManualTool{}
	for _, step := range tools.ManualTools() {
		byName[step.Name] = step
	}
	for _, covered := range []string{"rg", "fzf", "asdf", "witr", "pig", "herdr", "fresh", "lazygit", "oxker"} {
		if _, ok := byName[covered]; ok {
			t.Errorf("%s is in the catalog but was listed as a manual tool", covered)
		}
	}
	for _, manual := range []string{"git", "vim", "nodejs", "pnpm", "pi", "opencode"} {
		step, ok := byName[manual]
		if !ok {
			t.Errorf("%s is not covered by the catalog but has no manual entry", manual)
			continue
		}
		if step.Command == "" {
			t.Errorf("%s has no instruction to show", manual)
		}
	}
}
