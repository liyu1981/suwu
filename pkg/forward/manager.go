package forward

import (
	"context"
	"fmt"
	"sync"
	"time"
)

type ForwardConfig struct {
	ExternalPort int    `json:"externalPort"`
	InternalHost string `json:"internalHost"`
	InternalPort int    `json:"internalPort"`
	Protocol     string `json:"protocol"`
}

type ForwardStatus struct {
	ID           string `json:"id"`
	ExternalPort int    `json:"externalPort"`
	InternalHost string `json:"internalHost"`
	InternalPort int    `json:"internalPort"`
	Protocol     string `json:"protocol"`
	Status       string `json:"status"`
	Error        string `json:"error,omitempty"`
	ActiveConns  int64  `json:"activeConns"`
	TotalConns   int64  `json:"totalConns"`
	StartedAt    string `json:"startedAt,omitempty"`
}

type Manager struct {
	mu           sync.Mutex
	forwards     map[string]*Forward
	nextID       int
	onAutoRemove func(id string, reason string)
	stopCh       chan struct{}
	closeOnce    sync.Once
}

func NewManager() *Manager {
	m := &Manager{
		forwards: make(map[string]*Forward),
		stopCh:   make(chan struct{}),
	}
	go m.healthLoop()
	return m
}

// SetOnAutoRemove registers a callback fired when a forward is removed because
// its target stopped accepting connections.
func (m *Manager) SetOnAutoRemove(fn func(id string, reason string)) {
	m.mu.Lock()
	m.onAutoRemove = fn
	m.mu.Unlock()
}

func (m *Manager) healthLoop() {
	ticker := time.NewTicker(healthInterval)
	defer ticker.Stop()
	for {
		select {
		case <-m.stopCh:
			return
		case <-ticker.C:
			m.probeAll()
		}
	}
}

func (m *Manager) probeAll() {
	m.mu.Lock()
	targets := make([]*Forward, 0, len(m.forwards))
	for _, f := range m.forwards {
		if f.Protocol == "tcp" && f.Status == "running" {
			targets = append(targets, f)
		}
	}
	m.mu.Unlock()

	for _, f := range targets {
		// Live traffic is proof the target is up, and probing a service that
		// only accepts one client could disrupt it.
		if f.ActiveConns.Load() > 0 {
			f.noteHealth(true)
			continue
		}
		if f.probeTarget() {
			m.removeDead(f)
		}
	}
}

func (m *Manager) removeDead(f *Forward) {
	if err := m.Remove(f.ID); err != nil {
		return // already removed through another path
	}
	m.mu.Lock()
	fn := m.onAutoRemove
	m.mu.Unlock()
	if fn != nil {
		fn(f.ID, fmt.Sprintf("target %s:%d unreachable", f.InternalHost, f.InternalPort))
	}
}

// Close stops the health monitor and all forwards. It is safe to call twice.
func (m *Manager) Close() {
	m.closeOnce.Do(func() { close(m.stopCh) })
	m.StopAll()
}

func (m *Manager) Start(cfg ForwardConfig) (*Forward, error) {
	if err := ValidatePort(cfg.ExternalPort); err != nil {
		return nil, err
	}
	if err := ValidatePort(cfg.InternalPort); err != nil {
		return nil, err
	}
	if err := ValidateProtocol(cfg.Protocol); err != nil {
		return nil, err
	}
	if cfg.InternalHost == "" {
		cfg.InternalHost = "localhost"
	}

	if !m.IsPortAvailable(cfg.ExternalPort, cfg.Protocol) {
		return nil, fmt.Errorf("port %d is already in use for %s", cfg.ExternalPort, cfg.Protocol)
	}

	m.mu.Lock()
	m.nextID++
	id := fmt.Sprintf("fwd_%d", m.nextID)
	m.mu.Unlock()

	f := &Forward{
		ID:           id,
		ExternalPort: cfg.ExternalPort,
		InternalHost: cfg.InternalHost,
		InternalPort: cfg.InternalPort,
		Protocol:     cfg.Protocol,
		onDead:       func(dead *Forward) { m.removeDead(dead) },
	}

	if err := f.Start(context.Background()); err != nil {
		return nil, err
	}

	m.mu.Lock()
	m.forwards[id] = f
	m.mu.Unlock()

	return f, nil
}

func (m *Manager) Stop(id string) (*Forward, error) {
	m.mu.Lock()
	f, ok := m.forwards[id]
	m.mu.Unlock()

	if !ok {
		return nil, fmt.Errorf("forward %s not found", id)
	}

	f.Stop()
	return f, nil
}

func (m *Manager) Remove(id string) error {
	m.mu.Lock()
	f, ok := m.forwards[id]
	if ok {
		f.Stop()
		delete(m.forwards, id)
	}
	m.mu.Unlock()

	if !ok {
		return fmt.Errorf("forward %s not found", id)
	}
	return nil
}

func (m *Manager) StopAll() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, f := range m.forwards {
		f.Stop()
	}
}

func (m *Manager) Status(id string) (*ForwardStatus, error) {
	m.mu.Lock()
	f, ok := m.forwards[id]
	m.mu.Unlock()

	if !ok {
		return nil, fmt.Errorf("forward %s not found", id)
	}

	return m.toStatus(f), nil
}

func (m *Manager) StatusAll() []ForwardStatus {
	m.mu.Lock()
	defer m.mu.Unlock()

	statuses := make([]ForwardStatus, 0, len(m.forwards))
	for _, f := range m.forwards {
		statuses = append(statuses, *m.toStatus(f))
	}
	return statuses
}

func (m *Manager) toStatus(f *Forward) *ForwardStatus {
	s := &ForwardStatus{
		ID:           f.ID,
		ExternalPort: f.ExternalPort,
		InternalHost: f.InternalHost,
		InternalPort: f.InternalPort,
		Protocol:     f.Protocol,
		Status:       f.Status,
		Error:        f.Error,
		ActiveConns:  f.ActiveConns.Load(),
		TotalConns:   f.TotalConns.Load(),
	}
	if !f.StartedAt.IsZero() {
		s.StartedAt = f.StartedAt.UTC().Format(time.RFC3339)
	}
	return s
}

// ToStatus exports toStatus for use by the server package.
func (m *Manager) ToStatus(f *Forward) *ForwardStatus {
	return m.toStatus(f)
}
