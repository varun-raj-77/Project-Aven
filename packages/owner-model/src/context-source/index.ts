/**
 * `@aven/owner-model/context-source`: the read-only Owner Model source
 * adapter for the unchanged AVEN-008 Context Broker (AVEN-009 patch 8). Only
 * this subpath depends on `@aven/context-broker`; the root entry stays pure.
 */
export {
  AVEN_OWNER_MODEL_SOURCE_CONFIG_V1,
  createOwnerModelContextSources,
} from './sources.ts';
