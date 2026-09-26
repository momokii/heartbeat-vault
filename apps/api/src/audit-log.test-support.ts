import { z } from 'zod';

const auditItemSchema = z.object({
  id: z.number().int().positive(),
  timestamp: z.string().datetime(),
  actorId: z.string().uuid().nullable(),
  actorEmail: z.string().email().nullable(),
  action: z.string(),
  target: z.string().nullable(),
});
const auditPageSchema = z.object({
  items: z.array(auditItemSchema),
  nextBeforeId: z.number().int().positive().nullable(),
});

export function parseAuditPage(response: {
  readonly body: string;
}): z.infer<typeof auditPageSchema> {
  return auditPageSchema.parse(JSON.parse(response.body));
}
