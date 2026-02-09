/**
 * Agent Card for Vision Executor
 *
 * Multimodal AI agent with vision capabilities.
 * Specializes in image understanding, visual content analysis,
 * and file system organization based on visual semantics.
 */

import type { AgentCard } from '@a2a-js/sdk';
import { loadConfig } from './config.js';

const config = loadConfig();

export const visionAgentCard: AgentCard = {
  name: 'Holos-Synergy (Vision)',
  description: [
    'Multimodal AI agent with strong vision and file management capabilities.',
    'Powered by Synergy from holos-synergy project with visual understanding models.',
    '',
    'Core capabilities:',
    '• Image recognition: identify objects, scenes, animals, text in images',
    '• Visual classification: categorize images by semantic content',
    '• File organization: rename, move, deduplicate files based on visual content',
    '• Multi-format support: JPEG, PNG, WebP, GIF, BMP, TIFF analysis',
    '• Batch processing: handle large directories of mixed media efficiently',
    '• Noise filtering: detect and handle corrupted, empty, or non-image files',
    '',
    'Operates on delegated workspaces via AWCP protocol.',
    'Best suited for tasks requiring visual understanding that text-only agents cannot perform.',
  ].join('\n'),
  url: config.agentUrl,
  version: '0.1.0',
  protocolVersion: '0.2.1',
  defaultInputModes: ['text'],
  defaultOutputModes: ['text'],
  capabilities: {
    streaming: false,
    pushNotifications: false,
    stateTransitionHistory: false,
  },
  skills: [
    // === Vision & Image Understanding ===
    {
      id: 'image-recognition',
      name: 'Image Recognition',
      description: 'Analyze and identify content in images including objects, animals, scenes, text, and visual patterns. Supports batch analysis of entire directories.',
      tags: ['vision', 'image', 'recognition', 'multimodal', 'classification'],
      examples: [
        'Identify all animals in a folder of photos',
        'Classify images by scene type (indoor, outdoor, nature)',
        'Read text and labels from screenshot images',
        'Detect and describe objects in product photos',
      ],
    },
    {
      id: 'file-organization',
      name: 'Visual File Organization',
      description: 'Organize, rename, and restructure files and directories based on visual content analysis. Handles deduplication, categorization, and semantic renaming.',
      tags: ['organize', 'rename', 'classify', 'deduplicate', 'filesystem'],
      examples: [
        'Sort photos into folders by animal species',
        'Rename images with descriptive names based on content',
        'Find and remove duplicate or near-duplicate images',
        'Clean up a messy photo directory into a structured hierarchy',
      ],
    },
    {
      id: 'media-analysis',
      name: 'Media Analysis',
      description: 'Analyze media files for quality, metadata, format issues. Detect corrupted files, empty files, and non-media files mixed into image directories.',
      tags: ['media', 'quality', 'validation', 'cleanup', 'analysis'],
      examples: [
        'Find and remove corrupted or empty image files',
        'Identify non-image files mixed into photo directories',
        'Analyze image quality and resolution statistics',
        'Generate a manifest of all media files with descriptions',
      ],
    },
    // === General File Operations ===
    {
      id: 'file-management',
      name: 'File Management',
      description: 'General file system operations including bulk rename, move, copy, and directory restructuring.',
      tags: ['files', 'rename', 'move', 'directory', 'batch'],
      examples: [
        'Flatten nested directory structure',
        'Batch rename files with consistent naming convention',
        'Move files matching criteria to specific directories',
        'Create organized directory structure from flat file list',
      ],
    },
  ],
};
