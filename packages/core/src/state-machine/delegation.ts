import type {
  DelegationState,
  Delegation,
  EnvironmentSpec,
  InviteMessage,
  AcceptMessage,
  StartMessage,
  DoneMessage,
  ErrorMessage,
} from '../types/messages.js';

// ========== Transition Table ==========

const DELEGATION_TRANSITIONS: Record<DelegationState, DelegationState[]> = {
  created: ['invited', 'error', 'cancelled'],
  invited: ['accepted', 'error', 'cancelled', 'expired'],
  accepted: ['started', 'error', 'cancelled', 'expired'],
  started: ['running', 'error', 'cancelled'],
  running: ['completed', 'error', 'cancelled', 'expired'],
  completed: [],
  error: [],
  cancelled: [],
  expired: [],
};

export function isTerminalState(state: DelegationState): boolean {
  return DELEGATION_TRANSITIONS[state].length === 0;
}

export function isValidTransition(
  from: DelegationState,
  to: DelegationState,
): boolean {
  return DELEGATION_TRANSITIONS[from].includes(to);
}

// ========== Events ==========

export type DelegationEvent =
  | { type: 'SEND_INVITE'; message: InviteMessage }
  | { type: 'RECEIVE_ACCEPT'; message: AcceptMessage }
  | { type: 'SEND_START'; message: StartMessage }
  | { type: 'SETUP_COMPLETE' }
  | { type: 'RECEIVE_DONE'; message: DoneMessage }
  | { type: 'RECEIVE_ERROR'; message: ErrorMessage }
  | { type: 'SEND_ERROR'; message: ErrorMessage }
  | { type: 'CANCEL' }
  | { type: 'EXPIRE' };  // TODO: Implement lease expiration timer

export interface TransitionResult {
  success: boolean;
  newState: DelegationState;
  error?: string;
}

// ========== State Machine ==========

export class DelegationStateMachine {
  private state: DelegationState = 'created';

  constructor(initialState?: DelegationState) {
    if (initialState) {
      this.state = initialState;
    }
  }

  getState(): DelegationState {
    return this.state;
  }

  isTerminal(): boolean {
    return isTerminalState(this.state);
  }

  transition(event: DelegationEvent): TransitionResult {
    const targetState = this.getTargetState(event);
    
    if (!targetState) {
      return {
        success: false,
        newState: this.state,
        error: `Invalid event ${event.type} for state ${this.state}`,
      };
    }

    if (!isValidTransition(this.state, targetState)) {
      return {
        success: false,
        newState: this.state,
        error: `Invalid transition from ${this.state} to ${targetState}`,
      };
    }

    this.state = targetState;
    return {
      success: true,
      newState: this.state,
    };
  }

  private getTargetState(event: DelegationEvent): DelegationState | null {
    switch (event.type) {
      case 'SEND_INVITE':
        return this.state === 'created' ? 'invited' : null;
      
      case 'RECEIVE_ACCEPT':
        return this.state === 'invited' ? 'accepted' : null;
      
      case 'SEND_START':
        return this.state === 'accepted' ? 'started' : null;
      
      case 'SETUP_COMPLETE':
        return this.state === 'started' ? 'running' : null;
      
      case 'RECEIVE_DONE':
        return this.state === 'running' ? 'completed' : null;
      
      case 'RECEIVE_ERROR':
      case 'SEND_ERROR':
        return isTerminalState(this.state) ? null : 'error';
      
      case 'CANCEL':
        return isTerminalState(this.state) ? null : 'cancelled';
      
      case 'EXPIRE':
        return ['invited', 'accepted', 'running'].includes(this.state)
          ? 'expired'
          : null;
      
      default:
        return null;
    }
  }
}

// ========== Factory ==========

export function createDelegation(params: {
  id: string;
  peerUrl: string;
  environment: EnvironmentSpec;
  task: Delegation['task'];
  leaseConfig: Delegation['leaseConfig'];
  retentionMs: number;
  snapshotPolicy?: Delegation['snapshotPolicy'];
  exportPath?: string;
}): Delegation {
  const now = new Date().toISOString();
  return {
    id: params.id,
    state: 'created',
    peerUrl: params.peerUrl,
    environment: params.environment,
    task: params.task,
    leaseConfig: params.leaseConfig,
    retentionMs: params.retentionMs,
    snapshotPolicy: params.snapshotPolicy,
    exportPath: params.exportPath,
    createdAt: now,
    updatedAt: now,
  };
}
