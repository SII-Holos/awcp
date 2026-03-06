/**
 * delegate_continue tool - Send new instructions to an idle delegation
 *
 * Use this to start a new round in a multi-round delegation session.
 */

import { z } from 'zod';

export const delegateContinueSchema = z.object({
  delegation_id: z
    .string()
    .describe('The delegation to continue'),
  description: z
    .string()
    .describe('Short task description for logs'),
  prompt: z
    .string()
    .describe('Full updated task instructions'),
  background: z
    .boolean()
    .optional()
    .describe('If true, return immediately (default: false, wait for round completion)'),
});

export type DelegateContinueParams = z.infer<typeof delegateContinueSchema>;

export const delegateContinueDescription =
  'Send new instructions to an existing delegation in idle state. Use this when the previous round\'s results need adjustments. The executor keeps the workspace from previous rounds — no data is re-transferred.';
