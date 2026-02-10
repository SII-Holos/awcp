import type { AssignmentState, Assignment } from '../types/messages.js';

// ========== Transition Table ==========

const ASSIGNMENT_TRANSITIONS: Record<AssignmentState, AssignmentState[]> = {
  pending: ['active', 'error'],
  active: ['completed', 'error'],
  completed: [],
  error: [],
};

export function isTerminalAssignmentState(state: AssignmentState): boolean {
  return ASSIGNMENT_TRANSITIONS[state].length === 0;
}

export function isValidAssignmentTransition(
  from: AssignmentState,
  to: AssignmentState,
): boolean {
  return ASSIGNMENT_TRANSITIONS[from].includes(to);
}

// ========== Events ==========

export type AssignmentEvent =
  | { type: 'RECEIVE_START' }
  | { type: 'TASK_COMPLETE' }
  | { type: 'TASK_FAIL' }
  | { type: 'RECEIVE_ERROR' }
  | { type: 'CANCEL' };

export interface AssignmentTransitionResult {
  success: boolean;
  newState: AssignmentState;
  error?: string;
}

// ========== State Machine ==========

export class AssignmentStateMachine {
  private state: AssignmentState = 'pending';

  constructor(initialState?: AssignmentState) {
    if (initialState) {
      this.state = initialState;
    }
  }

  getState(): AssignmentState {
    return this.state;
  }

  isTerminal(): boolean {
    return isTerminalAssignmentState(this.state);
  }

  transition(event: AssignmentEvent): AssignmentTransitionResult {
    const targetState = this.getTargetState(event);

    if (!targetState) {
      return {
        success: false,
        newState: this.state,
        error: `Invalid event ${event.type} for state ${this.state}`,
      };
    }

    if (!isValidAssignmentTransition(this.state, targetState)) {
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

  private getTargetState(event: AssignmentEvent): AssignmentState | null {
    switch (event.type) {
      case 'RECEIVE_START':
        return this.state === 'pending' ? 'active' : null;

      case 'TASK_COMPLETE':
        return this.state === 'active' ? 'completed' : null;

      case 'TASK_FAIL':
        return this.state === 'active' ? 'error' : null;

      case 'RECEIVE_ERROR':
      case 'CANCEL':
        return isTerminalAssignmentState(this.state) ? null : 'error';

      default:
        return null;
    }
  }
}

// ========== Factory ==========

export function createAssignment(params: {
  id: string;
  invite: Assignment['invite'];
  workPath: string;
}): Assignment {
  const now = new Date().toISOString();
  return {
    id: params.id,
    state: 'pending',
    invite: params.invite,
    workPath: params.workPath,
    createdAt: now,
    updatedAt: now,
  };
}
