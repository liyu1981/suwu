import { useState } from 'react';
import type { RestCollection, RestHistoryEntry, SavedRequest } from '../../store/resthelper';
import CollectionsTree from './CollectionsTree';
import HistoryList from './HistoryList';

interface Props {
  history: RestHistoryEntry[];
  collections: RestCollection[];
  onOpenHistory: (entry: RestHistoryEntry) => void;
  onOpenSaved: (saved: SavedRequest) => void;
  onRemoveHistory: (id: string) => void;
  onClearHistory: () => void;
  onRemoveRequest: (collectionId: string, requestId: string) => void;
  onRemoveCollection: (collectionId: string) => void;
}

type Tab = 'history' | 'collections';

export default function SidebarTabs({
  history,
  collections,
  onOpenHistory,
  onOpenSaved,
  onRemoveHistory,
  onClearHistory,
  onRemoveRequest,
  onRemoveCollection,
}: Props) {
  const [tab, setTab] = useState<Tab>('history');

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 gap-1 border-b border-white/[0.06] px-1 pb-1.5">
        {(['history', 'collections'] as Tab[]).map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => setTab(item)}
            className={`flex-1 rounded-md px-2 py-1 text-xs capitalize transition-colors ${
              tab === item ? 'bg-white/[0.08] text-white/90' : 'text-white/40 hover:text-white/70'
            }`}
          >
            {item}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 pt-1.5">
        {tab === 'history' ? (
          <HistoryList
            entries={history}
            onOpen={onOpenHistory}
            onRemove={onRemoveHistory}
            onClear={onClearHistory}
          />
        ) : (
          <CollectionsTree
            collections={collections}
            onOpen={onOpenSaved}
            onRemoveRequest={onRemoveRequest}
            onRemoveCollection={onRemoveCollection}
          />
        )}
      </div>
    </div>
  );
}
