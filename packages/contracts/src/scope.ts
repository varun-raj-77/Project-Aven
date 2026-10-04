import { z } from 'zod';
import { NonEmptyTextSchema, TimestampSchema } from './common.ts';
import { TaskIdSchema } from './ids.ts';

export const TemporalQualifierSchema = z
  .strictObject({ from: TimestampSchema, until: TimestampSchema.optional() })
  .refine(
    (v) => !v.until || Date.parse(v.until) > Date.parse(v.from),
    'Temporal end must follow start',
  );
export const BoundedScopeSchema = z
  .strictObject({
    kind: z.literal('bounded'),
    domain: NonEmptyTextSchema.optional(),
    taskType: NonEmptyTextSchema.optional(),
    taskId: TaskIdSchema.optional(),
    qualifiers: z
      .strictObject({
        recipient: NonEmptyTextSchema.optional(),
        entity: NonEmptyTextSchema.optional(),
        context: NonEmptyTextSchema.optional(),
      })
      .refine(
        (v) => Object.values(v).some((x) => x !== undefined),
        'At least one qualifier is required',
      )
      .optional(),
    temporal: TemporalQualifierSchema.optional(),
  })
  .refine(
    (v) =>
      v.domain !== undefined ||
      v.taskType !== undefined ||
      v.taskId !== undefined,
    'Bounded scope needs a domain or task boundary',
  );
export const ScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('unknown'), reason: NonEmptyTextSchema }),
  z.strictObject({
    kind: z.literal('uncertain'),
    possibilities: z.array(BoundedScopeSchema).min(1),
    reason: NonEmptyTextSchema,
  }),
  BoundedScopeSchema,
  z.strictObject({
    kind: z.literal('global'),
    explicitDeclaration: NonEmptyTextSchema,
  }),
]);
export type Scope = z.infer<typeof ScopeSchema>;
