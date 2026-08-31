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
	mu       sync.Mutex
	forwards map[string]*Forward
	nextID   int
}

func NewManager() *Manager {
	return &Manager{
		forwards: make(map[string]*Forward),
	}
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

	var statuses []ForwardStatus
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

// OccupiedPorts returns all external ports currently in use by running forwards.
func (m *Manager) OccupiedPorts() map[string][]int {
	m.mu.Lock()
	defer m.mu.Unlock()

	result := map[string][]int{"tcp": {}, "udp": {}}
	for _, f := range m.forwards {
		if f.Status == "running" {
			result[f.Protocol] = append(result[f.Protocol], f.ExternalPort)
		}
	}
	return result
}
