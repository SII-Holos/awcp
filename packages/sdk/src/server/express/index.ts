/**
 * Express integration for AWCP
 */

// Executor-side handler (for A2A agents accepting delegations)
export { executorHandler, type ExecutorHandlerOptions } from './awcp-executor-handler.js';

// Delegator-side handler (for agents creating delegations)
export {
  delegatorHandler,
  type DelegatorHandlerOptions,
  type DelegatorHandlerResult,
} from './awcp-delegator-handler.js';
