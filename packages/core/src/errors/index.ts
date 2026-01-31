/**
 * AWCP Error Codes
 */
export const ErrorCodes = {
  DECLINED: 'DECLINED',
  DEP_MISSING: 'DEP_MISSING',
  WORKSPACE_TOO_LARGE: 'WORKSPACE_TOO_LARGE',
  WORKSPACE_NOT_FOUND: 'WORKSPACE_NOT_FOUND',
  WORKSPACE_INVALID: 'WORKSPACE_INVALID',
  WORKDIR_DENIED: 'WORKDIR_DENIED',
  START_EXPIRED: 'START_EXPIRED',
  EXPIRED: 'EXPIRED',
  AUTH_FAILED: 'AUTH_FAILED',
  SETUP_FAILED: 'SETUP_FAILED',
  TASK_FAILED: 'TASK_FAILED',
  CANCELLED: 'CANCELLED',
} as const;

export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes];

/**
 * Base class for AWCP errors
 */
export class AwcpError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly hint?: string,
    public readonly delegationId?: string,
  ) {
    super(message);
    this.name = 'AwcpError';
  }

  toErrorMessage() {
    return {
      code: this.code,
      message: this.message,
      hint: this.hint,
    };
  }
}

/**
 * Error: Remote declined the collaboration
 */
export class DeclinedError extends AwcpError {
  constructor(message: string, hint?: string, delegationId?: string) {
    super(ErrorCodes.DECLINED, message, hint, delegationId);
    this.name = 'DeclinedError';
  }
}

/**
 * Error: Missing required dependency
 */
export class DependencyMissingError extends AwcpError {
  constructor(
    public readonly dependency: string,
    hint?: string,
    delegationId?: string,
  ) {
    super(
      ErrorCodes.DEP_MISSING,
      `Missing required dependency: ${dependency}`,
      hint ?? `Please install ${dependency} and try again`,
      delegationId,
    );
    this.name = 'DependencyMissingError';
  }
}

/**
 * Error: Workspace too large
 */
export class WorkspaceTooLargeError extends AwcpError {
  constructor(
    public readonly stats: {
      estimatedBytes?: number;
      fileCount?: number;
      largestFileBytes?: number;
    },
    hint?: string,
    delegationId?: string,
  ) {
    super(
      ErrorCodes.WORKSPACE_TOO_LARGE,
      'Workspace exceeds size limits',
      hint ?? 'Consider selecting a smaller subdirectory or excluding large files',
      delegationId,
    );
    this.name = 'WorkspaceTooLargeError';
  }
}

/**
 * Error: Workspace directory not found
 */
export class WorkspaceNotFoundError extends AwcpError {
  constructor(workspacePath: string, hint?: string, delegationId?: string) {
    super(
      ErrorCodes.WORKSPACE_NOT_FOUND,
      `Workspace directory not found: ${workspacePath}`,
      hint ?? 'Verify the workspace path is correct',
      delegationId,
    );
    this.name = 'WorkspaceNotFoundError';
  }
}

/**
 * Error: Invalid workspace (e.g., path is not a directory)
 */
export class WorkspaceInvalidError extends AwcpError {
  constructor(workspacePath: string, reason: string, hint?: string, delegationId?: string) {
    super(
      ErrorCodes.WORKSPACE_INVALID,
      `Invalid workspace: ${reason} (${workspacePath})`,
      hint ?? 'Provide a valid directory path',
      delegationId,
    );
    this.name = 'WorkspaceInvalidError';
  }
}

/**
 * Error: Work directory denied by policy
 */
export class WorkDirDeniedError extends AwcpError {
  constructor(workDir: string, hint?: string, delegationId?: string) {
    super(
      ErrorCodes.WORKDIR_DENIED,
      `Work directory denied by policy: ${workDir}`,
      hint,
      delegationId,
    );
    this.name = 'WorkDirDeniedError';
  }
}

/**
 * Error: Transport setup failed
 */
export class SetupFailedError extends AwcpError {
  constructor(reason: string, hint?: string, delegationId?: string) {
    super(
      ErrorCodes.SETUP_FAILED,
      `Setup failed: ${reason}`,
      hint,
      delegationId,
    );
    this.name = 'SetupFailedError';
  }
}

/**
 * Error: Task execution failed
 */
export class TaskFailedError extends AwcpError {
  constructor(reason: string, hint?: string, delegationId?: string) {
    super(
      ErrorCodes.TASK_FAILED,
      `Task failed: ${reason}`,
      hint,
      delegationId,
    );
    this.name = 'TaskFailedError';
  }
}

/**
 * Error: Lease expired
 */
export class LeaseExpiredError extends AwcpError {
  constructor(duringStart: boolean = false, delegationId?: string) {
    super(
      duringStart ? ErrorCodes.START_EXPIRED : ErrorCodes.EXPIRED,
      duringStart
        ? 'Lease expired before START message was received'
        : 'Lease expired during task execution',
      undefined,
      delegationId,
    );
    this.name = 'LeaseExpiredError';
  }
}

/**
 * Error: Authentication failed
 */
export class AuthFailedError extends AwcpError {
  constructor(
    reason: string = 'Authentication failed',
    hint?: string,
    delegationId?: string,
  ) {
    super(
      ErrorCodes.AUTH_FAILED,
      reason,
      hint ?? 'Check your API key or credentials',
      delegationId,
    );
    this.name = 'AuthFailedError';
  }
}
