package herdr

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"os"
	"sort"
	"sync"
	"time"
)

// Core is a session's connection to herdr-core, with the terminal snapshot it
// maintains from events. One per session, shared by every request.
type Core struct {
	session string
	repos   *gitRootCache
	home    string

	mu         sync.Mutex
	conn       *Conn
	terminals  map[string]Terminal
	machines   []Machine
	seq        uint64
	doc        DocState
	docVersion int
	eventsCh   chan Frame
	eventsStop chan struct{}
	lastErr    error

	dialMu sync.Mutex
	// dial is ConnOptions -> *Conn; tests replace it with an in-memory pair.
	dial     func(context.Context, ConnOptions) (*Conn, error)
	lastSeen time.Time
}

// staleAfter is how long a connection may be silent before it is treated as
// dead. Core sends a heartbeat every 15 s, so silence past this is a lost line,
// not a quiet core.
const staleAfter = 45 * time.Second

// NewCore prepares a client for one core session. An empty session means "the
// core's own default": HC_SESSION from the environment, else "default". The
// effective name is kept so the UI can show which core it is talking to.
func NewCore(session string) *Core {
	if session == "" {
		session = os.Getenv("HC_SESSION")
	}
	if session == "" {
		session = "default"
	}
	home, _ := os.UserHomeDir()
	return &Core{
		session:   session,
		repos:     newGitRootCache(),
		home:      home,
		terminals: make(map[string]Terminal),
		dial:      Dial,
	}
}

// Session is the core session this client speaks to.
func (c *Core) Session() string { return c.session }

// Close ends the connection (the daemon and its terminals keep running).
func (c *Core) Close() {
	c.mu.Lock()
	conn := c.conn
	c.conn = nil
	c.mu.Unlock()
	if conn != nil {
		_ = conn.Close()
	}
}

// ensure makes sure there is a live connection with a snapshot and a
// subscription.
func (c *Core) ensure(ctx context.Context) (*Conn, error) {
	c.mu.Lock()
	conn := c.conn
	c.mu.Unlock()
	if conn != nil {
		select {
		case <-conn.Done():
			// gone; fall through and redial
		default:
			c.mu.Lock()
			silent := time.Since(c.lastSeen)
			c.mu.Unlock()
			if silent < staleAfter {
				return conn, nil
			}
			// A connection that has gone quiet (no heartbeat) is dead even if
			// the pipe still looks open; drop it and redial.
			_ = conn.Close()
		}
	}

	c.dialMu.Lock()
	defer c.dialMu.Unlock()

	c.mu.Lock()
	conn = c.conn
	c.mu.Unlock()
	if conn != nil {
		select {
		case <-conn.Done():
		default:
			return conn, nil
		}
	}

	conn, err := c.dial(ctx, ConnOptions{Session: c.session})
	if err != nil {
		c.mu.Lock()
		c.lastErr = err
		c.mu.Unlock()
		return nil, err
	}

	var list listResult
	if err := conn.Call(ctx, "terminal.list", map[string]any{}, &list); err != nil {
		_ = conn.Close()
		return nil, err
	}

	var sub subscribeResult
	conn.SetEventHandler(c.onEventNotification)
	if err := conn.Call(ctx, "events.subscribe", map[string]any{}, &sub); err != nil {
		_ = conn.Close()
		return nil, err
	}

	c.mu.Lock()
	c.conn = conn
	c.terminals = make(map[string]Terminal, len(list.Terminals))
	for _, t := range list.Terminals {
		c.terminals[t.Address] = t
	}
	// The subscribe reply is a snapshot too; it wins over the list.
	for _, t := range sub.Terminals {
		c.terminals[t.Address] = t
	}
	c.machines = list.Machines
	c.seq = sub.Seq
	c.lastErr = nil
	// A fresh connection is alive by definition; the staleness clock starts now.
	c.lastSeen = time.Now()
	c.mu.Unlock()

	if sub.Channel != nil {
		frames := make(chan Frame, 32)
		conn.RegisterStream(*sub.Channel, frames)
		stop := make(chan struct{})
		c.mu.Lock()
		c.eventsCh = frames
		c.eventsStop = stop
		c.mu.Unlock()
		go c.eventsLoop(conn, *sub.Channel, frames, stop)
	}

	if state, version, err := c.readDoc(ctx); err == nil {
		c.mu.Lock()
		c.doc = state
		c.docVersion = version
		c.mu.Unlock()
	}

	return conn, nil
}

// onEventNotification handles events delivered on channel 0 (plain mode or a
// core that does not open an events channel).
func (c *Core) onEventNotification(payload []byte) {
	c.touch()
	var env eventEnvelope
	if err := json.Unmarshal(payload, &env); err != nil || env.Method != "event" {
		return
	}
	c.applyEvent(env.Params)
}

// eventsLoop drains the subscribe channel (framed mode): JSON lines, one or
// more per frame.
func (c *Core) eventsLoop(conn *Conn, channel uint32, frames chan Frame, stop chan struct{}) {
	defer conn.UnregisterStream(channel)
	for {
		select {
		case <-stop:
			return
		case <-conn.Done():
			return
		case f, ok := <-frames:
			if !ok {
				return
			}
			if f.Kind == KindClose {
				return
			}
			if f.Kind != KindData {
				continue
			}
			// Credit is what lets the core keep sending; count what we consumed.
			if len(f.Payload) > 0 {
				_ = conn.writeStreamFrame(Frame{Channel: channel, Kind: KindCredit, Payload: creditPayload(len(f.Payload))})
			}
			c.touch()
			for _, line := range splitLines(f.Payload) {
				var env eventEnvelope
				if err := json.Unmarshal(line, &env); err != nil {
					continue
				}
				// An events channel carries the same notifications as channel 0
				// (a JSON-RPC envelope without an id); tolerate a bare params
				// object too, so a future/looser core still updates the list.
				if env.Method == "" && env.Params.Type != "" {
					env.Method = "event"
				}
				if env.Method == "heartbeat" {
					continue
				}
				if env.Method == "missed" {
					c.resync()
					continue
				}
				if env.Method != "event" {
					continue
				}
				c.applyEvent(env.Params)
			}
		}
	}
}

// touch records that the core is alive (any frame counts).
func (c *Core) touch() {
	c.mu.Lock()
	c.lastSeen = time.Now()
	c.mu.Unlock()
}

func splitLines(payload []byte) [][]byte {
	var out [][]byte
	start := 0
	for i, b := range payload {
		if b == '\n' {
			if i > start {
				out = append(out, payload[start:i])
			}
			start = i + 1
		}
	}
	if start < len(payload) {
		out = append(out, payload[start:])
	}
	return out
}

// resync re-reads the snapshot after a `missed` notification.
func (c *Core) resync() {
	ctx, cancel := context.WithTimeout(context.Background(), CallTimeout)
	defer cancel()
	c.mu.Lock()
	conn := c.conn
	c.mu.Unlock()
	if conn == nil {
		return
	}
	var list listResult
	if err := conn.Call(ctx, "terminal.list", map[string]any{}, &list); err != nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.terminals = make(map[string]Terminal, len(list.Terminals))
	for _, t := range list.Terminals {
		c.terminals[t.Address] = t
	}
	c.machines = list.Machines
}

// applyEvent folds one event into the snapshot (schema/README.md, "Events").
func (c *Core) applyEvent(p eventParams) {
	if p.Seq <= c.seq {
		return
	}
	c.seq = p.Seq

	c.mu.Lock()
	defer c.mu.Unlock()
	switch p.Type {
	case "created", "restarted":
		var t Terminal
		if err := json.Unmarshal(p.Data, &t); err == nil && t.Address != "" {
			c.terminals[t.Address] = t
		}
	case "removed":
		delete(c.terminals, p.Terminal)
	case "finished":
		var d struct {
			Reason     string `json:"reason"`
			ExitCode   *int   `json:"exit_code"`
			FinishedMS *int64 `json:"finished_ms"`
		}
		if err := json.Unmarshal(p.Data, &d); err == nil {
			if t, ok := c.terminals[p.Terminal]; ok {
				t.State = "finished"
				t.Reason = &d.Reason
				t.ExitCode = d.ExitCode
				t.FinishedMS = d.FinishedMS
				t.Foreground = nil
				c.terminals[p.Terminal] = t
			}
		}
	case "lost":
		var d struct {
			Reason string `json:"reason"`
		}
		_ = json.Unmarshal(p.Data, &d)
		if t, ok := c.terminals[p.Terminal]; ok {
			t.Foreground = nil
			t.PID = nil
			t.Reason = &d.Reason
			c.terminals[p.Terminal] = t
		}
	case "status":
		var d struct {
			Status *Status `json:"status"`
		}
		if err := json.Unmarshal(p.Data, &d); err == nil {
			if t, ok := c.terminals[p.Terminal]; ok {
				t.Status = d.Status
				c.terminals[p.Terminal] = t
			}
		}
	case "title":
		var d struct {
			Title string `json:"title"`
		}
		if err := json.Unmarshal(p.Data, &d); err == nil {
			if t, ok := c.terminals[p.Terminal]; ok {
				t.Title = d.Title
				c.terminals[p.Terminal] = t
			}
		}
	case "labels":
		var d struct {
			Labels map[string]string `json:"labels"`
			Record *Terminal         `json:"record"`
		}
		if err := json.Unmarshal(p.Data, &d); err == nil {
			if t, ok := c.terminals[p.Terminal]; ok {
				t.Labels = d.Labels
				c.terminals[p.Terminal] = t
			}
		}
	case "size":
		var d struct {
			Cols int `json:"cols"`
			Rows int `json:"rows"`
		}
		if err := json.Unmarshal(p.Data, &d); err == nil {
			if t, ok := c.terminals[p.Terminal]; ok {
				t.Cols, t.Rows = d.Cols, d.Rows
				c.terminals[p.Terminal] = t
			}
		}
	case "foreground":
		// data is {pid,name,argv,cwd} or null.
		if t, ok := c.terminals[p.Terminal]; ok {
			var fg *Foreground
			if err := json.Unmarshal(p.Data, &fg); err == nil {
				t.Foreground = fg
				c.terminals[p.Terminal] = t
			}
		}
	case "keep":
		// not shown
	}
}

// TerminalView is one terminal as the UI sees it.
type TerminalView struct {
	Address   string            `json:"address"`
	Name      string            `json:"name"`
	Title     string            `json:"title"`
	Agent     string            `json:"agent"`
	Cwd       string            `json:"cwd"`
	State     string            `json:"state"`
	Live      bool              `json:"live"`
	Status    *Status           `json:"status,omitempty"`
	Labels    map[string]string `json:"labels,omitempty"`
	CreatedMS int64             `json:"createdMs"`
	SpaceID   string            `json:"spaceId,omitempty"`
}

// Space is one named group of terminals.
type Space struct {
	ID               string `json:"id"`
	Name             string `json:"name"`
	CustomName       string `json:"customName,omitempty"`
	IdentityCwd      string `json:"identityCwd"`
	IdentityTerminal string `json:"identityTerminal,omitempty"`
	Colour           string `json:"colour"`
	Order            int    `json:"order,omitempty"`
	// CreatedMS is when the space's first terminal was opened: spaces are shown
	// in creation order, so this is what the list sorts by.
	CreatedMS int64          `json:"createdMs,omitempty"`
	Synthetic bool           `json:"synthetic,omitempty"`
	Terminals []TerminalView `json:"terminals"`
}

// Snapshot is everything the tile needs for its left panel.
type Snapshot struct {
	Core struct {
		Version  string   `json:"version"`
		Name     string   `json:"name"`
		Session  string   `json:"session"`
		Features []string `json:"features,omitempty"`
	} `json:"core"`
	Spaces     []Space        `json:"spaces"`
	Unassigned []TerminalView `json:"unassigned"`
}

// Snapshot returns the assembled view, connecting on demand.
func (c *Core) Snapshot(ctx context.Context) (Snapshot, error) {
	if _, err := c.ensure(ctx); err != nil {
		return Snapshot{}, err
	}

	c.mu.Lock()
	conn := c.conn
	doc := c.doc
	terminals := make([]Terminal, 0, len(c.terminals))
	for _, t := range c.terminals {
		if t.Live() {
			terminals = append(terminals, t)
		}
	}
	var version, name string
	var features []string
	if conn != nil {
		version, name, features = conn.Version, conn.CoreName, conn.Features
	}
	c.mu.Unlock()

	snap := Snapshot{Spaces: []Space{}, Unassigned: []TerminalView{}}
	snap.Core.Version = version
	snap.Core.Name = name
	snap.Core.Session = c.session
	snap.Core.Features = features

	groups := make(map[string][]Terminal)
	var unassigned []Terminal
	for _, t := range terminals {
		id := t.Labels["space"]
		if id == "" {
			unassigned = append(unassigned, t)
			continue
		}
		groups[id] = append(groups[id], t)
	}

	ids := make([]string, 0, len(groups))
	for id := range groups {
		ids = append(ids, id)
	}
	sort.Strings(ids)

	for _, id := range ids {
		group := groups[id]
		sortTerminals(group)
		meta := doc.Spaces[id]

		var identity *Terminal
		if meta.IdentityTerminal != "" {
			for i := range group {
				if group[i].Address == meta.IdentityTerminal {
					identity = &group[i]
					break
				}
			}
		}
		if identity == nil && len(group) > 0 {
			identity = &group[0]
		}

		// The name follows the space's *first* tab (its identity terminal): the
		// directory that shell is in right now, so `cd` renames the space. The
		// identity is the terminal baikal opened first, not whichever one was
		// touched last. Renaming pins a name.
		identityCwd := meta.IdentityCwd
		if identity != nil {
			identityCwd = identity.WorkingDir()
		}
		name := DisplayName(meta.CustomName, identityCwd, c.home, c.repos)
		colour := meta.Colour
		if colour == "" {
			colour = ColourFor(id)
		}

		space := Space{
			ID:          id,
			Name:        name,
			Order:       meta.Order,
			CreatedMS:   group[0].CreatedMS,
			CustomName:  meta.CustomName,
			IdentityCwd: identityCwd,
			Colour:      colour,
			Terminals:   make([]TerminalView, 0, len(group)),
		}
		if identity != nil {
			space.IdentityTerminal = identity.Address
		}
		for _, t := range group {
			space.Terminals = append(space.Terminals, view(t, id))
		}
		snap.Spaces = append(snap.Spaces, space)
	}

	sortTerminals(unassigned)
	for _, t := range unassigned {
		snap.Unassigned = append(snap.Unassigned, view(t, ""))
	}
	return snap, nil
}

func view(t Terminal, spaceID string) TerminalView {
	return TerminalView{
		Address:   t.Address,
		Name:      t.DisplayName(),
		Title:     t.Title,
		Agent:     t.AgentName(),
		Cwd:       t.WorkingDir(),
		State:     t.State,
		Live:      t.Live(),
		Status:    t.Status,
		Labels:    t.Labels,
		CreatedMS: t.CreatedMS,
		SpaceID:   spaceID,
	}
}

// RunShell starts a login shell in cwd, in space spaceID (a fresh space when
// empty), and records it as the space's identity terminal.
//
// cols/rows size the terminal *before* the shell draws its first prompt. Without
// them core uses its own default (200×120), and attaching a smaller viewer then
// scrolls that prompt above the visible rows — the pane looks empty until the
// next keypress draws a new one.
func (c *Core) RunShell(ctx context.Context, cwd, spaceID, name string, cols, rows int) (Terminal, string, error) {
	conn, err := c.ensure(ctx)
	if err != nil {
		return Terminal{}, "", err
	}
	if spaceID == "" {
		spaceID, err = NewSpaceID()
		if err != nil {
			return Terminal{}, "", err
		}
	}
	params := map[string]any{
		"cwd":    cwd,
		"labels": map[string]string{"space": spaceID},
	}
	if cols > 0 && rows > 0 {
		params["size"] = map[string]int{"cols": cols, "rows": rows}
	}
	if name != "" {
		params["name"] = name
	}
	var t Terminal
	if err := conn.Call(ctx, "terminal.run", params, &t); err != nil {
		return Terminal{}, "", err
	}

	c.mu.Lock()
	c.terminals[t.Address] = t
	doc := c.doc
	c.mu.Unlock()

	if doc.Spaces[spaceID].IdentityTerminal == "" {
		_ = c.mutateDoc(ctx, func(state *DocState) {
			meta := state.Spaces[spaceID]
			meta.IdentityTerminal = t.Address
			if meta.IdentityCwd == "" {
				meta.IdentityCwd = t.Cwd
			}
			state.Spaces[spaceID] = meta
		})
	}
	return t, spaceID, nil
}

// ReadText returns a terminal's screen as text (preview for a card or a peek).
func (c *Core) ReadText(ctx context.Context, terminal string, lines int) (string, error) {
	conn, err := c.ensure(ctx)
	if err != nil {
		return "", err
	}
	var res readResult
	if err := conn.Call(ctx, "terminal.read", map[string]any{"terminal": terminal, "lines": lines}, &res); err != nil {
		return "", err
	}
	return res.Text, nil
}

// Kill ends a terminal's program.
func (c *Core) Kill(ctx context.Context, terminal string) error {
	conn, err := c.ensure(ctx)
	if err != nil {
		return err
	}
	return conn.Call(ctx, "terminal.kill", map[string]any{"terminal": terminal}, nil)
}

// Remove forgets a finished terminal.
func (c *Core) Remove(ctx context.Context, terminal string) error {
	conn, err := c.ensure(ctx)
	if err != nil {
		return err
	}
	return conn.Call(ctx, "terminal.rm", map[string]any{"terminal": terminal}, nil)
}

// Label sets (or with an empty value removes) labels on a terminal. Core's
// terminal.label sets only the keys given, so adopting a terminal cannot clobber
// labels another client owns.
func (c *Core) Label(ctx context.Context, terminal string, labels map[string]string) error {
	conn, err := c.ensure(ctx)
	if err != nil {
		return err
	}
	return conn.Call(ctx, "terminal.label", map[string]any{"terminal": terminal, "labels": labels}, nil)
}

// SetSpaceMeta updates one space in the baikal document.
func (c *Core) SetSpaceMeta(ctx context.Context, id string, fn func(*SpaceMeta)) error {
	if _, err := c.ensure(ctx); err != nil {
		return err
	}
	return c.mutateDoc(ctx, func(state *DocState) {
		meta := state.Spaces[id]
		fn(&meta)
		state.Spaces[id] = meta
	})
}

// Attach opens a viewing stream for a terminal.
func (c *Core) Attach(ctx context.Context, terminal string, cols, rows int, observe bool) (*Stream, error) {
	conn, err := c.ensure(ctx)
	if err != nil {
		return nil, err
	}
	return conn.Attach(ctx, terminal, cols, rows, 0, observe)
}

// Ping reports whether a core is reachable, and its version.
func (c *Core) Ping(ctx context.Context) (string, error) {
	if _, err := c.ensure(ctx); err != nil {
		return "", err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.conn != nil {
		return c.conn.Version, nil
	}
	return "", nil
}

func randomHex(n int) (string, error) {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

// logErr keeps the unused-import linter honest for slog while the client is
// quiet by default; the server logs herdr failures where they matter.
var _ = slog.Debug
var _ = time.Second
