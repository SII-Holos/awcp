import { describe, it, expect } from 'vitest';
import { GitTransport } from '../src/git-transport.js';

describe('GitTransport', () => {
  describe('constructor', () => {
    it('should create instance with default config', () => {
      const transport = new GitTransport();
      expect(transport.type).toBe('git');
      expect(transport.capabilities).toEqual({
        supportsSnapshots: true,
        liveSync: false,
      });
    });

    it('should use custom tempDir from config', () => {
      const transport = new GitTransport({
        delegator: {
          remoteUrl: 'https://github.com/test/repo.git',
          auth: { type: 'none' },
          tempDir: '/custom/temp',
        },
      });
      expect(transport.type).toBe('git');
    });
  });

  describe('checkDependency', () => {
    it('should return available true when git is installed', async () => {
      const transport = new GitTransport();
      const result = await transport.checkDependency();
      expect(result.available).toBe(true);
    });
  });

  describe('prepare', () => {
    it('should throw error when remoteUrl is not configured', async () => {
      const transport = new GitTransport();
      await expect(
        transport.prepare({
          delegationId: 'test',
          exportPath: '/tmp/test',
          ttlSeconds: 3600,
        })
      ).rejects.toThrow('GitTransport: delegator.remoteUrl is required');
    });
  });
});
