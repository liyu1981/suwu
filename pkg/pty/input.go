package pty

// StripMouseReports removes complete terminal mouse-report sequences from
// input destined for an interactive shell. It is used only when the shell is
// the foreground process group: a TUI that owns the foreground is allowed to
// receive its mouse protocol unchanged.
//
// This is a defensive boundary for TUIs that terminate without restoring
// mouse modes. It deliberately recognizes only mouse protocols and leaves
// ordinary keyboard CSI sequences untouched.
func StripMouseReports(data []byte) []byte {
	if len(data) == 0 {
		return data
	}

	out := make([]byte, 0, len(data))
	for i := 0; i < len(data); {
		if end, ok := sgrMouseEnd(data, i); ok {
			i = end
			continue
		}
		if i+6 <= len(data) && data[i] == 0x1b && data[i+1] == '[' && data[i+2] == 'M' {
			// X10 mouse protocol: CSI M followed by button, column, row.
			i += 6
			continue
		}
		if end, ok := urxvtMouseEnd(data, i); ok {
			i = end
			continue
		}
		out = append(out, data[i])
		i++
	}
	return out
}

func sgrMouseEnd(data []byte, start int) (int, bool) {
	if start+3 > len(data) || data[start] != 0x1b || data[start+1] != '[' || data[start+2] != '<' {
		return 0, false
	}
	end := start + 3
	if end >= len(data) || !isDigit(data[end]) {
		return 0, false
	}
	semicolons := 0
	for end < len(data) {
		b := data[end]
		switch {
		case isDigit(b):
		case b == ';':
			semicolons++
		case b == 'M' || b == 'm':
			return end + 1, semicolons == 2
		default:
			return 0, false
		}
		end++
	}
	return 0, false
}

func urxvtMouseEnd(data []byte, start int) (int, bool) {
	if start+3 > len(data) || data[start] != 0x1b || data[start+1] != '[' || !isDigit(data[start+2]) {
		return 0, false
	}
	end := start + 2
	semicolons := 0
	for end < len(data) {
		b := data[end]
		switch {
		case isDigit(b):
		case b == ';':
			semicolons++
		case b == 'M' || b == 'm':
			return end + 1, semicolons == 2
		default:
			return 0, false
		}
		end++
	}
	return 0, false
}

func isDigit(b byte) bool { return b >= '0' && b <= '9' }
