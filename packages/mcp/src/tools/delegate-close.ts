/**
 * delegate_close tool - End a multi-round delegation session
 *
 * Use this to clean up after all rounds are complete.
 */

import { z } from 'zod';

export const delegateCloseSchema = z.object({
  delegation_id: z
    .string()
    .describe('The delegation to close'),
});

export type DelegateCloseParams = z.infer<typeof delegateCloseSchema>;

export const delegateCloseDescription =
  'End a multi-round delegation session. This cleans up the workspace, transport connection, and environment. Use this when all rounds are complete and no more iterations are needed.';
