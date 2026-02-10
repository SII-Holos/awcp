/**
 * @awcp/core
 * 
 * AWCP Protocol Core - Types, State Machine, and Error Definitions
 */

// Types
export * from './types/index.js';

// Utils
export * from './utils/index.js';

// State Machine - Delegation
export {
  DelegationStateMachine,
  isTerminalState,
  isValidTransition,
  createDelegation,
  type DelegationEvent,
  type TransitionResult,
} from './state-machine/index.js';

// State Machine - Assignment
export {
  AssignmentStateMachine,
  isTerminalAssignmentState,
  isValidAssignmentTransition,
  createAssignment,
  type AssignmentEvent,
  type AssignmentTransitionResult,
} from './state-machine/index.js';

// Errors
export * from './errors/index.js';

// Protocol version constant
export { PROTOCOL_VERSION } from './types/messages.js';
