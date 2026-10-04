import { z } from 'zod';
import {
  EvidenceReferenceSchema,
  LearnedItemReferenceSchema,
  NonEmptyTextSchema,
  OwnerRecordShape,
  TaskBindingSchema,
  TimestampSchema,
} from './common.ts';
import { ContextIdSchema } from './ids.ts';
import { ProvenanceSchema } from './provenance.ts';

export const ContextSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('evidence'),
    reference: EvidenceReferenceSchema,
  }),
  z.strictObject({
    kind: z.literal('owner_state'),
    reference: LearnedItemReferenceSchema,
    lifecycle: z.enum([
      'observed',
      'validated',
      'trusted',
      'superseded',
      'revoked',
    ]),
  }),
  z.strictObject({
    kind: z.literal('active_task_state'),
    reference: LearnedItemReferenceSchema,
    task: TaskBindingSchema,
  }),
  z.strictObject({
    kind: z.literal('current_instruction'),
    evidence: EvidenceReferenceSchema,
    task: TaskBindingSchema,
  }),
]);
export const ContextSelectionSchema = z
  .strictObject({
    source: ContextSourceSchema,
    relevance: z.enum(['direct', 'supporting', 'uncertain']),
    scopeCompatibility: z.enum([
      'matches',
      'does_not_match',
      'uncertain',
      'unknown',
    ]),
    freshness: z.discriminatedUnion('status', [
      z.strictObject({ status: z.literal('unknown') }),
      z.strictObject({
        status: z.enum(['current', 'stale']),
        assessedAt: TimestampSchema,
        basis: NonEmptyTextSchema,
      }),
    ]),
    provenance: ProvenanceSchema,
    use: z.enum([
      'task_instruction',
      'background_evidence',
      'learned_guidance',
      'counterevidence',
    ]),
    inclusionReason: NonEmptyTextSchema,
  })
  .superRefine((v, ctx) => {
    if (
      v.use === 'learned_guidance' &&
      (v.source.kind !== 'owner_state' ||
        v.source.lifecycle !== 'trusted' ||
        v.scopeCompatibility !== 'matches')
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['use'],
        message: 'Learned guidance must reference matching trusted state',
      });
    }
    if (
      v.use === 'task_instruction' &&
      (v.source.kind !== 'current_instruction' ||
        !['explicit_owner_statement', 'explicit_owner_correction'].includes(
          v.provenance.kind,
        ))
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['use'],
        message:
          'Task instructions require explicit owner instruction provenance',
      });
    }
  });
export const TaskContextSchema = z
  .strictObject({
    kind: z.literal('task_context'),
    ...OwnerRecordShape,
    id: ContextIdSchema,
    task: TaskBindingSchema,
    assembledAt: TimestampSchema,
    selections: z.array(ContextSelectionSchema),
  })
  .superRefine((v, ctx) => {
    v.selections.forEach((s, i) => {
      if ('ownerId' in s.provenance && s.provenance.ownerId !== v.ownerId) {
        ctx.addIssue({
          code: 'custom',
          path: ['selections', i, 'provenance'],
          message: 'Owner-origin context must match the context owner',
        });
      }
      if (
        'task' in s.source &&
        (s.source.task.taskId !== v.task.taskId ||
          s.source.task.sessionId !== v.task.sessionId)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['selections', i, 'source'],
          message: 'Task-bound context must belong to this task/session',
        });
      }
    });
  });
export type TaskContext = z.infer<typeof TaskContextSchema>;
