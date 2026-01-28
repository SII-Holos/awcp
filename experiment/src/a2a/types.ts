/**
 * A2A Protocol Types for AWCP Experiment
 * 
 * Simplified A2A message types for carrying AWCP protocol messages.
 * This is a minimal implementation for experiment purposes.
 */

import type { AwcpMessage } from '@awcp/core';

/**
 * A2A Message wrapper for AWCP messages
 */
export interface A2AMessage {
  /** Message ID */
  id: string;
  /** Timestamp */
  timestamp: string;
  /** Sender URL */
  senderUrl: string;
  /** Message type */
  type: 'awcp';
  /** AWCP payload */
  payload: AwcpMessage;
}

/**
 * A2A Response
 */
export interface A2AResponse {
  /** Whether the message was accepted */
  accepted: boolean;
  /** Optional error message */
  error?: string;
  /** Response message ID */
  messageId: string;
}

/**
 * Create an A2A message wrapping an AWCP message
 */
export function createA2AMessage(senderUrl: string, awcpMessage: AwcpMessage): A2AMessage {
  return {
    id: `a2a-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    timestamp: new Date().toISOString(),
    senderUrl,
    type: 'awcp',
    payload: awcpMessage,
  };
}

/**
 * Create a success response
 */
export function createSuccessResponse(messageId: string): A2AResponse {
  return {
    accepted: true,
    messageId,
  };
}

/**
 * Create an error response
 */
export function createErrorResponse(messageId: string, error: string): A2AResponse {
  return {
    accepted: false,
    error,
    messageId,
  };
}
