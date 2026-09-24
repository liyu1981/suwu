import { useEffect, useMemo, useRef } from 'react';
import { CommonTileContainer } from '../components/CommonTileContainer';
import { extensionZoomAtom } from '../store/zoom';
import { setPageTransparent } from '../lib/constants';
import i18n from '../i18n';

/**
 * Full-space extension page loaded inside each tiling pane's iframe.
 *
 * Two layers on purpose: this page is a trusted Suwu document wrapped in
 * CommonTileContainer (session state, focus, shortcut relay, background, zoom),
 * and it hosts the gqjs-rendered extension in a sandboxed inner iframe so
 * untrusted extension markup cannot touch Suwu's DOM.
 *
 * There is no in-tile extension picker: the id is chosen on the App Menu
 * config tile (supportedParams -> `id`).
 *
 * Because the extension document is sandboxed and one frame deeper, focus and
 * key events inside it never reach this page natively. The server injects a
 * postMessage relay into the served HTML and this page forwards it to the
 * shell under its own message vocabulary (see the relay effect below).
 */
export default function ExtensionPage() {
  useEffect(() => {
    setPageTransparent();
  }, []);

  const { paneId, id, query } = useMemo(() => {
    const sp = new URLSearchParams(window.location.search);
    const pane = sp.get('pane') ?? '';
    const ext = sp.get('id') ?? '';
    sp.delete('pane');
    sp.delete('id');
    return { paneId: pane, id: ext, query: sp.toString() };
  }, []);

  const src = useMemo(() => {
    if (!id) return null;
    const p = new URLSearchParams(query);
    if (paneId) p.set('pane', paneId);
    const qs = p.toString();
    return `/gqjs/${encodeURIComponent(id)}${qs ? `?${qs}` : ''}`;
  }, [id, paneId, query]);

  const innerRef = useRef<HTMLIFrameElement>(null);

  // Tile-page hop of the extension focus/key relay.
  //
  // Ancestor frames do not re-fire `focus` when focus descends into a nested
  // frame, and key events stop at document boundaries — so without this the
  // WM would never learn the tile is focused and Alt/Ctrl shortcuts would be
  // swallowed. Messages are accepted only from *our* inner frame, and are
  // re-stated as this pane's own focus/keys: the extension never gets to name
  // the pane or the action.
  useEffect(() => {
    if (!src || !paneId) return;
    const onMsg = (e: MessageEvent) => {
      const inner = innerRef.current;
      if (!inner || e.source !== inner.contentWindow) return;
      const d = e.data as
        | {
            type?: string;
            key?: string;
            altKey?: boolean;
            ctrlKey?: boolean;
            shiftKey?: boolean;
            metaKey?: boolean;
          }
        | undefined;
      if (d?.type === 'ext-focus') {
        window.parent?.postMessage({ type: 'pane-focus', pane: paneId }, '*');
        return;
      }
      if (d?.type === 'ext-key' && typeof d.key === 'string') {
        window.parent?.postMessage(
          {
            type: 'wm-key',
            key: d.key,
            altKey: !!d.altKey,
            ctrlKey: !!d.ctrlKey,
            shiftKey: !!d.shiftKey,
            metaKey: !!d.metaKey,
          },
          '*',
        );
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [src, paneId]);

  return (
    <CommonTileContainer zoomAtom={extensionZoomAtom} noPadding>
      {src ? (
        <iframe
          key={src}
          ref={innerRef}
          src={src}
          title={`extension-${id}`}
          // Deliberately no `allow-same-origin`: the extension runs in an
          // opaque origin, so it cannot read Suwu storage or escape upward.
          sandbox="allow-scripts allow-pointer-lock"
          className="h-full w-full border-0 bg-transparent"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center px-6 text-center">
          <p className="max-w-md text-sm text-white/60">{i18n.t('extension.configure')}</p>
        </div>
      )}
    </CommonTileContainer>
  );
}
