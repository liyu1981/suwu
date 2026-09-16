package forward

import "fmt"

const (
	MinPort = 1024
	MaxPort = 65535
)

func ValidatePort(port int) error {
	if port < MinPort || port > MaxPort {
		return fmt.Errorf("port must be between %d and %d", MinPort, MaxPort)
	}
	return nil
}

func ValidateProtocol(proto string) error {
	switch proto {
	case "tcp", "udp":
		return nil
	default:
		return fmt.Errorf("protocol must be \"tcp\" or \"udp\"")
	}
}

func (m *Manager) IsPortAvailable(port int, protocol string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, f := range m.forwards {
		if f.ExternalPort == port && f.Protocol == protocol && f.Status == "running" {
			return false
		}
	}
	return true
}
