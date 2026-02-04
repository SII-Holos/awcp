/**
 * ID Generation Utilities
 */

import { randomUUID, randomBytes } from 'node:crypto';

export type IdLength = 'short' | 'medium' | 'long' | 'full';

export interface GenerateIdOptions {
  prefix?: string;
  length?: IdLength;
}

const LENGTH_CONFIG: Record<IdLength, number> = {
  short: 8,    // 8 chars: ~48 bits entropy
  medium: 12,  // 12 chars: ~72 bits entropy
  long: 16,    // 16 chars: ~96 bits entropy
  full: 32,    // 32 chars: full UUID without hyphens
};

/**
 * Generate a unique ID with optional prefix and configurable length.
 *
 * @example
 * generateId() // "a1b2c3d4e5f6g7h8" (medium, no prefix)
 * generateId({ prefix: 'dlg' }) // "dlg_a1b2c3d4e5f6"
 * generateId({ prefix: 'snap', length: 'short' }) // "snap_a1b2c3d4"
 * generateId({ length: 'full' }) // "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6"
 */
export function generateId(options: GenerateIdOptions = {}): string {
  const { prefix, length = 'medium' } = options;

  let id: string;
  if (length === 'full') {
    id = randomUUID().replace(/-/g, '');
  } else {
    const bytes = Math.ceil(LENGTH_CONFIG[length] / 2);
    id = randomBytes(bytes).toString('hex').slice(0, LENGTH_CONFIG[length]);
  }

  return prefix ? `${prefix}_${id}` : id;
}

/**
 * Generate a delegation ID.
 */
export function generateDelegationId(length: IdLength = 'full'): string {
  return generateId({ prefix: 'dlg', length });
}

/**
 * Generate a snapshot ID.
 */
export function generateSnapshotId(length: IdLength = 'medium'): string {
  return generateId({ prefix: 'snap', length });
}

/**
 * Generate a task ID.
 */
export function generateTaskId(length: IdLength = 'medium'): string {
  return generateId({ prefix: 'task', length });
}
