package herdr

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"sort"
	"strings"
)

// DocumentName is where baikal keeps its space metadata. herdr documents are
// opaque JSON with version-checked writes — exactly what a client's own state
// needs — so the list is shared by every client of the core instead of living in
// one browser.
const DocumentName = "baikal"

// SpaceMeta is one space's identity and presentation, keyed by space id.
type SpaceMeta struct {
	// IdentityTerminal is the terminal whose directory names the space (the
	// Herdr app uses its first tab's root pane the same way).
	IdentityTerminal string `json:"identityTerminal,omitempty"`
	// IdentityCwd is the recorded directory, used when that terminal is gone.
	IdentityCwd string `json:"identityCwd,omitempty"`
	// CustomName pins the name; while set, the cwd-derived name is ignored.
	CustomName string `json:"customName,omitempty"`
	// Colour is a palette key; empty means "derive one from the id".
	Colour string `json:"colour,omitempty"`
	Order  int    `json:"order,omitempty"`
}

// DocState is the baikal document.
type DocState struct {
	Spaces map[string]SpaceMeta `json:"spaces"`
}

func (s *DocState) normalise() {
	if s.Spaces == nil {
		s.Spaces = map[string]SpaceMeta{}
	}
}

// readDoc loads the baikal document, keeping its version for the next write.
func (c *Core) readDoc(ctx context.Context) (DocState, int, error) {
	var res DocGetResult
	if err := c.conn.Call(ctx, "doc.get", map[string]any{"name": DocumentName}, &res); err != nil {
		return DocState{}, 0, err
	}
	var state DocState
	if len(res.Value) > 0 && string(res.Value) != "null" {
		if err := json.Unmarshal(res.Value, &state); err != nil {
			return DocState{}, res.Version, fmt.Errorf("herdr: decode %s document: %w", DocumentName, err)
		}
	}
	state.normalise()
	return state, res.Version, nil
}

// mutateDoc applies fn to the document and writes it back, retrying once on a
// version conflict (another client wrote in between).
func (c *Core) mutateDoc(ctx context.Context, fn func(*DocState)) error {
	for attempt := 0; attempt < 2; attempt++ {
		state, version, err := c.readDoc(ctx)
		if err != nil {
			return err
		}
		fn(&state)
		state.normalise()
		var res DocSetResult
		err = c.conn.Call(ctx, "doc.set", map[string]any{
			"name":    DocumentName,
			"value":   state,
			"version": version,
		}, &res)
		if err == nil {
			c.mu.Lock()
			c.doc = state
			c.docVersion = res.Version
			c.mu.Unlock()
			return nil
		}
		if !strings.Contains(err.Error(), "conflict") {
			return err
		}
	}
	return fmt.Errorf("herdr: %s document kept changing; try again", DocumentName)
}

// NewSpaceID mints a short, unique space id ("b3f1a2"). It is a label value, so
// it stays readable in `herdr-core ls --label space=…`.
func NewSpaceID() (string, error) {
	buf, err := randomHex(3)
	if err != nil {
		return "", err
	}
	return "b" + buf, nil
}

// samePath compares cleaned paths.
func samePath(a, b string) bool {
	if a == "" || b == "" {
		return false
	}
	return filepath.Clean(a) == filepath.Clean(b)
}

// sortTerminals orders a space's terminals by creation so the group is stable.
func sortTerminals(list []Terminal) {
	sort.SliceStable(list, func(i, j int) bool {
		if list[i].CreatedMS == list[j].CreatedMS {
			return list[i].Address < list[j].Address
		}
		return list[i].CreatedMS < list[j].CreatedMS
	})
}
