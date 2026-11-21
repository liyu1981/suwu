package herdr

import "encoding/json"

// The subset of herdr-core's records Suwu uses. Field names follow
// schema/hc.openrpc.json (v0.1.21); anything absent is absent from the API too,
// so these are decoded leniently and re-encoded as-is.

// Foreground is what runs in a terminal right now (the foreground process
// group's leader) and where. Core re-reads it about twice a second.
type Foreground struct {
	PID  int      `json:"pid"`
	Name string   `json:"name"`
	Argv []string `json:"argv"`
	Cwd  string   `json:"cwd"`
}

// Status is one OSC 7501 record — the program's own word for what it is doing.
type Status struct {
	State    string `json:"state"`
	Title    string `json:"title,omitempty"`
	Msg      string `json:"msg,omitempty"`
	App      string `json:"app,omitempty"`
	Kind     string `json:"kind,omitempty"`
	Progress *int   `json:"progress,omitempty"`
}

// Terminal is one core terminal.
type Terminal struct {
	Address    string            `json:"address"`
	Name       *string           `json:"name"`
	Labels     map[string]string `json:"labels"`
	Parent     *string           `json:"parent"`
	Cwd        string            `json:"cwd"`
	Argv       []string          `json:"argv"`
	Foreground *Foreground       `json:"foreground"`
	Status     *Status           `json:"status"`
	Title      string            `json:"title"`
	State      string            `json:"state"`
	PID        *int              `json:"pid"`
	ExitCode   *int              `json:"exit_code"`
	Reason     *string           `json:"reason"`
	CreatedMS  int64             `json:"created_ms"`
	FinishedMS *int64            `json:"finished_ms"`
	Turn       int               `json:"turn"`
	Cols       int               `json:"cols"`
	Rows       int               `json:"rows"`
}

// DisplayName is the name a person gave it, or the address.
func (t Terminal) DisplayName() string {
	if t.Name != nil && *t.Name != "" {
		return *t.Name
	}
	return t.Address
}

// Live reports whether a program is running.
func (t Terminal) Live() bool { return t.State == "live" }

// WorkingDir is where the terminal is now: the foreground process's directory
// when there is one, else its start directory.
func (t Terminal) WorkingDir() string {
	if t.Foreground != nil && t.Foreground.Cwd != "" {
		return t.Foreground.Cwd
	}
	return t.Cwd
}

// AgentName is the foreground program, when it is worth showing.
func (t Terminal) AgentName() string {
	if t.Foreground != nil && t.Foreground.Name != "" {
		return t.Foreground.Name
	}
	if len(t.Argv) > 0 {
		return t.Argv[0]
	}
	return ""
}

// Machine is another core this core talks to.
type Machine struct {
	Name    string `json:"name"`
	Target  string `json:"target"`
	ID      string `json:"id"`
	Host    string `json:"host"`
	Version string `json:"version"`
}

// listResult is terminal.list's result.
type listResult struct {
	Terminals      []Terminal `json:"terminals"`
	HiddenFinished int        `json:"hidden_finished"`
	Machines       []Machine  `json:"machines"`
}

// readResult is terminal.read's result.
type readResult struct {
	Text     string  `json:"text"`
	Complete bool    `json:"complete"`
	How      string  `json:"how"`
	Why      *string `json:"why"`
}

// DocGetResult is doc.get's result. Value is arbitrary JSON (null when the
// document was never written).
type DocGetResult struct {
	Value   json.RawMessage `json:"value"`
	Version int             `json:"version"`
}

// DocSetResult is doc.set's result.
type DocSetResult struct {
	Version int `json:"version"`
}

// subscribeResult is events.subscribe's result.
type subscribeResult struct {
	Seq       uint64     `json:"seq"`
	Terminals []Terminal `json:"terminals"`
	Channel   *uint32    `json:"channel"`
}

// eventEnvelope is one event notification.
type eventEnvelope struct {
	Method string      `json:"method"`
	Params eventParams `json:"params"`
}

type eventParams struct {
	Seq      uint64          `json:"seq"`
	Type     string          `json:"type"`
	Terminal string          `json:"terminal"`
	Data     json.RawMessage `json:"data"`
	Machine  string          `json:"machine"`
}
