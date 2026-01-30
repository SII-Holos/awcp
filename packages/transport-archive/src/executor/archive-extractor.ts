/**
 * Archive Extractor
 *
 * Extracts ZIP archives to directories.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import * as yauzl from 'yauzl-promise';

export class ArchiveExtractor {
  /**
   * Extract a ZIP archive to a directory
   */
  async extract(archivePath: string, targetDir: string): Promise<void> {
    await fs.promises.mkdir(targetDir, { recursive: true });

    const zip = await yauzl.open(archivePath);

    try {
      for await (const entry of zip) {
        const entryPath = path.join(targetDir, entry.filename);

        // Security: prevent path traversal
        if (!entryPath.startsWith(targetDir + path.sep) && entryPath !== targetDir) {
          throw new Error(`Invalid entry path: ${entry.filename}`);
        }

        if (entry.filename.endsWith('/')) {
          // Directory entry
          await fs.promises.mkdir(entryPath, { recursive: true });
        } else {
          // File entry
          await fs.promises.mkdir(path.dirname(entryPath), { recursive: true });
          const readStream = await entry.openReadStream();
          const writeStream = fs.createWriteStream(entryPath);
          await pipeline(readStream, writeStream);
        }
      }
    } finally {
      await zip.close();
    }
  }

  /**
   * Apply changes from an uploaded archive to a directory.
   * This extracts the archive and overwrites existing files.
   */
  async applyChanges(archivePath: string, targetDir: string): Promise<void> {
    // For full upload strategy, we just extract and overwrite
    await this.extract(archivePath, targetDir);
  }

  /**
   * Create a ZIP archive from a directory (for uploading results)
   */
  async createArchive(sourceDir: string, archivePath: string): Promise<void> {
    // Dynamic import to avoid circular dependency issues
    const archiver = (await import('archiver')).default;

    const output = fs.createWriteStream(archivePath);
    const archive = archiver('zip', { zlib: { level: 6 } });

    archive.pipe(output);
    archive.directory(sourceDir, false);

    await archive.finalize();

    await new Promise<void>((resolve, reject) => {
      output.on('finish', resolve);
      output.on('error', reject);
    });
  }
}
