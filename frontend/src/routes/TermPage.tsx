import FullTerminal from '../components/FullTerminal'

/**
 * Full-space terminal page loaded inside each tiling pane's iframe.
 * Rendered outside the app shell so it has no header and fills the iframe.
 */
export default function TermPage() {
  return <FullTerminal />
}