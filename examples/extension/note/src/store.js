/**
 * Note — persistence: the debounced writer and the v1 → v2 migration.
 *
 * Transport is injected, so this module is DOM-free and testable under
 * `node --test`; bridge.js supplies the real postMessage transport.
 *
 * Public file: never put secrets here (docs/EXTENSION_API_PLAN.md §2.8).
 */

import { LEGACY_RECORD, RECORD, emptyDoc, migrateV1, validate } from "./model.js";

const DEFAULT_DELAY = 250;

/**
 * @param {{ get(key): Promise<any>, set(key, value): Promise<void> }} transport
 * @param {object} [opts]
 * @param {number} [opts.delay] debounce, ms
 * @param {(ts: number) => void} [opts.onSaved]
 * @param {(name: string) => void} [opts.onError]
 * @param {() => number} [opts.now]
 */
export function createStore(transport, opts = {}) {
  const delay = Number.isFinite(opts.delay) ? opts.delay : DEFAULT_DELAY;
  const onSaved = opts.onSaved || null;
  const onError = opts.onError || null;
  const now = opts.now || (() => Date.now());

  let timer = null;
  let queued = null;
  let waiters = [];
  let inFlight = Promise.resolve();
  let migrated = false;

  function fail(name) {
    if (onError) onError(name || "StoreFailed");
  }

  function settle() {
    const pending = waiters;
    waiters = [];
    for (const resolve of pending) resolve();
  }

  /** Write the document, reporting a save time on success. */
  function write(doc) {
    inFlight = inFlight.then(() =>
      transport.set(RECORD, doc).then(
        () => {
          if (onSaved) onSaved(now());
        },
        (err) => {
          fail(err && err.name);
        },
      ),
    );
    return inFlight;
  }

  /**
   * Load the current record, else migrate v1 (once, then persist it).
   * A load failure is not fatal: the caller keeps working in memory.
   */
  function load() {
    return transport
      .get(RECORD)
      .then((raw) => {
        const doc = validate(raw);
        if (doc) return doc;
        return transport.get(LEGACY_RECORD).then(
          (legacy) => {
            const upgraded = migrateV1(legacy);
            migrated = Boolean(legacy && Array.isArray(legacy.texts));
            return upgraded;
          },
          () => emptyDoc(),
        );
      })
      .catch((err) => {
        fail(err && err.name);
        return emptyDoc();
      })
      .then((doc) => {
        if (migrated) return write(doc).then(() => doc);
        return doc;
      });
  }

  /** Debounced write; the returned promise settles when it lands. */
  function scheduleSave(doc) {
    queued = doc;
    if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        const payload = queued;
        queued = null;
        write(payload).then(settle, settle);
      }, delay);
    }
    return new Promise((resolve) => waiters.push(resolve));
  }

  /** Write right now (slot switch, page hide, shutdown). */
  function flush(doc) {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const payload = doc || queued;
    queued = null;
    const done = payload ? write(payload) : inFlight;
    done.then(settle, settle);
    return done;
  }

  return { load, scheduleSave, flush, write };
}
