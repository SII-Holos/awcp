/**
 * Agent Card for Synergy Executor
 * 
 * Synergy is a powerful AI coding agent from holos-synergy project.
 * It features a multi-agent architecture with specialized subagents
 * for different tasks, extensive tool support, and skill system.
 */

import type { AgentCard } from '@a2a-js/sdk';
import { loadConfig } from './config.js';

const config = loadConfig();

export const synergyAgentCard: AgentCard = {
  name: 'Holos-Synergy',
  description: [
    'Full-featured AI coding agent with multi-agent orchestration.',
    'Powered by Synergy from holos-synergy project.',
    '',
    'Core capabilities:',
    '• Multi-agent system: master, explore, scholar, scout, advisor, scribe agents',
    '• 25+ built-in tools: file ops, AST-aware search, web search, bash, and more',
    '• Skill system: git workflows, frontend design, browser automation',
    '• LSP integration for intelligent code understanding',
    '',
    'Operates on delegated workspaces via AWCP protocol.',
  ].join('\n'),
  url: config.agentUrl,
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
    // === Code Implementation ===
    {
      id: 'implement',
      name: 'Code Implementation',
      description: 'Implement features, modules, and complete functionality from requirements. Handles multi-file changes, creates tests, and follows project conventions.',
      tags: ['code', 'implementation', 'feature', 'development'],
      examples: [
        'Implement a REST API with CRUD operations for users',
        'Add WebSocket support for real-time notifications',
        'Create a CLI tool with argument parsing',
        'Build a React component with state management',
      ],
    },
    {
      id: 'refactor',
      name: 'Refactoring',
      description: 'Restructure and improve existing code without changing behavior. Applies patterns, extracts modules, improves naming, and reduces complexity.',
      tags: ['refactor', 'clean-code', 'patterns', 'architecture'],
      examples: [
        'Extract common logic into reusable utilities',
        'Convert callbacks to async/await',
        'Apply dependency injection pattern',
        'Split monolithic module into focused components',
      ],
    },
    // === Analysis & Review ===
    {
      id: 'review',
      name: 'Code Review',
      description: 'Thorough code review covering correctness, security, performance, and maintainability. Provides actionable feedback with specific suggestions.',
      tags: ['review', 'security', 'performance', 'best-practices'],
      examples: [
        'Review this PR for security vulnerabilities',
        'Check this module for performance issues',
        'Audit authentication flow for OWASP compliance',
        'Review error handling patterns',
      ],
    },
    {
      id: 'explore',
      name: 'Codebase Exploration',
      description: 'Navigate and understand unfamiliar codebases. Uses AST-aware search, grep, and glob to find patterns, trace data flow, and map architecture.',
      tags: ['explore', 'search', 'architecture', 'understanding'],
      examples: [
        'How does the authentication system work?',
        'Find all usages of the PaymentService',
        'Map the data flow from API to database',
        'What modules depend on this utility?',
      ],
    },
    // === Debugging & Fixing ===
    {
      id: 'debug',
      name: 'Debugging',
      description: 'Diagnose and fix bugs using systematic analysis. Traces execution, identifies root causes, and implements targeted fixes.',
      tags: ['debug', 'fix', 'bugs', 'troubleshoot'],
      examples: [
        'Why is this test flaky?',
        'Find the memory leak in worker pool',
        'Debug race condition in async handler',
        'Fix null reference exception in user service',
      ],
    },
    {
      id: 'test',
      name: 'Testing',
      description: 'Write comprehensive tests including unit, integration, and e2e. Covers edge cases, mocks dependencies, and improves coverage.',
      tags: ['test', 'unit-test', 'integration', 'coverage'],
      examples: [
        'Add unit tests for the validation module',
        'Write integration tests for API endpoints',
        'Create test fixtures for database operations',
        'Add edge case coverage for parser',
      ],
    },
    // === Research & Documentation ===
    {
      id: 'research',
      name: 'Technical Research',
      description: 'Research libraries, APIs, and best practices. Searches documentation, analyzes examples, and provides implementation guidance.',
      tags: ['research', 'documentation', 'api', 'libraries'],
      examples: [
        'How to implement OAuth2 with this framework?',
        'Compare state management solutions',
        'Find best practices for error handling',
        'Research database migration strategies',
      ],
    },
    {
      id: 'document',
      name: 'Documentation',
      description: 'Write clear technical documentation including READMEs, API docs, architecture guides, and inline comments.',
      tags: ['docs', 'readme', 'api-docs', 'comments'],
      examples: [
        'Document the public API',
        'Write a getting started guide',
        'Create architecture decision records',
        'Add JSDoc comments to exported functions',
      ],
    },
    // === Git & Workflow ===
    {
      id: 'git',
      name: 'Git Operations',
      description: 'Git workflow including commits, rebasing, history analysis, and conflict resolution. Follows conventional commits.',
      tags: ['git', 'commit', 'rebase', 'history'],
      examples: [
        'Create atomic commits for these changes',
        'Squash recent commits with good message',
        'Find when this bug was introduced',
        'Resolve merge conflicts',
      ],
    },
    // === Frontend ===
    {
      id: 'frontend',
      name: 'Frontend Development',
      description: 'Build beautiful, responsive UIs. Handles components, styling, animations, and accessibility.',
      tags: ['frontend', 'ui', 'css', 'components', 'responsive'],
      examples: [
        'Create a responsive dashboard layout',
        'Add dark mode with smooth transitions',
        'Build an accessible form with validation',
        'Implement loading states and skeleton screens',
      ],
    },
  ],
};
