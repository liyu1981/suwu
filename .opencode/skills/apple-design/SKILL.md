---
name: apple-design
description: "Apple's approach to interface design and fluid, physical motion, translated for the web, distilled from the WWDC design talks (Designing Fluid Interfaces 2018, Details of UI Typography 2020, Audio-Haptic Experiences, Principles of Great Design 2026). Use when building or reviewing gesture-driven UI, spring animations, drag/swipe/sheet interactions, momentum and interruptible transitions, translucent materials and depth, typography, reduced-motion, or the design foundations behind Apple-style interfaces."
license: MIT
compatibility: opencode
metadata:
  tags: "apple-design,fluid-motion,springs,motion,framer-motion,gesture,drag,sheet,interruptibility,velocity,momentum,typography,reduced-motion,materials,backdrop-filter,design-principles"
  source: "Apple WWDC + mindx (github)"
  stack: "CSS + Pointer Events + spring libraries (Motion/Framer Motion)"
---

## Purpose
When building or reviewing any motion, gesture, or physical-feeling UI in the
app, follow this taolu. The through-line: an interface feels alive when motion
starts from the current on-screen value, inherits the user's velocity, projects
momentum forward, and can be grabbed and reversed at any instant. Springs are
the tool because they are inherently interruptible and velocity-aware.

## 1. Response — kill latency
- Respond on pointer-down, not on release. Highlight a button the instant it's pressed.
- Audit every latency: debounces, artificial timers, transition waits, ~300ms tap delay.
- Feedback must be continuous during the interaction, not just at the end — update the UI 1:1 with the pointer the whole way through.

## 2. Direct manipulation — 1:1 tracking
- When the user drags something it must stay glued to the finger, respecting the offset from where they grabbed it. Snap-to-center on grab breaks the illusion.
- Use Pointer Events with `setPointerCapture` so tracking continues beyond bounds.
- Track a short velocity/position history (last few pointermove events) for release velocity.

## 3. Interruptibility — the single most important principle
- Every animation must be interruptible and redirectable at any moment; never lock out input during a transition.
- Always animate from the presentation (current, live on-screen) value, never the target value — starting from the target causes a visible jump.
- Avoid CSS transitions / @keyframes for gesture-driven motion — they can't be grabbed and reversed mid-flight. Springs animate from the current value by default.
- On reversal, blend velocity (carry it through re-target) — don't hard-cut it. This avoids the "brick wall" discontinuity.
- Decompose 2D motion into independent X and Y springs — a single spring on 2D distance desyncs.

## 4. Behavior over animation — use springs
A pre-scripted fixed-duration animation can't respond to new input; a spring can — input just changes the target. Reach for springs for anything a user can touch.

- **Damping ratio** — overshoot. `1.0` = critically damped, no bounce. `< 1.0` = bouncier.
- **Response** — how quickly the value reaches target, seconds. Lower = snappier. This is not "duration" — a spring has no fixed duration.

Defaults:
- Most UI: damping `1.0` (critically damped) — graceful, non-distracting.
- Bounce (damping ~`0.8`) only when the gesture carried momentum (flick/throw/drag release).

| Interaction | Damping | Response |
| --- | --- | --- |
| Move / reposition | `1.0` | `0.4` |
| Rotation | `0.8` | `0.4` |
| Drawer / sheet | `0.8` | `0.3` |

Web mapping (Motion/Framer Motion): `bounce` + `duration` maps closely; house style is `bounce: 0` springs by default, reserve bounce for momentum-driven interactions.

## 5. Velocity handoff
At gesture end, continue at the finger's exact velocity so there's no visible seam. Pass release velocity as the spring's initial velocity. If the API wants relative velocity: `relativeVelocity = gestureVelocity / (targetValue − currentValue)`. Framer Motion / Motion take absolute px/s directly.

## 6. Momentum projection
Don't snap to the nearest boundary from the release point. Project the resting position from velocity (like scroll deceleration), then snap to the target nearest the projection.

```js
function project(initialVelocity /* px/s */, decelerationRate = 0.998) {
  return (initialVelocity / 1000) * decelerationRate / (1 - decelerationRate);
}
const projectedEndpoint = currentPosition + project(releaseVelocity);
const target = nearestSnapPoint(projectedEndpoint);
animateSpringTo(target, { velocity: releaseVelocity });
```

Use the exponential-decay form above, not the physics-textbook v²/(2·decel).

## 7. Spatial consistency
- Enter and exit along the same path — a panel that slides in from the right must dismiss to the right.
- Anchor interactions to their source: set `transform-origin` to the trigger (popovers scale from the trigger, not center).
- Mirror the easing on reversible transitions (inverse cubic-bézier control points for the reverse).

## 8. Hint in the direction of the gesture
Intermediate motion should telegraph where things are going — Control Center modules "grow up and out toward your finger."

## 9. Rubber-banding
At an edge, resist progressively instead of stopping hard. Apply damping that increases the further past the boundary the user drags.

```js
function rubberband(overshoot, dimension, constant = 0.55) {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}
```

## 10. Gesture feel checklist
- **Tap:** highlight on touch-down, commit on touch-up; ~10px hysteresis/hit padding; allow cancel-by-dragging-away.
- **Drag/swipe:** small movement threshold (~10px) before committing direction, then track 1:1.
- Detect all plausible gestures in parallel from the first move, cancel losers once intent is clear. Avoid recognizers that only report a final state.
- Minimize disambiguation delays — double-tap detection delays single taps; only pay the cost where double-tap exists.

## 11. Frame-level smoothness
- Keep per-frame positional change below the perception threshold (avoid strobing).
- For very fast motion, subtle motion-blur/stretch encodes speed better than a sharp streak.
- Use `requestAnimationFrame`; animate only compositor-friendly properties (`transform`, `opacity`); use `will-change` where motion is imminent.

## 12. Materials & depth
- Build nav/toolbars/sheets as translucent layers (`backdrop-filter: blur()` + semi-transparent background) with content scrolling underneath.
- Material weight encodes hierarchy: darker/heavier separates structural regions; lighter draws attention to interactive elements. Never stack light translucent surfaces — legibility collapses.
- Bigger surfaces read as thicker: stronger blur + deeper shadow than small chips. Context-aware shadow (heavier over busy content).
- Dim to focus (modal + scrim), separate to keep flow (non-blocking panel, translucency without scrim). Progressively dim/push back stacked sheet parents.
- Vibrancy keeps text legible: over blurred surfaces use higher-contrast, slightly heavier text with a small letter-spacing bump. Put color on solid layers, not translucent foregrounds.
- Scroll edge effects, not hard dividers — fade a blur/gradient mask where content meets floating chrome.
- Materialize, don't just fade — animate blur radius and scale together on enter/exit so the surface reads as material arriving.

## 13. Multimodal feedback (motion + sound + haptics)
1. **Causality** — trigger feedback on the actual causal event, matched to the action's physicality.
2. **Harmony** — visual, sound, haptic must fire on the same frame; latency destroys the illusion.
3. **Utility** — only where it earns its place (success, error, commit, snap). Over-feedback trains users to ignore it.

## 14. Reduced motion & accessibility
Reduced motion means gentler equivalents, not no feedback:
- `prefers-reduced-motion: reduce` — replace slides/springs/parallax with short opacity cross-fades/static transitions; drop elastic/overshoot.
- `prefers-reduced-transparency: reduce` — frostier/solid surfaces: raise background opacity, drop the blur.
- `prefers-contrast: more` — near-solid backgrounds with a defined contrasting border.

Avoid full-viewport moving backgrounds, slow loops near 0.2 Hz, abrupt brightness jumps (ease theme changes), and large moving objects without semi-transparency.

## 15. Typography
- Tracking (letter-spacing) is size-specific, never one value: large display text wants negative tracking; small text slightly positive. Tighten headings, body near `0`.
- Leading tracks size inversely: tight on large headings, looser on body.
- Build hierarchy from weight + size + leading as a set, not size alone.
- Respect the user's text-size setting — layout in `rem`/`em`, not fixed px.
- Default to the platform system font before a custom face; it ships optical sizing + tracking tables.

## 16. Design foundations — the eight principles
Use these as the names you reason with: **Purpose** (make with intention, decide what not to build), **Agency** (keep people in control, offer forgiveness/undo), **Responsibility** (act in the user's interest, privacy/safety especially with AI), **Familiarity** (consistent metaphors; things that look the same behave the same), **Flexibility** (adapt to context/device/ability; let people personalize), **Simplicity not minimalism** (strip the unnecessary; hierarchy makes the important thing obvious), **Craft** (uncompromising detail; every value is defensible), **Delight** (the result of the other seven, not confetti).

Tactical rules: four feedback kinds (status, completion, warning, error); wayfinding (Where am I? Where can I go? How do I get out?); proximity implies relationship; direct specific labels over safe generic ones.

## 17. Process
- Prototype interactively — an interactive demo beats a million static designs.
- Design interaction and visuals together; motion is not a layer added after the pixels.
- Test with real people in real context; review motion frame-by-frame.

## Quick Reference
| Need | Technique | Concrete value |
| --- | --- | --- |
| Default UI spring | Critically damped, no overshoot | damping 1.0, response 0.3–0.4 |
| Momentum / flick spring | Under-damped, slight bounce | damping ~0.8, response 0.3–0.4 |
| Gesture → spring velocity | Hand off release velocity | velocity / (target − current) if normalized |
| Flick landing point | Project momentum | current + (v/1000)·d/(1−d), d ≈ 0.998 |
| Interrupt cleanly | Start from presentation value | read the on-screen transform |
| Avoid reversal brick wall | Carry velocity through re-target | velocity-blending spring |
| Reversible transition | Mirror the easing curve | inverse cubic-bézier |
| Decide reverse vs. commit | Use velocity sign, not position | at release |
| 1:1 drag | Pointer Events + capture | respect the grab offset |
| Feedback | On pointer-down, continuous | never only at the end |
| Boundary | Rubber-band, don't hard-stop | progressive resistance |
| Translucent chrome | backdrop-filter layer | content scrolls under |
| Type tracking | Size-specific, never fixed | tighten large text (−0.02em), body near 0 |
| Reduced motion | Cross-fade, not slide/spring | @media (prefers-reduced-motion) |
