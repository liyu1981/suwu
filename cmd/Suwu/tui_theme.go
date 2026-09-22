package main

import (
	"github.com/charmbracelet/huh"
	"github.com/muesli/termenv"
)

// tuiThemeKind is the coarse color capability a TUI theme targets.
type tuiThemeKind int

const (
	// tuiThemeRich targets 256-color / truecolor terminals.
	tuiThemeRich tuiThemeKind = iota
	// tuiThemeANSI targets 16-color terminals (e.g. the bare Linux console).
	tuiThemeANSI
	// tuiThemePlain targets monochrome terminals.
	tuiThemePlain
)

// tuiThemeKindFor maps a detected color profile to a theme kind. The rich
// Catppuccin palette needs 256 colors; on a 16-color console its selection
// highlight can be invisible, so ANSI terminals get explicit base-16 colors and
// monochrome terminals get the plain theme.
func tuiThemeKindFor(profile termenv.Profile) tuiThemeKind {
	switch profile {
	case termenv.TrueColor, termenv.ANSI256:
		return tuiThemeRich
	case termenv.ANSI:
		return tuiThemeANSI
	default: // termenv.Ascii
		return tuiThemePlain
	}
}

// tuiThemeFor returns the huh theme for a capability kind.
func tuiThemeFor(kind tuiThemeKind) *huh.Theme {
	switch kind {
	case tuiThemeANSI:
		return huh.ThemeBase16()
	case tuiThemePlain:
		return huh.ThemeBase()
	default:
		return huh.ThemeCatppuccin()
	}
}

// tuiTheme picks a theme matching the current terminal's color capability.
func tuiTheme() *huh.Theme {
	return tuiThemeFor(tuiThemeKindFor(termenv.EnvColorProfile()))
}
