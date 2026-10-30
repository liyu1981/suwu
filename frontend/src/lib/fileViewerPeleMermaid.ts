// Pele-backed Mermaid shim for @file-viewer/renderer-text.
//
// renderer-text renders fenced ```mermaid blocks in Markdown by calling
// `mermaid.initialize(...)` then `mermaid.render(id, source)`. Pele is a
// faster, dependency-free Mermaid renderer with a different API
// (`render(source) -> { svg }`), so this module adapts Pele to the Mermaid
// shape renderer-text expects. Theming is handled by Pele's CSS variables
// (see the `.markdown-mermaid` rules in index.css) rather than by
// `initialize`.
import { render as peleRender } from 'pele';

const mermaid = {
  initialize: () => {},
  render: async (_id: string, source: string) => ({
    svg: peleRender(source).svg,
  }),
};

export default mermaid;
