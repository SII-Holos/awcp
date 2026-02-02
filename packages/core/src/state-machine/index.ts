import type {
  DelegationState,
  AwcpMessage,
  Delegation,
  EnvironmentSpec,
  InviteMessage,
  AcceptMessage,
  StartMessage,
  DoneMessage,
  ErrorMessage,
} from '../types/messages.js';

const STATE_TRANSITIONS: Record<DelegationState, DelegationState[]> = {
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
  return STATE_TRANSITIONS[state].length === 0;
}

export function isValidTransition(
  from: DelegationState,
  to: DelegationState,
): boolean {
  return STATE_TRANSITIONS[from].includes(to);
}

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

export function createDelegation(params: {
  id: string;
  peerUrl: string;
  environment: EnvironmentSpec;
  task: Delegation['task'];
  leaseConfig: Delegation['leaseConfig'];
}): Delegation {
  const now = new Date().toISOString();
  return {
    id: params.id,
    state: 'created',
    peerUrl: params.peerUrl,
    environment: params.environment,
    task: params.task,
    leaseConfig: params.leaseConfig,
    createdAt: now,
    updatedAt: now,
  };
}

export function applyMessageToDelegation(
  delegation: Delegation,
  message: AwcpMessage,
): Delegation {
  const updated = { ...delegation, updatedAt: new Date().toISOString() };

  switch (message.type) {
    case 'ACCEPT':
      updated.executorWorkDir = message.executorWorkDir;
      updated.executorConstraints = message.executorConstraints;
      break;
    
    case 'START':
      updated.activeLease = message.lease;
      break;
    
    case 'DONE':
      updated.result = {
        summary: message.finalSummary,
        highlights: message.highlights,
        notes: message.notes,
      };
      break;
    
    case 'ERROR':
      updated.error = {
        code: message.code,
        message: message.message,
        hint: message.hint,
      };
      break;
  }

  return updated;
}
