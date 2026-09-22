import { TrashIcon } from '../icons';
import type { RestCollection, SavedRequest } from '../../store/resthelper';

interface Props {
  collections: RestCollection[];
  onOpen: (saved: SavedRequest) => void;
  onRemoveRequest: (collectionId: string, requestId: string) => void;
  onRemoveCollection: (collectionId: string) => void;
}

export default function CollectionsTree({
  collections,
  onOpen,
  onRemoveRequest,
  onRemoveCollection,
}: Props) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-2 pb-1 text-[10px] uppercase tracking-wider text-white/30">
        Collections
      </div>
      <div className="min-h-0 flex-1 scrollbar-thin overflow-auto">
        {collections.length === 0 ? (
          <div className="p-3 text-[11px] text-white/25">Save a request to create a collection</div>
        ) : (
          collections.map((collection) => (
            <div key={collection.id} className="mb-1">
              <div className="group flex items-center justify-between px-2 py-1">
                <span className="truncate text-[11px] font-semibold text-white/60">
                  {collection.name}
                </span>
                <button
                  type="button"
                  onClick={() => onRemoveCollection(collection.id)}
                  aria-label={`Remove collection ${collection.name}`}
                  title="Remove collection"
                  className="grid h-5 w-5 place-items-center rounded text-white/20 opacity-0 transition-opacity hover:bg-rose-500/15 hover:text-rose-300 group-hover:opacity-100"
                >
                  <TrashIcon className="h-3 w-3" />
                </button>
              </div>
              {collection.requests.map((saved) => (
                <div key={saved.id} className="group flex items-center gap-1 pl-3 pr-1">
                  <button
                    type="button"
                    onClick={() => onOpen(saved)}
                    className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-left transition-colors hover:bg-white/[0.05]"
                  >
                    <span className="shrink-0 font-mono text-[10px] font-semibold text-cyan-300/80">
                      {saved.request.method}
                    </span>
                    <span className="truncate text-[11px] text-white/55">{saved.name}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onRemoveRequest(collection.id, saved.id)}
                    aria-label={`Remove ${saved.name}`}
                    title="Remove"
                    className="grid h-5 w-5 shrink-0 place-items-center rounded text-white/20 opacity-0 transition-opacity hover:bg-rose-500/15 hover:text-rose-300 group-hover:opacity-100"
                  >
                    <TrashIcon className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
