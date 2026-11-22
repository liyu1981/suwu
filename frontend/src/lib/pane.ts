/**
 * The pane a tile page was loaded for.
 *
 * Every tile page is an iframe whose URL carries `?pane=<id>`: it is how the page
 * reports its session state, asks for its font size and names itself to the
 * window manager. Six files had each written the same one-line lookup; this is
 * the single copy, so a change to where the id lives is one edit.
 *
 * Returns '' when the page was opened on its own (a plain tab, or a prerender),
 * which the callers treat as "no pane" — either with `|| undefined` or by
 * passing it straight through.
 */
export function paneIdFromLocation(): string {
  return new URLSearchParams(window.location.search).get('pane') ?? '';
}
