/**
 * `@aven/owner-model/persistence`: the read-only rebuild entry point (AVEN-009
 * patch 7). Only this subpath depends on `@aven/storage` and `@aven/ledger`;
 * the root `@aven/owner-model` entry stays pure. Nothing here writes.
 */
export { rebuildOwnerModel, type RebuiltOwnerModel } from './rebuild.ts';
