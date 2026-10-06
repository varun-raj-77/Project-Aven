/**
 * Source-collection deadline (H1). This is the ONLY module allowed to use a
 * timer. It bounds how long `assemble` waits for injected sources; it reads no
 * wall-clock value and nothing it does reaches ranking, freshness or output.
 * Freshness always uses the request's explicit `referenceTime`.
 */

/** Marker value for "the deadline expired before this source settled". */
export const DEADLINE_EXPIRED: unique symbol = Symbol('deadline_expired');

export interface CollectionDeadline {
  /** Aborted when the deadline expires; sources may honour it. */
  readonly signal: AbortSignal;
  /** Settles with the work's outcome, or rejects with DEADLINE_EXPIRED. */
  race<T>(work: Promise<T>): Promise<T>;
  /** Clears the timer. Always called, success or failure. */
  dispose(): void;
}

export function startCollectionDeadline(
  milliseconds: number,
): CollectionDeadline {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), milliseconds);
  const signal = controller.signal;
  return {
    signal,
    race<T>(work: Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        if (signal.aborted) {
          reject(DEADLINE_EXPIRED);
          return;
        }
        const onAbort = () => reject(DEADLINE_EXPIRED);
        signal.addEventListener('abort', onAbort, { once: true });
        work.then(
          (value) => {
            signal.removeEventListener('abort', onAbort);
            resolve(value);
          },
          (error: unknown) => {
            signal.removeEventListener('abort', onAbort);
            reject(error);
          },
        );
      });
    },
    dispose() {
      clearTimeout(timer);
    },
  };
}
