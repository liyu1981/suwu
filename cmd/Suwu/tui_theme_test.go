package main

import (
	"testing"

	"github.com/muesli/termenv"
)

func TestTUIThemeKindForProfile(t *testing.T) {
	cases := []struct {
		profile termenv.Profile
		want    tuiThemeKind
	}{
		{termenv.TrueColor, tuiThemeRich},
		{termenv.ANSI256, tuiThemeRich},
		{termenv.ANSI, tuiThemeANSI},
		{termenv.Ascii, tuiThemePlain},
	}
	for _, tc := range cases {
		if got := tuiThemeKindFor(tc.profile); got != tc.want {
			t.Errorf("tuiThemeKindFor(%s) = %d, want %d", tc.profile.Name(), got, tc.want)
		}
	}
}

func TestTUIThemeForKindsAreNonNil(t *testing.T) {
	for _, kind := range []tuiThemeKind{tuiThemeRich, tuiThemeANSI, tuiThemePlain} {
		if tuiThemeFor(kind) == nil {
			t.Errorf("tuiThemeFor(%d) returned nil", kind)
		}
	}
}

func TestTUIThemeIsNonNil(t *testing.T) {
	if tuiTheme() == nil {
		t.Fatal("tuiTheme() returned nil")
	}
}
