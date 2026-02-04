/**
 * @awcp/transport-git
 *
 * Git-based transport for AWCP workspace delegation.
 * Supports GitHub, GitLab, Gitea, and self-hosted Git servers.
 */

export { GitTransport } from './git-transport.js';

export type {
  GitTransportConfig,
  GitDelegatorConfig,
  GitExecutorConfig,
  GitSnapshotInfo,
} from './types.js';
