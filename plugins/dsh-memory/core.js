/**
 * Tier 1 Core Memories: Management, deterministic prompt section injection,
 * and defensively bounded agent tools.
 *
 * Implements:
 * - Deterministic XML formatting (<core_memories>) sorted by priority DESC, key ASC
 * - Static prefix cache preservation: order 110 with interpolate: false
 * - CoreMemoryManager wrapping MemoryStorage
 * - manage_core_memory agent tool conforming to @deepseek-ai/dsh-tools defineTool
 *
 * @module @local/dsh-memory/core
 */

import { MemoryStorage } from './storage.js';

/** Default section name in the system prompt registry */
export const CORE_PROMPT_SECTION_NAME = 'memory:core';

/** Default order: 110 (after base instructions 100, before policies 500) */
export const CORE_PROMPT_SECTION_ORDER = 110;

/** Max entries returned by manage_core_memory list action */
export const MAX_TOOL_LIST_RESULTS = 100;

// Resolve defineTool dynamically with fallback to harness core tools package
let defaultDefineTool = (tool) => tool;
try {
  const toolsPkg = await import('@deepseek-ai/dsh-tools');
  if (typeof toolsPkg.defineTool === 'function') {
    defaultDefineTool = toolsPkg.defineTool;
  }
} catch {
  try {
    const harnessTools = await import('/export/DownloadsSSD/AI/TEXT/deepseek-harness/packages/core/tools/lib/index.js');
    if (typeof harnessTools.defineTool === 'function') {
      defaultDefineTool = harnessTools.defineTool;
    }
  } catch {
    // Identity fallback
  }
}

/**
 * Escape XML text content.
 *
 * @param {string} str
 * @returns {string}
 */
export function escapeXmlText(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Escape XML attribute value.
 *
 * @param {string} str
 * @returns {string}
 */
export function escapeXmlAttr(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Format a list of Core Memories into deterministic XML for prompt injection.
 * Sorted by priority DESC then lexicographically by key ASC.
 *
 * Returns an empty string if memories array is empty, ensuring no empty tag section.
 *
 * @param {Array<{key: string, directive: string, priority?: number}>} memories
 * @returns {string} XML string or empty string
 */
export function formatCorePromptSection(memories) {
  if (!Array.isArray(memories) || memories.length === 0) {
    return '';
  }

  const sorted = [...memories].sort((a, b) => {
    const prioA = Number.isInteger(a?.priority) ? a.priority : 0;
    const prioB = Number.isInteger(b?.priority) ? b.priority : 0;
    const diff = prioB - prioA;
    if (diff !== 0) return diff;
    return String(a?.key ?? '').localeCompare(String(b?.key ?? ''));
  });

  const lines = ['<core_memories>'];
  for (const item of sorted) {
    const keyAttr = escapeXmlAttr(String(item.key ?? ''));
    const prio = Number.isInteger(item.priority) ? item.priority : 0;
    const text = escapeXmlText(String(item.directive ?? ''));
    lines.push(`  <memory key="${keyAttr}" priority="${prio}">${text}</memory>`);
  }
  lines.push('</core_memories>');
  return lines.join('\n');
}

/**
 * CoreMemoryManager provides business operations over MemoryStorage for Tier 1 memories.
 */
export class CoreMemoryManager {
  /**
   * @param {MemoryStorage} storage
   * @param {object} [options]
   * @param {string} [options.defaultNamespace='global']
   */
  constructor(storage, options = {}) {
    if (!storage) {
      throw new Error('CoreMemoryManager: storage instance is required');
    }
    this.storage = storage;
    this.defaultNamespace = options.defaultNamespace || 'global';
  }

  /**
   * Store or upsert a Core Memory.
   *
   * @param {string|object} keyOrObj
   * @param {string} [directive]
   * @param {number} [priority=0]
   * @param {string} [namespace]
   * @returns {object}
   */
  set(keyOrObj, directive, priority = 0, namespace) {
    if (typeof keyOrObj === 'object' && keyOrObj !== null) {
      const ns = keyOrObj.namespace || this.defaultNamespace;
      return this.storage.setCoreMemory({
        id: keyOrObj.id,
        namespace: ns,
        key: keyOrObj.key,
        directive: keyOrObj.directive,
        priority: keyOrObj.priority ?? 0,
        updatedAt: keyOrObj.updatedAt,
      });
    }

    const ns = namespace || this.defaultNamespace;
    return this.storage.setCoreMemory({
      namespace: ns,
      key: keyOrObj,
      directive,
      priority,
    });
  }

  /**
   * Retrieve a Core Memory by key.
   *
   * @param {string} key
   * @param {string} [namespace]
   * @returns {object|null}
   */
  get(key, namespace) {
    const ns = namespace || this.defaultNamespace;
    return this.storage.getCoreMemory(ns, key);
  }

  /**
   * Retrieve a Core Memory by ID.
   *
   * @param {string} id
   * @returns {object|null}
   */
  getById(id) {
    return this.storage.getCoreMemoryById(id);
  }

  /**
   * List Core Memories in a namespace.
   *
   * @param {string} [namespace]
   * @returns {object[]}
   */
  list(namespace) {
    const ns = namespace || this.defaultNamespace;
    return this.storage.listCoreMemories(ns);
  }

  /**
   * List Core Memories across all namespaces.
   *
   * @returns {object[]}
   */
  listAll() {
    return this.storage.listCoreMemories();
  }

  /**
   * Delete a Core Memory by key.
   *
   * @param {string} key
   * @param {string} [namespace]
   * @returns {boolean}
   */
  delete(key, namespace) {
    const ns = namespace || this.defaultNamespace;
    return this.storage.deleteCoreMemory(ns, key);
  }

  /**
   * Delete a Core Memory by ID.
   *
   * @param {string} id
   * @returns {boolean}
   */
  deleteById(id) {
    return this.storage.deleteCoreMemoryById(id);
  }

  /**
   * Format the XML prompt section for a namespace.
   *
   * @param {string} [namespace]
   * @returns {string}
   */
  formatSection(namespace) {
    const ns = namespace || this.defaultNamespace;
    const memories = this.storage.listCoreMemories(ns);
    return formatCorePromptSection(memories);
  }
}

/**
 * Create a systemPrompt.section registration descriptor.
 *
 * Preserves static prefix caching by:
 * - Setting order 110 (after base instructions at 100)
 * - Setting interpolate: false to prevent mustache interpolation crashes
 * - Supplying dynamic text() getter that returns '' when no memories exist
 *
 * @param {CoreMemoryManager|MemoryStorage} target
 * @param {object} [options]
 * @param {string} [options.name]
 * @param {number} [options.order]
 * @param {string} [options.namespace]
 * @returns {object} Descriptor ready for ctx.systemPrompt.section(descriptor)
 */
export function createCorePromptSectionDescriptor(target, options = {}) {
  const name = options.name || CORE_PROMPT_SECTION_NAME;
  const order = options.order ?? CORE_PROMPT_SECTION_ORDER;
  const namespace = options.namespace || 'global';

  const getText = () => {
    if (typeof target?.formatSection === 'function') {
      return target.formatSection(namespace);
    }
    if (typeof target?.listCoreMemories === 'function') {
      return formatCorePromptSection(target.listCoreMemories(namespace));
    }
    if (typeof target === 'function') {
      const res = target(namespace);
      return Array.isArray(res) ? formatCorePromptSection(res) : String(res ?? '');
    }
    if (Array.isArray(target)) {
      return formatCorePromptSection(target);
    }
    return '';
  };

  return {
    name,
    order,
    interpolate: false,
    text: getText,
  };
}

/**
 * Create the manage_core_memory agent tool definition.
 *
 * @param {CoreMemoryManager|MemoryStorage} managerOrStorage
 * @param {object} [options]
 * @param {function} [options.defineTool] Custom defineTool override
 * @param {string} [options.defaultNamespace='global']
 * @returns {object} Registered tool definition
 */
export function createManageCoreMemoryTool(managerOrStorage, options = {}) {
  const manager = managerOrStorage instanceof CoreMemoryManager
    ? managerOrStorage
    : new CoreMemoryManager(managerOrStorage, options);

  const define = options.defineTool || defaultDefineTool;

  const render = (value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }];

  return define({
    name: 'manage_core_memory',
    description:
      'View, add, update, or remove persistent core memory directives (Tier 1 Core Memories). ' +
      'Directives are injected into the system prompt prefix to establish persistent persona, rules, and user preferences.',
    parameters: {
      action: {
        type: 'string',
        enum: ['list', 'get', 'set', 'delete'],
        required: true,
        description: 'Operation to perform on Core Memories: list, get, set, or delete.',
      },
      key: {
        type: 'string',
        description: 'Unique memory identifier key (e.g. user_name, persona, response_style). Required for get, set, delete.',
      },
      directive: {
        type: 'string',
        description: 'Instruction text for the core memory. Required for set action.',
      },
      priority: {
        type: 'integer',
        description: 'Priority weight (higher priority appears earlier in prompt). Defaults to 0.',
      },
      namespace: {
        type: 'string',
        description: 'Memory namespace. Defaults to "global".',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => render(value),
    },
    execute({ action, key, directive, priority, namespace }) {
      const ns = namespace || manager.defaultNamespace || 'global';

      switch (action) {
        case 'list': {
          const all = manager.list(ns);
          const items = all.slice(0, MAX_TOOL_LIST_RESULTS);
          return {
            success: true,
            action: 'list',
            namespace: ns,
            total: all.length,
            count: items.length,
            memories: items,
          };
        }

        case 'get': {
          if (!key || typeof key !== 'string') {
            return {
              success: false,
              action: 'get',
              error: 'key must be a non-empty string for get action',
            };
          }
          const memory = manager.get(key, ns);
          if (!memory) {
            return {
              success: false,
              action: 'get',
              error: `Core memory "${key}" not found in namespace "${ns}"`,
            };
          }
          return {
            success: true,
            action: 'get',
            memory,
          };
        }

        case 'set': {
          if (!key || typeof key !== 'string') {
            return {
              success: false,
              action: 'set',
              error: 'key must be a non-empty string for set action',
            };
          }
          if (directive === undefined || directive === null || typeof directive !== 'string') {
            return {
              success: false,
              action: 'set',
              error: 'directive must be a string for set action',
            };
          }
          const prio = Number.isInteger(priority) ? priority : 0;
          const memory = manager.set({
            key,
            directive,
            priority: prio,
            namespace: ns,
          });
          return {
            success: true,
            action: 'set',
            memory,
          };
        }

        case 'delete': {
          if (!key || typeof key !== 'string') {
            return {
              success: false,
              action: 'delete',
              error: 'key must be a non-empty string for delete action',
            };
          }
          const deleted = manager.delete(key, ns);
          if (!deleted) {
            return {
              success: false,
              action: 'delete',
              error: `Core memory "${key}" not found in namespace "${ns}"`,
            };
          }
          return {
            success: true,
            action: 'delete',
            namespace: ns,
            key,
          };
        }

        default:
          return {
            success: false,
            action,
            error: `Unsupported action: "${action}"`,
          };
      }
    },
  });
}
