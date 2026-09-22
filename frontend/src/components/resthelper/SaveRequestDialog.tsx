import { useState } from 'react';
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog';
import type { RestCollection } from '../../store/resthelper';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  collections: RestCollection[];
  onSave: (name: string, collectionName: string) => void;
}

export default function SaveRequestDialog({ open, onOpenChange, collections, onSave }: Props) {
  const [name, setName] = useState('');
  const [collectionName, setCollectionName] = useState('My requests');

  const inputClass =
    'w-full rounded-lg border border-white/[0.12] bg-white/[0.03] px-2.5 py-1.5 text-sm text-white/80 outline-none focus:border-cyan-400/40';

  const submit = () => {
    if (!name.trim()) return;
    onSave(name.trim(), collectionName.trim() || 'My requests');
    setName('');
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Save request</DialogTitle>
        <div className="mt-4 space-y-3">
          <div className="space-y-1">
            <label
              className="text-[10px] uppercase tracking-wider text-white/35"
              htmlFor="save-name"
            >
              Request name
            </label>
            <input
              id="save-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') submit();
              }}
              placeholder="Get user profile"
              className={inputClass}
            />
          </div>
          <div className="space-y-1">
            <label
              className="text-[10px] uppercase tracking-wider text-white/35"
              htmlFor="save-collection"
            >
              Collection
            </label>
            <input
              id="save-collection"
              value={collectionName}
              onChange={(event) => setCollectionName(event.target.value)}
              list="rest-collection-names"
              placeholder="My requests"
              className={inputClass}
            />
            <datalist id="rest-collection-names">
              {collections.map((collection) => (
                <option key={collection.id} value={collection.name} />
              ))}
            </datalist>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="rounded-lg px-3 py-1.5 text-xs text-white/50 transition-colors hover:text-white/80"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={!name.trim()}
              className="rounded-lg bg-cyan-500/25 px-3 py-1.5 text-xs font-medium text-cyan-200 transition-all hover:bg-cyan-500/35 disabled:opacity-30"
            >
              Save
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
