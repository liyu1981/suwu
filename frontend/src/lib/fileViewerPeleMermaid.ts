// Pele-backed Mermaid shim for @file-viewer/renderer-text.
//
// renderer-text renders fenced ```mermaid blocks in Markdown by calling
// `mermaid.initialize(...)` then `mermaid.render(id, source)`. Pele is a
// faster, dependency-free Mermaid renderer with a different API
// (`render(source) -> { svg }`), so this module adapts Pele to the Mermaid
// shape renderer-text expects.
//
// Pele themes via CSS variables with light fallbacks. renderer-text passes the
// resolved theme through `initialize`, so we capture it here and inject the
// matching `--pele-*` variables into the rendered SVG's root style so dark
// mode stays readable.
import { render as peleRender } from 'pele';

type Theme = 'light' | 'dark';

const DARK_VARS =
  '--pele-bg:#1e1e1e;--pele-fg:#e6e6e6;--pele-muted:#a0a0a0;' +
  '--pele-line:#e6e6e6;--pele-surface:#2a2a2a;--pele-surface-alt:#333333;' +
  '--pele-border:#555555;--pele-accent:#7aa2f7;';

let theme: Theme = 'light';

function injectVars(svg: string, vars: string): string {
  // Add the variables to the root <svg ... style="..."> attribute. Pele
  // always emits a style attribute on the root, but fall back to inserting
  // one if it ever does not.
  if (/<svg\b[^>]*\bstyle="/.test(svg)) {
    return svg.replace(/(<svg\b[^>]*\bstyle=")([^"]*)(")/, `$1$2;${vars}$3`);
  }
  return svg.replace(/<svg\b/, `<svg style="${vars}"`);
}

const mermaid = {
  initialize: (opts: { theme?: string }) => {
    theme = opts?.theme === 'dark' ? 'dark' : 'light';
  },
  render: async (_id: string, source: string) => {
    const svg = peleRender(source).svg;
    return { svg: theme === 'dark' ? injectVars(svg, DARK_VARS) : svg };
  },
};

export default mermaid;
