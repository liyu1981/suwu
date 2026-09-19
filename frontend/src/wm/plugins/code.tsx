/**
 * Code Explorer Tile Plugin
 * Multi-tab Monaco editor with optional line highlighting.
 */

import i18n from '../../i18n';
import { FolderOpenIcon, SearchIcon } from '../../components/icons';
import { registerTilePlugin, type TileRenderContext, type ToolbarContext } from '../tilePlugins';

const toolBtn =
  'grid h-5 w-5 place-items-center rounded text-slate-300 transition glass-btn hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-slate-300';

function post(paneId: string, type: string): void {
  const iframe = document.querySelector(
    `iframe[data-pane="${paneId}"]`,
  ) as HTMLIFrameElement | null;
  iframe?.contentWindow?.postMessage({ type }, '*');
}

function CodeToolbar({ paneId }: ToolbarContext) {
  return (
    <>
      <button
        type="button"
        onClick={() => post(paneId, 'code-save')}
        aria-label={i18n.t('codeExplorer.save')}
        title={`${i18n.t('codeExplorer.save')} (Ctrl/Cmd+S)`}
        className={toolBtn}
      >
        <svg
          className="h-3.5 w-3.5"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        >
          <path d="M3 2h8l2 2v10H3z" />
          <path d="M5.5 2v4h5V2" />
          <path d="M5 9h6v5H5z" />
        </svg>
      </button>
      <button
        type="button"
        onClick={() => post(paneId, 'code-search')}
        aria-label={i18n.t('codeExplorer.search.open')}
        title={i18n.t('codeExplorer.search.open')}
        className={toolBtn}
      >
        <SearchIcon className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={() => post(paneId, 'code-open')}
        aria-label={i18n.t('codeExplorer.openFile')}
        title={i18n.t('codeExplorer.openFile')}
        className={toolBtn}
      >
        <FolderOpenIcon className="h-3.5 w-3.5" />
      </button>
    </>
  );
}

registerTilePlugin({
  id: 'code',
  get label() {
    return i18n.t('plugin.code');
  },
  get description() {
    return i18n.t('plugin.codeDesc');
  },
  supportedParams: [
    {
      key: 'files',
      label: 'Files (JSON)',
      description:
        'Array of { path, ranges: [{ start, end }] } opened as tabs, with gutter marks on the ranges',
    },
    {
      key: 'dir',
      label: 'Default directory',
      description:
        'Absolute directory used when opening or searching files before any tab is active (first file base dir, or the directory for `suwu code <dir>`)',
    },
  ],
  render: (paneId, context?: TileRenderContext) => {
    const p = new URLSearchParams({ pane: paneId });
    if (context?.initialPath) p.set('path', context.initialPath);
    if (context?.params) {
      for (const [k, v] of Object.entries(context.params)) {
        p.set(k, v);
      }
    }
    return (
      <iframe
        src={`/code?${p}`}
        title={`code-${paneId}`}
        data-pane={paneId}
        className="h-full w-full border-0 bg-transparent"
      />
    );
  },
  renderToolbar: (ctx) => <CodeToolbar {...ctx} />,
});
