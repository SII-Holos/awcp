/**
 * @awcp/core
 * 
 * AWCP Protocol Core - Types, State Machine, and Error Definitions
 */

// Types
export * from './types/index.js';

// Utils
export * from './utils/index.js';

// State Machine
export {
  DelegationStateMachine,
  isTerminalState,
  isValidTransition,
  createDelegation,
  applyMessageToDelegation,
  type DelegationEvent,
  type TransitionResult,
} from './state-machine/index.js';

// Errors
export * from './errors/index.js';

// Protocol version constant
export { PROTOCOL_VERSION } from './types/messages.js';
