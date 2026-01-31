/**
 * delegate tool - Initiate a workspace delegation to a remote Executor
 *
 * This tool allows an AI agent to delegate a local directory to a remote
 * Executor agent for collaborative task execution.
 */

import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PeersContext } from '../peer-discovery.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DESCRIPTION_TEMPLATE = readFileSync(join(__dirname, 'delegate.txt'), 'utf-8');

export const delegateSchema = z.object({
  description: z
    .string()
    .describe('Short task description (for logs and listing)'),
  prompt: z
    .string()
    .describe('Full task instructions including goals and constraints'),
  workspace_dir: z
    .string()
    .describe('Local directory path to delegate to the Executor (absolute or relative)'),
  cwd: z
    .string()
    .optional()
    .describe('Current working directory for resolving relative workspace_dir paths. If not provided, relative paths are resolved against the daemon process cwd.'),
  peer_url: z
    .string()
    .url()
    .describe('URL of the target Executor AWCP endpoint'),
  ttl_seconds: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Lease duration in seconds (default: 3600)'),
  access_mode: z
    .enum(['ro', 'rw'])
    .optional()
    .describe('Access mode: ro (read-only) or rw (read-write, default)'),
  background: z
    .boolean()
    .optional()
    .describe(
      'If true, returns immediately with delegation_id. ' +
        'If false (default), waits for task completion.'
    ),
});

export type DelegateParams = z.infer<typeof delegateSchema>;

/**
 * Generate delegate tool description with available executors info
 */
export function generateDelegateDescription(peers?: PeersContext): string {
  let executorsSection = '';

  // Add available executors section if peers are configured
  if (peers && peers.peers.length > 0) {
    const availablePeers = peers.peers.filter(p => p.card);
    
    if (availablePeers.length > 0) {
      executorsSection = '## Available Executors';
      
      for (const peer of availablePeers) {
        const card = peer.card!;
        executorsSection += `\n\n### ${card.name}`;
        executorsSection += `\n- **URL**: \`${peer.awcpUrl}\``;
        
        if (card.description) {
          executorsSection += `\n- **Description**: ${card.description}`;
        }
        
        if (card.skills && card.skills.length > 0) {
          const skillNames = card.skills.map(s => s.name).join(', ');
          executorsSection += `\n- **Skills**: ${skillNames}`;
        }
      }
    }
  }

  // Replace {executors} placeholder with actual content
  return DESCRIPTION_TEMPLATE.replace('{executors}', executorsSection);
}

// For backward compatibility - static description without peers
export const delegateDescription = generateDelegateDescription();
