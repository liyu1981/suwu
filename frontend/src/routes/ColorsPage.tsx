import { useEffect, useState } from 'react'
import type { Terminal } from '@xterm/xterm'
import { useTerminal } from '../components/useTerminal'

function writeln(term: Terminal, text: string) {
  term.write(`${text}\r\n`)
}

function clearTerminal(term: Terminal) {
  term.clear()
}

const WELCOME = () => {
  const line =
    '\x1b[1;36m╔════════════════════════════════════════════════════════════════════════════════╗\x1b[0m'
  return [
    line,
    '\x1b[1;36m║\x1b[0m                    \x1b[1;35m🎨 ANSI Color Capabilities Demo\x1b[0m                        \x1b[1;36m║\x1b[0m',
    line,
    '',
    'This terminal supports:',
    '  • 16 standard ANSI colors (8 normal + 8 bright)',
    '  • 256-color palette (xterm colors)',
    '  • RGB true color (24-bit)',
    '  • Text styles: bold, italic, underline, dim, inverse, strikethrough',
    '',
    '\x1b[1;33mClick the buttons above to explore different color modes!\x1b[0m',
    '',
  ]
}

function showStandardColors(term: Terminal) {
  term.clear()
  writeln(term, '\x1b[1;36m═══ Standard 16 ANSI Colors ═══\x1b[0m')
  writeln(term, '')
  writeln(term, '\x1b[1mForeground Colors (Normal):\x1b[0m')
  writeln(
    term,
    '\x1b[30m■\x1b[0m Black (30)     \x1b[31m■\x1b[0m Red (31)       \x1b[32m■\x1b[0m Green (32)     \x1b[33m■\x1b[0m Yellow (33)',
  )
  writeln(
    term,
    '\x1b[34m■\x1b[0m Blue (34)      \x1b[35m■\x1b[0m Magenta (35)   \x1b[36m■\x1b[0m Cyan (36)      \x1b[37m■\x1b[0m White (37)',
  )
  writeln(term, '')
  writeln(term, '\x1b[1mForeground Colors (Bright):\x1b[0m')
  writeln(term, '\x1b[90m■\x1b[0m Bright Black (90)   \x1b[91m■\x1b[0m Bright Red (91)')
  writeln(term, '\x1b[92m■\x1b[0m Bright Green (92)   \x1b[93m■\x1b[0m Bright Yellow (93)')
  writeln(term, '\x1b[94m■\x1b[0m Bright Blue (94)    \x1b[95m■\x1b[0m Bright Magenta (95)')
  writeln(term, '\x1b[96m■\x1b[0m Bright Cyan (96)    \x1b[97m■\x1b[0m Bright White (97)')
  writeln(term, '')
  writeln(term, '\x1b[1mBackground Colors (Normal):\x1b[0m')
  writeln(
    term,
    '\x1b[40m  Black  \x1b[0m \x1b[41m  Red    \x1b[0m \x1b[42m  Green  \x1b[0m \x1b[43m  Yellow \x1b[0m',
  )
  writeln(
    term,
    '\x1b[44m  Blue   \x1b[0m \x1b[45m Magenta \x1b[0m \x1b[46m  Cyan   \x1b[0m \x1b[47m\x1b[30m  White  \x1b[0m',
  )
  writeln(term, '')
  writeln(term, '\x1b[1mBackground Colors (Bright):\x1b[0m')
  writeln(
    term,
    '\x1b[100m Br.Black \x1b[0m \x1b[101m Br.Red   \x1b[0m \x1b[102m\x1b[30m Br.Green \x1b[0m \x1b[103m\x1b[30m Br.Yellow\x1b[0m',
  )
  writeln(
    term,
    '\x1b[104m Br.Blue  \x1b[0m \x1b[105m Br.Magenta\x1b[0m \x1b[106m\x1b[30m Br.Cyan  \x1b[0m \x1b[107m\x1b[30m Br.White \x1b[0m',
  )
  writeln(term, '')
  writeln(term, '\x1b[1mExamples:\x1b[0m')
  writeln(term, '\x1b[31mRed text\x1b[0m on \x1b[44mblue background\x1b[0m')
  writeln(term, '\x1b[1;32mBold green\x1b[0m with \x1b[4;33munderlined yellow\x1b[0m')
  writeln(term, '')
}

function show256Colors(term: Terminal) {
  term.clear()
  writeln(term, '\x1b[1;36m═══ 256-Color Palette ═══\x1b[0m')
  writeln(term, '')

  writeln(term, '\x1b[1mSystem Colors (0-15):\x1b[0m')
  let line = ''
  for (let i = 0; i < 16; i++) {
    line += `\x1b[48;5;${i}m  \x1b[0m`
    if ((i + 1) % 8 === 0) {
      writeln(term, `${line}  (${i - 7}-${i})`)
      line = ''
    }
  }
  writeln(term, '')

  writeln(term, '\x1b[1m216 Color Cube (16-231):\x1b[0m')
  for (let r = 0; r < 6; r++) {
    line = ''
    for (let g = 0; g < 6; g++) {
      for (let b = 0; b < 6; b++) {
        const color = 16 + r * 36 + g * 6 + b
        line += `\x1b[48;5;${color}m \x1b[0m`
      }
      line += ' '
    }
    writeln(term, line)
  }
  writeln(term, '')

  writeln(term, '\x1b[1mGrayscale Ramp (232-255):\x1b[0m')
  line = ''
  for (let i = 232; i <= 255; i++) {
    line += `\x1b[48;5;${i}m \x1b[0m`
  }
  writeln(term, `${line}  (232-255)`)
  writeln(term, '')

  writeln(term, '\x1b[1mExamples:\x1b[0m')
  writeln(term, '\x1b[38;5;208mOrange text (208)\x1b[0m')
  writeln(term, '\x1b[38;5;51mCyan text (51)\x1b[0m')
  writeln(term, '\x1b[38;5;201mPink text (201)\x1b[0m')
  writeln(term, '\x1b[48;5;17m\x1b[38;5;226m Yellow on dark blue \x1b[0m')
  writeln(term, '')
}

function showRGBColors(term: Terminal) {
  term.clear()
  writeln(term, '\x1b[1;36m═══ RGB True Color (24-bit) ═══\x1b[0m')
  writeln(term, '')
  writeln(term, '\x1b[1mRGB Color Examples:\x1b[0m')
  writeln(term, '')

  writeln(term, 'Rainbow Gradient:')
  const rainbowColors = [
    [255, 0, 0],
    [255, 127, 0],
    [255, 255, 0],
    [0, 255, 0],
    [0, 0, 255],
    [75, 0, 130],
    [148, 0, 211],
  ]
  let line = ''
  for (const [r, g, b] of rainbowColors) {
    line += `\x1b[38;2;${r};${g};${b}m████\x1b[0m `
  }
  writeln(term, line)
  writeln(term, '')

  writeln(term, '\x1b[1mCustom RGB Colors:\x1b[0m')
  writeln(term, '\x1b[38;2;255;105;180mHot Pink (255, 105, 180)\x1b[0m')
  writeln(term, '\x1b[38;2;64;224;208mTurquoise (64, 224, 208)\x1b[0m')
  writeln(term, '\x1b[38;2;255;215;0mGold (255, 215, 0)\x1b[0m')
  writeln(term, '\x1b[38;2;138;43;226mBlue Violet (138, 43, 226)\x1b[0m')
  writeln(term, '\x1b[38;2;0;128;0mForest Green (0, 128, 0)\x1b[0m')
  writeln(term, '')

  writeln(term, '\x1b[1mRed Gradient:\x1b[0m')
  line = ''
  for (let i = 0; i <= 255; i += 8) {
    line += `\x1b[38;2;${i};0;0m█\x1b[0m`
  }
  writeln(term, line)
  writeln(term, '')

  writeln(term, '\x1b[1mGreen Gradient:\x1b[0m')
  line = ''
  for (let i = 0; i <= 255; i += 8) {
    line += `\x1b[38;2;0;${i};0m█\x1b[0m`
  }
  writeln(term, line)
  writeln(term, '')

  writeln(term, '\x1b[1mBlue Gradient:\x1b[0m')
  line = ''
  for (let i = 0; i <= 255; i += 8) {
    line += `\x1b[38;2;0;0;${i}m█\x1b[0m`
  }
  writeln(term, line)
  writeln(term, '')

  writeln(term, '\x1b[1mRGB Backgrounds:\x1b[0m')
  writeln(term, '\x1b[48;2;220;20;60m\x1b[37m Crimson background \x1b[0m')
  writeln(term, '\x1b[48;2;46;139;87m\x1b[37m Sea green background \x1b[0m')
  writeln(term, '\x1b[48;2;70;130;180m\x1b[37m Steel blue background \x1b[0m')
  writeln(term, '')
}

function showTextStyles(term: Terminal) {
  term.clear()
  writeln(term, '\x1b[1;36m═══ Text Styles ═══\x1b[0m')
  writeln(term, '')
  writeln(term, '\x1b[1mBasic Styles:\x1b[0m')
  writeln(term, '\x1b[1mBold text (SGR 1)\x1b[0m')
  writeln(term, '\x1b[2mDim text (SGR 2)\x1b[0m')
  writeln(term, '\x1b[3mItalic text (SGR 3)\x1b[0m')
  writeln(term, '\x1b[4mUnderline text (SGR 4)\x1b[0m')
  writeln(term, '\x1b[7mInverse/Reverse video (SGR 7)\x1b[0m')
  writeln(term, '\x1b[9mStrikethrough text (SGR 9)\x1b[0m')
  writeln(term, '')
  writeln(term, '\x1b[1mCombined Styles with Colors:\x1b[0m')
  writeln(term, '\x1b[1;31mBold Red\x1b[0m')
  writeln(term, '\x1b[1;4;32mBold Underlined Green\x1b[0m')
  writeln(term, '\x1b[3;36mItalic Cyan\x1b[0m')
  writeln(term, '\x1b[1;3;4;35mBold Italic Underlined Magenta\x1b[0m')
  writeln(term, '\x1b[9;90mStrikethrough Gray\x1b[0m')
  writeln(term, '')
  writeln(term, '\x1b[1mWith Backgrounds:\x1b[0m')
  writeln(term, '\x1b[1;37;44mBold white on blue\x1b[0m')
  writeln(term, '\x1b[4;33;41mUnderlined yellow on red\x1b[0m')
  writeln(term, '\x1b[7;32mInverse green\x1b[0m (swaps fg/bg)')
  writeln(term, '')
  writeln(term, '\x1b[1mDemonstration:\x1b[0m')
  writeln(
    term,
    'Normal → \x1b[1mBold\x1b[0m → \x1b[2mDim\x1b[0m → \x1b[3mItalic\x1b[0m → \x1b[4mUnderline\x1b[0m → Normal',
  )
  writeln(term, '')
}

function showCombinations(term: Terminal) {
  term.clear()
  writeln(term, '\x1b[1;36m═══ Style & Color Combinations ═══\x1b[0m')
  writeln(term, '')
  writeln(term, '\x1b[1mError/Warning Styles:\x1b[0m')
  writeln(term, '\x1b[1;31m[ERROR]\x1b[0m Something went wrong!')
  writeln(term, '\x1b[1;33m[WARNING]\x1b[0m This is a warning message')
  writeln(term, '\x1b[1;32m[SUCCESS]\x1b[0m Operation completed successfully')
  writeln(term, '\x1b[1;36m[INFO]\x1b[0m Informational message')
  writeln(term, '')
  writeln(term, '\x1b[1mSyntax Highlighting Example:\x1b[0m')
  writeln(term, '\x1b[35mfunction\x1b[0m \x1b[33mhelloWorld\x1b[0m() {')
  writeln(term, '  \x1b[34mconst\x1b[0m \x1b[36mmessage\x1b[0m = \x1b[32m"Hello, World!"\x1b[0m;')
  writeln(term, '  \x1b[36mconsole\x1b[0m.\x1b[33mlog\x1b[0m(\x1b[36mmessage\x1b[0m);')
  writeln(term, '  \x1b[35mreturn\x1b[0m \x1b[34mtrue\x1b[0m;')
  writeln(term, '}')
  writeln(term, '')
  writeln(term, '\x1b[1mUI Elements:\x1b[0m')
  writeln(term, '\x1b[1;37;44m  PRIMARY BUTTON  \x1b[0m')
  writeln(term, '\x1b[1;30;47m  SECONDARY BUTTON  \x1b[0m')
  writeln(term, '\x1b[1;37;42m  SUCCESS BUTTON  \x1b[0m')
  writeln(term, '\x1b[1;37;41m  DANGER BUTTON  \x1b[0m')
  writeln(term, '')
  writeln(term, '\x1b[1mProgress Indicators:\x1b[0m')
  writeln(term, '[\x1b[1;32m████████████\x1b[0m\x1b[2m············\x1b[0m] 50%')
  writeln(term, '[\x1b[1;36m████████████████████\x1b[0m\x1b[2m····\x1b[0m] 80%')
  writeln(term, '[\x1b[1;32m████████████████████████\x1b[0m] 100% Complete!')
  writeln(term, '')
  writeln(term, '\x1b[1mTables with Colors:\x1b[0m')
  writeln(term, '╔═══════════╦═══════╦═══════╗')
  writeln(term, '║ \x1b[1mName\x1b[0m      ║ \x1b[1mStatus\x1b[0m║ \x1b[1mValue\x1b[0m ║')
  writeln(term, '╠═══════════╬═══════╬═══════╣')
  writeln(term, '║ Service A ║ \x1b[1;32m  ON\x1b[0m  ║  \x1b[36m100\x1b[0m  ║')
  writeln(term, '║ Service B ║ \x1b[1;31m  OFF\x1b[0m ║  \x1b[36m0\x1b[0m    ║')
  writeln(term, '║ Service C ║ \x1b[1;33m WARN\x1b[0m ║  \x1b[36m50\x1b[0m   ║')
  writeln(term, '╚═══════════╩═══════╩═══════╝')
  writeln(term, '')
}

function showAll(term: Terminal) {
  showStandardColors(term)
  writeln(term, '')
  writeln(term, `\x1b[1;35m${'═'.repeat(80)}\x1b[0m`)
  writeln(term, '')
  writeln(term, '\x1b[1;36m═══ 256-Color Palette (Sample) ═══\x1b[0m')
  writeln(term, '')
  let line = ''
  for (let i = 0; i < 256; i++) {
    line += `\x1b[48;5;${i}m \x1b[0m`
    if ((i + 1) % 32 === 0) {
      writeln(term, line)
      line = ''
    }
  }
  writeln(term, '')
  writeln(term, `\x1b[1;35m${'═'.repeat(80)}\x1b[0m`)
  writeln(term, '')
  writeln(term, '\x1b[1;36m═══ RGB True Color (Samples) ═══\x1b[0m')
  writeln(term, '')
  writeln(
    term,
    '\x1b[38;2;255;105;180m█\x1b[0m Hot Pink  \x1b[38;2;64;224;208m█\x1b[0m Turquoise  \x1b[38;2;255;215;0m█\x1b[0m Gold  \x1b[38;2;138;43;226m█\x1b[0m Blue Violet',
  )
  writeln(term, '')
  writeln(term, `\x1b[1;35m${'═'.repeat(80)}\x1b[0m`)
  writeln(term, '')
  showTextStyles(term)
}

const BUTTONS: { label: string; fn: (term: Terminal) => void }[] = [
  { label: 'Standard Colors (16)', fn: showStandardColors },
  { label: '256-Color Palette', fn: show256Colors },
  { label: 'RGB True Colors', fn: showRGBColors },
  { label: 'Text Styles', fn: showTextStyles },
  { label: 'Combinations', fn: showCombinations },
  { label: 'Show All', fn: showAll },
]

export default function ColorsPage() {
  const [ready, setReady] = useState(false)
  const { containerRef, term } = useTerminal(
    {
      fontSize: 14,
      fontFamily: "'Monaco', 'Menlo', 'Consolas', 'Courier New', monospace",
      scrollback: 10000,
      theme: {
        background: '#1e1e1e',
        foreground: '#d4d4d4',
        cursor: '#ffffff',
        black: '#000000',
        red: '#cd3131',
        green: '#0dbc79',
        yellow: '#e5e510',
        blue: '#2472c8',
        magenta: '#bc3fbc',
        cyan: '#11a8cd',
        white: '#e5e5e5',
        brightBlack: '#666666',
        brightRed: '#f14c4c',
        brightGreen: '#23d18b',
        brightYellow: '#f5f543',
        brightBlue: '#3b8eea',
        brightMagenta: '#d670d6',
        brightCyan: '#29b8db',
        brightWhite: '#ffffff',
      },
    },
    { cols: 120, rows: 40 },
  )

  const run = (fn: (t: Terminal) => void) => {
    if (term) fn(term)
  }

  useEffect(() => {
    if (!term || ready) return
    setReady(true)
    for (const line of WELCOME()) writeln(term, line)
  }, [term, ready])

  return (
    <div className="mx-auto h-full w-full max-w-5xl overflow-auto">
      <div className="glass-control p-4 text-sm text-slate-200">
        <p>
          This demo showcases all ANSI color capabilities supported by the terminal:{' '}
          <strong>16 standard colors</strong>, <strong>256-color palette</strong>,{' '}
          <strong>RGB true colors</strong>, and various <strong>text styles</strong>.
        </p>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {BUTTONS.map(({ label, fn }) => (
          <button
            key={label}
            type="button"
            onClick={() => run(fn)}
            className="rounded-md bg-indigo-500 px-4 py-2 text-sm font-medium text-white shadow glass-btn transition hover:-translate-y-px hover:bg-indigo-400"
          >
            {label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => term && clearTerminal(term)}
          className="rounded-md bg-slate-600 px-4 py-2 text-sm font-medium text-white glass-btn transition hover:bg-slate-500"
        >
          Clear
        </button>
      </div>
      <div className="mt-4 rounded-[6px] bg-[#1e1e1e]/85 p-4">
        <div ref={containerRef} className="terminal-canvas min-h-[400px]" />
      </div>
    </div>
  )
}