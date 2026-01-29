/**
 * State Machine Tests
 * 
 * Tests for the delegation state machine that manages the AWCP protocol lifecycle.
 */

import { describe, it, expect } from 'vitest';
import {
  DelegationStateMachine,
  isTerminalState,
  isValidTransition,
  createDelegation,
  applyMessageToDelegation,
} from '../src/state-machine/index.js';
import type {
  InviteMessage,
  AcceptMessage,
  StartMessage,
  DoneMessage,
  ErrorMessage,
} from '../src/types/messages.js';
import { PROTOCOL_VERSION } from '../src/types/messages.js';

describe('isTerminalState', () => {
  it('should identify terminal states', () => {
    expect(isTerminalState('completed')).toBe(true);
    expect(isTerminalState('error')).toBe(true);
    expect(isTerminalState('cancelled')).toBe(true);
    expect(isTerminalState('expired')).toBe(true);
  });

  it('should identify non-terminal states', () => {
    expect(isTerminalState('created')).toBe(false);
    expect(isTerminalState('invited')).toBe(false);
    expect(isTerminalState('accepted')).toBe(false);
    expect(isTerminalState('started')).toBe(false);
    expect(isTerminalState('running')).toBe(false);
  });
});

describe('isValidTransition', () => {
  it('should allow valid happy-path transitions', () => {
    expect(isValidTransition('created', 'invited')).toBe(true);
    expect(isValidTransition('invited', 'accepted')).toBe(true);
    expect(isValidTransition('accepted', 'started')).toBe(true);
    expect(isValidTransition('started', 'running')).toBe(true);
    expect(isValidTransition('running', 'completed')).toBe(true);
  });

  it('should allow error transitions from non-terminal states', () => {
    expect(isValidTransition('created', 'error')).toBe(true);
    expect(isValidTransition('invited', 'error')).toBe(true);
    expect(isValidTransition('accepted', 'error')).toBe(true);
    expect(isValidTransition('started', 'error')).toBe(true);
    expect(isValidTransition('running', 'error')).toBe(true);
  });

  it('should allow cancellation from non-terminal states', () => {
    expect(isValidTransition('created', 'cancelled')).toBe(true);
    expect(isValidTransition('invited', 'cancelled')).toBe(true);
    expect(isValidTransition('accepted', 'cancelled')).toBe(true);
    expect(isValidTransition('started', 'cancelled')).toBe(true);
    expect(isValidTransition('running', 'cancelled')).toBe(true);
  });

  it('should reject invalid transitions', () => {
    // Skip states
    expect(isValidTransition('created', 'accepted')).toBe(false);
    expect(isValidTransition('created', 'running')).toBe(false);
    expect(isValidTransition('invited', 'running')).toBe(false);
    
    // Backward transitions
    expect(isValidTransition('running', 'started')).toBe(false);
    expect(isValidTransition('accepted', 'invited')).toBe(false);
    
    // From terminal states
    expect(isValidTransition('completed', 'running')).toBe(false);
    expect(isValidTransition('error', 'created')).toBe(false);
  });
});

describe('DelegationStateMachine', () => {
  describe('initial state', () => {
    it('should start in created state by default', () => {
      const sm = new DelegationStateMachine();
      expect(sm.getState()).toBe('created');
    });

    it('should accept custom initial state', () => {
      const sm = new DelegationStateMachine('running');
      expect(sm.getState()).toBe('running');
    });
  });

  describe('happy path transitions', () => {
    it('should transition through complete lifecycle', () => {
      const sm = new DelegationStateMachine();
      const delegationId = 'test-delegation-123';

      // created -> invited
      const invite: InviteMessage = {
        version: PROTOCOL_VERSION,
        type: 'INVITE',
        delegationId,
        task: { description: 'Test', prompt: 'Test prompt' },
        workspace: { exportName: 'awcp/test-123' },
        lease: { ttlSeconds: 3600, accessMode: 'rw' },
      };
      expect(sm.transition({ type: 'SEND_INVITE', message: invite })).toMatchObject({
        success: true,
        newState: 'invited',
      });

      // invited -> accepted
      const accept: AcceptMessage = {
        version: PROTOCOL_VERSION,
        type: 'ACCEPT',
        delegationId,
        executorMount: { mountPoint: '/mounts/test-123' },
      };
      expect(sm.transition({ type: 'RECEIVE_ACCEPT', message: accept })).toMatchObject({
        success: true,
        newState: 'accepted',
      });

      // accepted -> started
      const start: StartMessage = {
        version: PROTOCOL_VERSION,
        type: 'START',
        delegationId,
        lease: { expiresAt: new Date().toISOString(), accessMode: 'rw' },
        mount: {
          transport: 'sshfs',
          endpoint: { host: 'localhost', port: 22, user: 'test' },
          exportLocator: '/tmp/test',
          credential: 'test-key',
        },
      };
      expect(sm.transition({ type: 'SEND_START', message: start })).toMatchObject({
        success: true,
        newState: 'started',
      });

      // started -> running
      expect(sm.transition({ type: 'MOUNT_COMPLETE' })).toMatchObject({
        success: true,
        newState: 'running',
      });

      // running -> completed
      const done: DoneMessage = {
        version: PROTOCOL_VERSION,
        type: 'DONE',
        delegationId,
        finalSummary: 'Task completed successfully',
      };
      expect(sm.transition({ type: 'RECEIVE_DONE', message: done })).toMatchObject({
        success: true,
        newState: 'completed',
      });

      expect(sm.isTerminal()).toBe(true);
    });
  });

  describe('error handling', () => {
    it('should transition to error state on RECEIVE_ERROR', () => {
      const sm = new DelegationStateMachine('running');
      const error: ErrorMessage = {
        version: PROTOCOL_VERSION,
        type: 'ERROR',
        delegationId: 'test',
        code: 'TASK_FAILED',
        message: 'Task failed',
      };

      expect(sm.transition({ type: 'RECEIVE_ERROR', message: error })).toMatchObject({
        success: true,
        newState: 'error',
      });
      expect(sm.isTerminal()).toBe(true);
    });

    it('should not allow error transition from terminal state', () => {
      const sm = new DelegationStateMachine('completed');
      const error: ErrorMessage = {
        version: PROTOCOL_VERSION,
        type: 'ERROR',
        delegationId: 'test',
        code: 'TASK_FAILED',
        message: 'Task failed',
      };

      expect(sm.transition({ type: 'RECEIVE_ERROR', message: error })).toMatchObject({
        success: false,
        newState: 'completed',
      });
    });
  });

  describe('cancellation', () => {
    it('should allow cancellation from any non-terminal state', () => {
      const states = ['created', 'invited', 'accepted', 'started', 'running'] as const;
      
      for (const state of states) {
        const sm = new DelegationStateMachine(state);
        expect(sm.transition({ type: 'CANCEL' })).toMatchObject({
          success: true,
          newState: 'cancelled',
        });
      }
    });

    it('should not allow cancellation from terminal state', () => {
      const sm = new DelegationStateMachine('completed');
      expect(sm.transition({ type: 'CANCEL' })).toMatchObject({
        success: false,
        newState: 'completed',
      });
    });
  });

  describe('expiration', () => {
    it('should allow expiration from invited, accepted, and running states', () => {
      for (const state of ['invited', 'accepted', 'running'] as const) {
        const sm = new DelegationStateMachine(state);
        expect(sm.transition({ type: 'EXPIRE' })).toMatchObject({
          success: true,
          newState: 'expired',
        });
      }
    });

    it('should not allow expiration from created or started states', () => {
      for (const state of ['created', 'started'] as const) {
        const sm = new DelegationStateMachine(state);
        expect(sm.transition({ type: 'EXPIRE' })).toMatchObject({
          success: false,
        });
      }
    });
  });

  describe('invalid transitions', () => {
    it('should reject out-of-order events', () => {
      const sm = new DelegationStateMachine();
      
      // Can't accept before invite
      const accept: AcceptMessage = {
        version: PROTOCOL_VERSION,
        type: 'ACCEPT',
        delegationId: 'test',
        executorMount: { mountPoint: '/mounts/test' },
      };
      expect(sm.transition({ type: 'RECEIVE_ACCEPT', message: accept })).toMatchObject({
        success: false,
        error: expect.stringContaining('Invalid event'),
      });
    });
  });
});

describe('createDelegation', () => {
  it('should create a delegation with correct initial values', () => {
    const delegation = createDelegation({
      id: 'test-123',
      peerUrl: 'http://executor:4001/awcp',
      localDir: '/path/to/project',
      task: { description: 'Fix bug', prompt: 'Fix the bug in main.ts' },
      leaseConfig: { ttlSeconds: 3600, accessMode: 'rw' },
    });

    expect(delegation.id).toBe('test-123');
    expect(delegation.state).toBe('created');
    expect(delegation.peerUrl).toBe('http://executor:4001/awcp');
    expect(delegation.localDir).toBe('/path/to/project');
    expect(delegation.task.description).toBe('Fix bug');
    expect(delegation.leaseConfig.ttlSeconds).toBe(3600);
    expect(delegation.createdAt).toBeDefined();
    expect(delegation.updatedAt).toBeDefined();
  });
});

describe('applyMessageToDelegation', () => {
  const baseDelegation = createDelegation({
    id: 'test-123',
    peerUrl: 'http://executor:4001/awcp',
    localDir: '/path/to/project',
    task: { description: 'Test', prompt: 'Test' },
    leaseConfig: { ttlSeconds: 3600, accessMode: 'rw' },
  });

  it('should apply ACCEPT message', () => {
    const accept: AcceptMessage = {
      version: PROTOCOL_VERSION,
      type: 'ACCEPT',
      delegationId: 'test-123',
      executorMount: { mountPoint: '/mounts/test-123' },
      executorConstraints: { 
        acceptedAccessMode: 'rw',
        sandboxProfile: { cwdOnly: true } 
      },
    };

    const updated = applyMessageToDelegation(baseDelegation, accept);
    expect(updated.executorMount).toEqual({ mountPoint: '/mounts/test-123' });
    expect(updated.executorConstraints?.sandboxProfile?.cwdOnly).toBe(true);
  });

  it('should apply DONE message', () => {
    const done: DoneMessage = {
      version: PROTOCOL_VERSION,
      type: 'DONE',
      delegationId: 'test-123',
      finalSummary: 'Task completed',
      highlights: ['Fixed bug', 'Added tests'],
    };

    const updated = applyMessageToDelegation(baseDelegation, done);
    expect(updated.result).toEqual({
      summary: 'Task completed',
      highlights: ['Fixed bug', 'Added tests'],
      notes: undefined,
    });
  });

  it('should apply ERROR message', () => {
    const error: ErrorMessage = {
      version: PROTOCOL_VERSION,
      type: 'ERROR',
      delegationId: 'test-123',
      code: 'TASK_FAILED',
      message: 'Task failed due to timeout',
      hint: 'Try increasing the TTL',
    };

    const updated = applyMessageToDelegation(baseDelegation, error);
    expect(updated.error).toEqual({
      code: 'TASK_FAILED',
      message: 'Task failed due to timeout',
      hint: 'Try increasing the TTL',
    });
  });
});
