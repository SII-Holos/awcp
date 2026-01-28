/**
 * Agent Card - Executor Agent Identity
 */

import type { AgentCard } from '@a2a-js/sdk';

export const executorAgentCard: AgentCard = {
  name: 'AWCP File Executor',
  description: 'An agent that can execute file operations on delegated workspaces via AWCP',
  url: 'http://localhost:4001',
  version: '0.1.0',
  protocolVersion: '0.2.1',
  defaultInputModes: ['text'],
  defaultOutputModes: ['text'],
  capabilities: {
    streaming: false,
    pushNotifications: false,
    stateTransitionHistory: false,
  },
  skills: [
    {
      id: 'file-operations',
      name: 'File Operations',
      description: 'Read, write, and modify files in the delegated workspace',
      tags: ['files', 'workspace', 'awcp'],
      examples: [
        'Read the contents of hello.txt',
        'Append a line to the file',
        'Create a new file called output.txt',
      ],
    },
  ],
};
