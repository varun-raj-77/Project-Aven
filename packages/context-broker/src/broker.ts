import {
  CONTEXT_BROKER_CONFIG_VERSION,
  CONTEXT_BROKER_VERSION,
  EXTERNAL_SOURCE_PROVENANCE_KINDS,
  MAX_CANDIDATES_PER_SOURCE,
  MAX_RAW_ITEMS_PER_SOURCE,
  MAX_RAW_ITEMS_TOTAL,
  MAX_SELECTED_CONTEXT_CHARS,
  MAX_SELECTED_ITEMS,
  MAX_SINGLE_CONTEXT_ITEM_CHARS,
  MAX_SOURCES,
  MAX_TOTAL_CANDIDATES,
  NEGATIVE_SIGNAL_SUPPRESSION_VALUE,
  RELEVANCE_VERSION,
  SCOPE_VERSION,
  SOURCE_COLLECTION_DEADLINE_MS,
  SOURCE_KIND_REFERENCE_KINDS,
  TRACE_VERSION,
  type ContextSourceKind,
} from './config.ts';
import { DEADLINE_EXPIRED, startCollectionDeadline } from './deadline.ts';
import {
  ContextBrokerError,
  type ContextBrokerErrorCode,
  type ContextBrokerErrorLocation,
} from './errors.ts';
import {
  extractQueryTerms,
  lexicalRelevance,
  type LexicalRelevance,
} from './relevance.ts';
import {
  freshness,
  provenanceFactor,
  scopeFactor,
  score,
  trustBasis,
  trustFactor,
  type FreshnessAssessment,
  type ScoreBreakdown,
  type TrustBasis,
} from './ranking.ts';
import {
  assessScope,
  taskBindingMatches,
  withTaskBinding,
  type ScopeAssessment,
} from './scope.ts';
import {
  INTERNAL,
  type ContextRequest,
  type ParsedContextCandidate,
  type ParsedContextRequest,
  type TaskDescriptor,
} from './types.ts';
import {
  canonicalJson,
  codePointLength,
  compareCodeUnits,
  deepFreeze,
  truncateCodePoints,
} from './util.ts';

/**
 * Context Broker v2 (AVEN-008): TASK-SPECIFIC CONTEXT ASSEMBLY.
 *
 *   request + transient candidates from injected sources (bounded by a
 *   collection deadline)
 *     -> raw resource bound -> recognizable foreign records dropped
 *     -> owner-context quotas -> validation -> identity deduplication
 *     -> eligibility/scope -> transparent ranking -> negative signals
 *     -> budgeted deterministic selection -> ContextBundle + trace
 *
 * Context is not memory. The broker is read/compute-only: it owns no storage,
 * appends nothing to the Ledger, persists no score, signal or selection,
 * mutates no source or candidate, creates no learned state or correction,
 * calls no model or network, and makes no permission decision. Candidate text
 * is data; it never changes ownership, provenance, trust or scope. The bundle
 * is structured context, not a prompt; later fast-loop code serializes it.
 *
 * Every read of caller- or source-supplied data (properties, getters, array
 * elements, proxies) happens inside `guard`, which turns ANY thrown value into
 * a fixed, typed `ContextBrokerError` without keeping the thrown value.
 */

/** The owner-scoped, deep-frozen query every source receives. */
export interface ContextSourceQuery {
  readonly ownerId: string;
  readonly task: { readonly sessionId: string; readonly taskId: string };
  readonly request: string;
  readonly referenceTime: string;
  readonly taskDescriptor: Readonly<TaskDescriptor>;
  /** Owner-context quota: more of the owner's candidates fail the assembly. */
  readonly maxCandidates: number;
}

/** Aborted when the collection deadline expires; sources may honour it. */
export interface ContextSourceCollectOptions {
  readonly signal: AbortSignal;
}

/**
 * Injected source boundary. A trusted caller registers each source with an ID
 * and a kind; future adapters (Owner Model, episodes, procedures, active task,
 * permitted external content) implement `collect`. The broker validates every
 * returned candidate itself and does not trust the source for owner isolation.
 *
 * Note: AVEN-002's `ContextSourceSchema` describes a candidate's REFERENCE
 * (what item it points to); it is the candidate's `reference` field here.
 */
export interface ContextSource {
  readonly sourceId: string;
  readonly kind: ContextSourceKind;
  collect(
    query: ContextSourceQuery,
    options: ContextSourceCollectOptions,
  ): readonly unknown[] | Promise<readonly unknown[]>;
}

export interface ContextBrokerOptions {
  readonly sources: readonly ContextSource[];
}

export type ExclusionReason =
  | 'duplicate_identity'
  | 'superseded'
  | 'revoked'
  | 'recorded_after_reference_time'
  | 'task_binding_mismatch'
  | 'scope_mismatch'
  | 'scope_unresolved'
  | 'negative_signal_suppressed'
  | 'no_relevance_channel'
  | 'item_limit'
  | 'context_budget';

/** Eligibility reasons in precedence order, then the two budget reasons. */
export const EXCLUSION_REASONS: readonly ExclusionReason[] = Object.freeze([
  'duplicate_identity',
  'superseded',
  'revoked',
  'recorded_after_reference_time',
  'task_binding_mismatch',
  'scope_mismatch',
  'scope_unresolved',
  'negative_signal_suppressed',
  'no_relevance_channel',
  'item_limit',
  'context_budget',
]);

export type RelevanceChannel = 'lexical_content_term' | 'task' | 'scope_label';

export interface BudgetUsage {
  readonly characterUnit: 'unicode_code_point';
  readonly maxSelectedItems: number;
  readonly maxContextChars: number;
  readonly maxItemChars: number;
  readonly selectedItems: number;
  readonly usedChars: number;
  readonly truncatedItems: number;
  /** Eligible items skipped because they did not fit the remaining chars. */
  readonly contextBudgetExclusions: number;
  /** Eligible items left after the item limit was reached. */
  readonly itemLimitExclusions: number;
}

export interface ContextBundleItem {
  readonly rank: number;
  readonly sourceId: string;
  readonly sourceKind: ContextSourceKind;
  readonly candidateId: string;
  readonly reference: ParsedContextCandidate['reference'];
  readonly provenance: ParsedContextCandidate['provenance'];
  readonly scope: ParsedContextCandidate['scope'];
  readonly recordedAt: string;
  readonly lastValidatedAt: string | null;
  /** Item text as data, possibly truncated to `maxItemChars` code points. */
  readonly text: string;
  readonly truncated: boolean;
  readonly originalChars: number;
  readonly includedChars: number;
  readonly score: ScoreBreakdown;
}

interface Versions {
  readonly brokerVersion: string;
  readonly configVersion: string;
  readonly relevanceVersion: string;
  readonly scopeVersion: string;
}

/** Transient context for ONE task. Not owner memory and not authority. */
export interface ContextBundle extends Versions {
  readonly kind: 'context_bundle';
  readonly ownerId: string;
  readonly task: { readonly sessionId: string; readonly taskId: string };
  readonly referenceTime: string;
  /** Selected items in rank order. */
  readonly items: readonly ContextBundleItem[];
  readonly budget: BudgetUsage;
}

export interface TraceCandidate {
  readonly sourceId: string;
  readonly sourceKind: ContextSourceKind;
  readonly candidateId: string;
  readonly referenceKind: ParsedContextCandidate['reference']['kind'];
  readonly lifecycle: string | null;
  readonly provenanceKind: ParsedContextCandidate['provenance']['kind'];
  readonly signals: {
    readonly confidence: number;
    readonly salience: number;
    readonly negativeRetrieval: number;
  };
  readonly selection: 'selected' | 'excluded';
  readonly exclusionReason: ExclusionReason | null;
  /** The kept candidate this one duplicates (same owner), if any. */
  readonly duplicateOf: {
    readonly sourceId: string;
    readonly candidateId: string;
  } | null;
  /** 1-based position among eligible candidates; null if ineligible. */
  readonly eligibleRank: number | null;
  readonly taskBinding: 'matches' | 'does_not_match' | 'not_task_bound';
  readonly scope: ScopeAssessment;
  /** Counts only: matched terms are request-derived and never echoed. */
  readonly relevance: {
    readonly score: number;
    readonly matchedTermCount: number;
    readonly matchedContentTermCount: number;
  };
  readonly channels: readonly RelevanceChannel[];
  readonly freshness: FreshnessAssessment | null;
  readonly trustBasis: TrustBasis;
  /** Present only for eligible candidates; eligibility is never a low score. */
  readonly score: ScoreBreakdown | null;
  readonly text: {
    readonly originalChars: number;
    readonly includedChars: number;
    readonly truncated: boolean;
  };
}

export interface TraceSource {
  readonly sourceId: string;
  readonly kind: ContextSourceKind;
  /** The requesting owner's validated candidates from this source. */
  readonly considered: number;
}

/**
 * Observable, non-chain-of-thought trace (`aven-008-trace-v2`): owner-local
 * identifiers, reason codes, counts and numbers. It holds no item text, no
 * request-derived terms, nothing about other owners' records (no IDs, counts
 * or totals), no hidden reasoning and no authority decision. It is
 * metadata-oriented, NOT a safe place for secrets: caller-chosen IDs appear
 * verbatim.
 */
export interface ContextBrokerTrace extends Versions {
  readonly kind: 'context_broker_trace';
  readonly traceVersion: string;
  readonly ownerId: string;
  readonly task: { readonly sessionId: string; readonly taskId: string };
  readonly referenceTime: string;
  readonly query: {
    readonly termCount: number;
    readonly contentTermCount: number;
    readonly qualifierTermCount: number;
  };
  readonly sources: readonly TraceSource[];
  /** Every validated same-owner candidate, ordered by sourceId then candidateId. */
  readonly candidates: readonly TraceCandidate[];
  /** Eligible candidates in rank order with their final scores. */
  readonly ranking: readonly {
    readonly sourceId: string;
    readonly candidateId: string;
    readonly final: number;
  }[];
  readonly selected: readonly {
    readonly rank: number;
    readonly sourceId: string;
    readonly candidateId: string;
  }[];
  readonly totals: {
    readonly considered: number;
    readonly eligible: number;
    readonly selected: number;
    readonly excludedByReason: Readonly<Record<ExclusionReason, number>>;
  };
  readonly budget: BudgetUsage;
}

export interface ContextAssembly {
  readonly bundle: ContextBundle;
  readonly trace: ContextBrokerTrace;
}

export interface ContextBroker {
  /** Registered sources, ordered by sourceId. */
  readonly sources: readonly {
    readonly sourceId: string;
    readonly kind: ContextSourceKind;
  }[];
  assemble(request: ContextRequest): Promise<ContextAssembly>;
}

interface RegisteredSource {
  readonly sourceId: string;
  readonly kind: ContextSourceKind;
  readonly target: object;
  readonly collect: (...args: unknown[]) => unknown;
}

/**
 * Runs `read` (which touches untrusted data) and converts ANY thrown value,
 * including a spoofed `ContextBrokerError`, into a fresh fixed broker error.
 * The thrown value is discarded, never kept as `cause`.
 */
function guard<T>(
  read: () => T,
  code: ContextBrokerErrorCode,
  location: ContextBrokerErrorLocation = {},
): T {
  try {
    return read();
  } catch {
    throw new ContextBrokerError(code, location);
  }
}

const REJECT = Symbol('reject');

function register(options: unknown): RegisteredSource[] {
  const entries = guard(() => {
    if (options === null || typeof options !== 'object') throw REJECT;
    const keys = Reflect.ownKeys(options);
    if (keys.length !== 1 || keys[0] !== 'sources') throw REJECT;
    const sources: unknown = Reflect.get(options, 'sources');
    if (!Array.isArray(sources)) throw REJECT;
    const length: unknown = sources.length;
    if (typeof length !== 'number' || length > MAX_SOURCES) throw REJECT;
    const read = [];
    for (let i = 0; i < length; i += 1) {
      const source: unknown = sources[i];
      if (source === null || typeof source !== 'object') throw REJECT;
      // Read once at registration: a source cannot later change its identity.
      read.push({
        target: source,
        sourceId: Reflect.get(source, 'sourceId') as unknown,
        kind: Reflect.get(source, 'kind') as unknown,
        collect: Reflect.get(source, 'collect') as unknown,
      });
    }
    return read;
  }, 'invalid_configuration');
  const registered = entries.map((entry) => {
    if (
      typeof entry.sourceId !== 'string' ||
      !INTERNAL.localId.safeParse(entry.sourceId).success ||
      !INTERNAL.sourceKind.safeParse(entry.kind).success ||
      typeof entry.collect !== 'function'
    )
      throw new ContextBrokerError('invalid_configuration');
    return Object.freeze({
      sourceId: entry.sourceId,
      kind: entry.kind as ContextSourceKind,
      target: entry.target,
      collect: entry.collect as (...args: unknown[]) => unknown,
    });
  });
  registered.sort((a, b) => compareCodeUnits(a.sourceId, b.sourceId));
  if (new Set(registered.map((s) => s.sourceId)).size !== registered.length)
    throw new ContextBrokerError('invalid_configuration');
  return registered;
}

interface Collected {
  readonly source: RegisteredSource;
  readonly candidates: readonly ParsedContextCandidate[];
}

async function collectAll(
  sources: readonly RegisteredSource[],
  query: ContextSourceQuery,
): Promise<Collected[]> {
  const deadline = startCollectionDeadline(SOURCE_COLLECTION_DEADLINE_MS);
  const options: ContextSourceCollectOptions = Object.freeze({
    signal: deadline.signal,
  });
  let settled: PromiseSettledResult<unknown>[];
  try {
    settled = await Promise.allSettled(
      sources.map((s) =>
        deadline.race(
          Promise.resolve().then(() =>
            s.collect.call(s.target, query, options),
          ),
        ),
      ),
    );
  } finally {
    deadline.dispose();
  }

  // 1. Source outcomes, in sourceId order (never settlement order). A failed,
  //    timed-out or malformed source fails the whole assembly: no partial
  //    bundle that looks complete.
  const collections = settled.map((result, i) => {
    const sourceId = sources[i]!.sourceId;
    if (result.status === 'rejected')
      throw new ContextBrokerError(
        result.reason === DEADLINE_EXPIRED
          ? 'source_timeout'
          : 'source_failure',
        { sourceId },
      );
    const value: unknown = result.value;
    const length = guard(
      () => {
        if (!Array.isArray(value)) throw REJECT;
        const n: unknown = value.length;
        if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0)
          throw REJECT;
        return n;
      },
      'source_failure',
      { sourceId },
    );
    return { value: value as readonly unknown[], length };
  });

  // 2. RAW resource bound (not an owner quota): checked on length alone,
  //    before any element is read, whoever the items belong to.
  let raw = 0;
  collections.forEach(({ length }, i) => {
    if (length > MAX_RAW_ITEMS_PER_SOURCE)
      throw new ContextBrokerError('source_resource_limit_exceeded', {
        sourceId: sources[i]!.sourceId,
      });
    raw += length;
  });
  if (raw > MAX_RAW_ITEMS_TOTAL)
    throw new ContextBrokerError('source_resource_limit_exceeded');

  // 3. Drop RECOGNIZABLE foreign records first: an object whose `ownerId` is
  //    a well-formed owner ID other than the requester's. Nothing else of
  //    theirs is read, validated, counted, deduplicated or traced.
  //
  //    Public error locations (H3 final correction): a raw source-array offset
  //    can be shifted by foreign records, so it is NEVER exposed. Failures
  //    before ownership is established (unreadable element or `ownerId`)
  //    carry only `sourceId`. Items whose `ownerId` reads as the requester's
  //    get an OWNER-LOCAL, zero-based position counted over those items only;
  //    that is the only `candidateIndex` a public error may carry.
  const owned = collections.map(({ value, length }, i) => {
    const sourceId = sources[i]!.sourceId;
    const items: { item: unknown; ownerIndex: number | undefined }[] = [];
    let ownerPosition = 0;
    for (let rawIndex = 0; rawIndex < length; rawIndex += 1) {
      const item = guard(
        () => value[rawIndex] as unknown,
        'invalid_candidate',
        { sourceId },
      );
      const owner = guard(
        () =>
          item !== null && typeof item === 'object'
            ? (Reflect.get(item, 'ownerId') as unknown)
            : undefined,
        'invalid_candidate',
        { sourceId },
      );
      const foreign =
        typeof owner === 'string' &&
        owner !== query.ownerId &&
        INTERNAL.ownerId.safeParse(owner).success;
      if (foreign) continue;
      // Unrecognizable owner (missing, malformed): kept so it fails closed
      // below, but without any public position.
      const ownerIndex = owner === query.ownerId ? ownerPosition++ : undefined;
      items.push({ item, ownerIndex });
    }
    return items;
  });

  // 4. OWNER-CONTEXT quotas, over the remaining (non-foreign) items only.
  let total = 0;
  owned.forEach((items, i) => {
    if (items.length > MAX_CANDIDATES_PER_SOURCE)
      throw new ContextBrokerError('candidate_limit_exceeded', {
        sourceId: sources[i]!.sourceId,
      });
    total += items.length;
  });
  if (total > MAX_TOTAL_CANDIDATES)
    throw new ContextBrokerError('candidate_limit_exceeded');

  // 5. Validation of a plain-data snapshot (getters run once, inside guard).
  return sources.map((source, i) => {
    const seen = new Set<string>();
    const candidates = owned[i]!.map(({ item, ownerIndex }) => {
      const location =
        ownerIndex === undefined
          ? { sourceId: source.sourceId }
          : { sourceId: source.sourceId, candidateIndex: ownerIndex };
      const snapshot = guard(
        () => structuredClone(item),
        'invalid_candidate',
        location,
      );
      const parsed = INTERNAL.candidate.safeParse(snapshot);
      if (!parsed.success)
        throw new ContextBrokerError(
          parsed.error.issues.every((issue) => issue.path[0] === 'signals')
            ? 'invalid_score_metadata'
            : 'invalid_candidate',
          location,
        );
      const candidate = parsed.data;
      // Owner read inconsistently (e.g. a getter that changed its answer),
      // reference kind not declared for this source kind, external content
      // presented as anything else, or a repeated ID within one source.
      if (
        candidate.ownerId !== query.ownerId ||
        !SOURCE_KIND_REFERENCE_KINDS[source.kind].includes(
          candidate.reference.kind,
        ) ||
        (source.kind === 'permitted_external' &&
          !EXTERNAL_SOURCE_PROVENANCE_KINDS.includes(
            candidate.provenance.kind,
          )) ||
        seen.has(candidate.candidateId)
      )
        throw new ContextBrokerError('invalid_candidate', location);
      seen.add(candidate.candidateId);
      return candidate;
    });
    candidates.sort((a, b) => compareCodeUnits(a.candidateId, b.candidateId));
    return { source, candidates };
  });
}

/** Structured identities of a candidate (no text-based deduplication). */
function identityKeys(candidate: ParsedContextCandidate): string[] {
  const reference = candidate.reference;
  const referenceKey =
    reference.kind === 'evidence'
      ? `evidence\u0000${reference.reference.evidenceId}`
      : reference.kind === 'current_instruction'
        ? `evidence\u0000${reference.evidence.evidenceId}`
        : `learned\u0000${reference.reference.learnedItemId}\u0000${reference.reference.version}`;
  return [`candidate\u0000${candidate.candidateId}`, referenceKey];
}

interface Entry {
  readonly source: RegisteredSource;
  readonly candidate: ParsedContextCandidate;
}

/**
 * Identity deduplication (M1). Candidates sharing a candidate ID, an evidence
 * ID (evidence or current-instruction reference) or a learned item ID plus
 * version form one group (transitively). A group whose members are not
 * identical apart from `candidateId` fails closed (`conflicting_duplicate`):
 * the broker never picks between disagreeing trust, scope or content. A
 * consistent group keeps its first member by sourceId, then candidateId.
 */
function deduplicate(entries: readonly Entry[]): Map<Entry, Entry> {
  const parent = entries.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i]!;
    return i;
  };
  const owner = new Map<string, number>();
  entries.forEach((entry, i) => {
    for (const key of identityKeys(entry.candidate)) {
      const j = owner.get(key);
      if (j === undefined) owner.set(key, i);
      else {
        const a = find(i);
        const b = find(j);
        if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
      }
    }
  });
  const duplicateOf = new Map<Entry, Entry>();
  const signature = (e: Entry) =>
    canonicalJson({ ...e.candidate, candidateId: null });
  entries.forEach((entry, i) => {
    const root = find(i);
    if (root === i) return;
    const kept = entries[root]!;
    if (signature(entry) !== signature(kept))
      throw new ContextBrokerError('conflicting_duplicate', {
        sourceId: entry.source.sourceId,
      });
    duplicateOf.set(entry, kept);
  });
  return duplicateOf;
}

interface Assessed {
  readonly source: RegisteredSource;
  readonly candidate: ParsedContextCandidate;
  readonly duplicateOf: Entry | undefined;
  readonly includedText: string;
  readonly originalChars: number;
  readonly includedChars: number;
  readonly truncated: boolean;
  readonly bindingMatch: boolean | undefined;
  readonly scope: ScopeAssessment;
  readonly relevance: LexicalRelevance;
  readonly channels: readonly RelevanceChannel[];
  readonly freshness: FreshnessAssessment | null;
  readonly trustBasis: TrustBasis;
  readonly ineligibility: ExclusionReason | null;
  readonly score: ScoreBreakdown | null;
}

function assess(
  entry: Entry,
  duplicateOf: Entry | undefined,
  request: ParsedContextRequest,
  query: ReturnType<typeof extractQueryTerms>,
): Assessed {
  const { source, candidate } = entry;
  const originalChars = codePointLength(candidate.text);
  const truncated = originalChars > MAX_SINGLE_CONTEXT_ITEM_CHARS;
  const includedText = truncated
    ? truncateCodePoints(candidate.text, MAX_SINGLE_CONTEXT_ITEM_CHARS)
    : candidate.text;
  const includedChars = Math.min(originalChars, MAX_SINGLE_CONTEXT_ITEM_CHARS);
  // Relevance is judged on exactly the text the bundle would carry.
  const relevance = lexicalRelevance(query, includedText);
  const bindingMatch = taskBindingMatches(candidate, request);
  const declared = assessScope(candidate, request);
  // A matching binding never clears an unresolved or mismatched restriction.
  const scope = bindingMatch === true ? withTaskBinding(declared) : declared;
  const reference = Date.parse(request.referenceTime);
  const afterReference =
    Date.parse(candidate.timestamps.recordedAt) > reference ||
    (candidate.timestamps.lastValidatedAt !== undefined &&
      Date.parse(candidate.timestamps.lastValidatedAt) > reference);
  const fresh = afterReference
    ? null
    : freshness(candidate, request.referenceTime);
  const channels: RelevanceChannel[] = [];
  if (relevance.matchedContentTermCount > 0)
    channels.push('lexical_content_term');
  if (scope.status === 'task_match') channels.push('task');
  if (scope.status === 'label_match') channels.push('scope_label');
  const lifecycle =
    candidate.reference.kind === 'owner_state'
      ? candidate.reference.lifecycle
      : undefined;
  const negative = candidate.signals.negativeRetrieval;
  // Eligibility in fixed precedence; the first failing rule is reported.
  const ineligibility: ExclusionReason | null =
    duplicateOf !== undefined
      ? 'duplicate_identity'
      : lifecycle === 'superseded'
        ? 'superseded'
        : lifecycle === 'revoked'
          ? 'revoked'
          : afterReference
            ? 'recorded_after_reference_time'
            : bindingMatch === false
              ? 'task_binding_mismatch'
              : scope.status === 'mismatch'
                ? 'scope_mismatch'
                : scope.status === 'unresolved'
                  ? 'scope_unresolved'
                  : negative >= NEGATIVE_SIGNAL_SUPPRESSION_VALUE
                    ? 'negative_signal_suppressed'
                    : channels.length === 0
                      ? 'no_relevance_channel'
                      : null;
  const basis = trustBasis(candidate);
  const breakdown =
    ineligibility === null &&
    fresh !== null &&
    scope.status !== 'mismatch' &&
    scope.status !== 'unresolved'
      ? score(
          {
            relevance: relevance.score,
            scope: scopeFactor(scope.status),
            provenance: provenanceFactor(candidate),
            confidence: candidate.signals.confidence,
            freshness: fresh.factor,
            salience: candidate.signals.salience,
            trust: trustFactor(basis),
          },
          negative,
        )
      : null;
  return {
    source,
    candidate,
    duplicateOf,
    includedText,
    originalChars,
    includedChars,
    truncated,
    bindingMatch,
    scope,
    relevance,
    channels: Object.freeze(channels),
    freshness: fresh,
    trustBasis: basis,
    ineligibility,
    score: breakdown,
  };
}

/** Final score descending, then sourceId, then candidateId (code units). */
function byRank(a: Assessed, b: Assessed): number {
  return (
    b.score!.final - a.score!.final ||
    compareCodeUnits(a.source.sourceId, b.source.sourceId) ||
    compareCodeUnits(a.candidate.candidateId, b.candidate.candidateId)
  );
}

export function createContextBroker(
  options: ContextBrokerOptions,
): ContextBroker {
  const sources = register(options);
  const descriptors = deepFreeze(
    sources.map(({ sourceId, kind }) => ({ sourceId, kind })),
  );

  async function assemble(input: ContextRequest): Promise<ContextAssembly> {
    const request = guard(() => {
      const parsed = INTERNAL.request.safeParse(structuredClone(input));
      if (!parsed.success) throw REJECT;
      return parsed.data;
    }, 'invalid_request');
    const task = {
      sessionId: request.task.sessionId,
      taskId: request.task.taskId,
    };
    const sourceQuery: ContextSourceQuery = deepFreeze({
      ownerId: request.ownerId,
      task: { ...task },
      request: request.request,
      referenceTime: request.referenceTime,
      taskDescriptor: structuredClone(request.taskDescriptor),
      maxCandidates: MAX_CANDIDATES_PER_SOURCE,
    });

    const collected = await collectAll(sources, sourceQuery);
    const query = extractQueryTerms(request.request);

    const entries: Entry[] = collected.flatMap(({ source, candidates }) =>
      candidates.map((candidate) => ({ source, candidate })),
    );
    const duplicates = deduplicate(entries);
    const assessed = entries.map((entry) =>
      assess(entry, duplicates.get(entry), request, query),
    );

    const eligible = assessed
      .filter((a) => a.ineligibility === null)
      .sort(byRank);
    const eligibleRank = new Map(eligible.map((a, i) => [a, i + 1]));

    // Budget (v2): walk the ranking once. An item that does not fit the
    // remaining characters is skipped (`context_budget`) and the walk
    // continues; once the item limit is reached, every remaining item is
    // `item_limit`. Survivors keep rank order and are never split beyond the
    // per-item code-point prefix.
    const budgetExclusion = new Map<Assessed, ExclusionReason>();
    const selected: Assessed[] = [];
    let usedChars = 0;
    let contextBudgetExclusions = 0;
    let itemLimitExclusions = 0;
    for (const item of eligible) {
      if (selected.length >= MAX_SELECTED_ITEMS) {
        budgetExclusion.set(item, 'item_limit');
        itemLimitExclusions += 1;
      } else if (usedChars + item.includedChars > MAX_SELECTED_CONTEXT_CHARS) {
        budgetExclusion.set(item, 'context_budget');
        contextBudgetExclusions += 1;
      } else {
        selected.push(item);
        usedChars += item.includedChars;
      }
    }

    const budget: BudgetUsage = {
      characterUnit: 'unicode_code_point',
      maxSelectedItems: MAX_SELECTED_ITEMS,
      maxContextChars: MAX_SELECTED_CONTEXT_CHARS,
      maxItemChars: MAX_SINGLE_CONTEXT_ITEM_CHARS,
      selectedItems: selected.length,
      usedChars,
      truncatedItems: selected.filter((s) => s.truncated).length,
      contextBudgetExclusions,
      itemLimitExclusions,
    };
    const versions: Versions = {
      brokerVersion: CONTEXT_BROKER_VERSION,
      configVersion: CONTEXT_BROKER_CONFIG_VERSION,
      relevanceVersion: RELEVANCE_VERSION,
      scopeVersion: SCOPE_VERSION,
    };
    const identity = {
      ownerId: request.ownerId,
      task,
      referenceTime: request.referenceTime,
    };

    const bundle: ContextBundle = {
      kind: 'context_bundle',
      ...versions,
      ...identity,
      items: selected.map((s, i) => ({
        rank: i + 1,
        sourceId: s.source.sourceId,
        sourceKind: s.source.kind,
        candidateId: s.candidate.candidateId,
        reference: structuredClone(s.candidate.reference),
        provenance: structuredClone(s.candidate.provenance),
        scope: structuredClone(s.candidate.scope),
        recordedAt: s.candidate.timestamps.recordedAt,
        lastValidatedAt: s.candidate.timestamps.lastValidatedAt ?? null,
        text: s.includedText,
        truncated: s.truncated,
        originalChars: s.originalChars,
        includedChars: s.includedChars,
        score: s.score!,
      })),
      budget: { ...budget },
    };

    const excludedByReason = Object.fromEntries(
      EXCLUSION_REASONS.map((r) => [r, 0]),
    ) as Record<ExclusionReason, number>;
    const traceCandidates: TraceCandidate[] = assessed.map((a) => {
      const exclusionReason = a.ineligibility ?? budgetExclusion.get(a) ?? null;
      if (exclusionReason !== null) excludedByReason[exclusionReason] += 1;
      return {
        sourceId: a.source.sourceId,
        sourceKind: a.source.kind,
        candidateId: a.candidate.candidateId,
        referenceKind: a.candidate.reference.kind,
        lifecycle:
          a.candidate.reference.kind === 'owner_state'
            ? a.candidate.reference.lifecycle
            : null,
        provenanceKind: a.candidate.provenance.kind,
        signals: { ...a.candidate.signals },
        selection: exclusionReason === null ? 'selected' : 'excluded',
        exclusionReason,
        duplicateOf:
          a.duplicateOf === undefined
            ? null
            : {
                sourceId: a.duplicateOf.source.sourceId,
                candidateId: a.duplicateOf.candidate.candidateId,
              },
        eligibleRank: eligibleRank.get(a) ?? null,
        taskBinding:
          a.bindingMatch === undefined
            ? 'not_task_bound'
            : a.bindingMatch
              ? 'matches'
              : 'does_not_match',
        scope: a.scope,
        relevance: {
          score: a.relevance.score,
          matchedTermCount: a.relevance.matchedTerms.length,
          matchedContentTermCount: a.relevance.matchedContentTermCount,
        },
        channels: a.channels,
        freshness: a.freshness,
        trustBasis: a.trustBasis,
        score: a.score,
        text: {
          originalChars: a.originalChars,
          includedChars: a.includedChars,
          truncated: a.truncated,
        },
      };
    });

    const trace: ContextBrokerTrace = {
      kind: 'context_broker_trace',
      traceVersion: TRACE_VERSION,
      ...versions,
      ...identity,
      task: { ...task },
      query: {
        termCount: query.terms.length,
        contentTermCount: query.contentTermCount,
        qualifierTermCount: query.qualifierTermCount,
      },
      sources: collected.map(({ source, candidates }) => ({
        sourceId: source.sourceId,
        kind: source.kind,
        considered: candidates.length,
      })),
      candidates: traceCandidates,
      ranking: eligible.map((a) => ({
        sourceId: a.source.sourceId,
        candidateId: a.candidate.candidateId,
        final: a.score!.final,
      })),
      selected: bundle.items.map((item) => ({
        rank: item.rank,
        sourceId: item.sourceId,
        candidateId: item.candidateId,
      })),
      totals: {
        considered: assessed.length,
        eligible: eligible.length,
        selected: selected.length,
        excludedByReason,
      },
      budget: { ...budget },
    };

    return deepFreeze({ bundle, trace });
  }

  return Object.freeze({ sources: descriptors, assemble });
}
