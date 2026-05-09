import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import {
  EXECUTOR_SYSTEM_PROMPT,
  PLANNER_SYSTEM_PROMPT,
  ROUTER_SYSTEM_PROMPT,
  STRUCTURIZER_SYSTEM_PROMPT,
  VERIFIER_SYSTEM_PROMPT,
  V1_TASK_TEMPLATE_PROMPT_ASSETS,
} from '@llm-crane/prompts';
import { BUILT_IN_TASK_TEMPLATES, type RuntimeConfig, type TaskRequest, type TaskResponse } from '@llm-crane/schemas';

const CACHE_SCHEMA_VERSION = 'v2';
const DEFAULT_CACHE_TTL_MS = 86_400_000;
const DEFAULT_CACHE_DIRECTORY = path.resolve(process.cwd(), '.llm-crane');
const DEFAULT_CACHE_PATH = path.join(DEFAULT_CACHE_DIRECTORY, 'task-cache.sqlite');

type PersistedTaskResponse = Pick<
  TaskResponse,
  'output' | 'routeDecision' | 'plannerResult' | 'reasonerResult' | 'verifierResult' | 'selectedProvider' | 'providerResult' | 'costEstimate' | 'checkpoint'
>;

export type TaskCacheMetadata = {
  schemaVersion: string;
  promptVersion: string;
  templateVersion: string;
  ttlMs: number;
};

export type CacheInvalidationReason = 'metadata-missing' | 'expired' | 'schema-version' | 'prompt-version' | 'template-version';

export type CacheValidationResult =
  | {
      status: 'valid';
    }
  | {
      status: 'invalid';
      reason: CacheInvalidationReason;
      detail: string;
      metadata?: TaskCacheMetadata;
    };

export type CachedTaskRecord = {
  key: string;
  storedAt: string;
  response: PersistedTaskResponse;
  metadata?: TaskCacheMetadata;
};

export interface TaskCacheStore {
  get(key: string): CachedTaskRecord | undefined;
  set(key: string, response: PersistedTaskResponse, storedAt: string, metadata: TaskCacheMetadata): void;
  delete(key: string): void;
  close(): void;
}

type CacheRow = {
  responseJson: string;
  storedAt: string;
  metadataJson?: string | null;
};

type CacheTableColumnRow = {
  name: string;
};

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));

    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableSerialize(entryValue)}`).join(',')}}`;
  }

  return JSON.stringify(value);
}

function createVersionFingerprint(value: unknown): string {
  return crypto.createHash('sha256').update(stableSerialize(value)).digest('hex');
}

const PROMPT_VERSION = createVersionFingerprint({
  structurizer: STRUCTURIZER_SYSTEM_PROMPT,
  executor: EXECUTOR_SYSTEM_PROMPT,
  router: ROUTER_SYSTEM_PROMPT,
  planner: PLANNER_SYSTEM_PROMPT,
  verifier: VERIFIER_SYSTEM_PROMPT,
  templatePrompts: V1_TASK_TEMPLATE_PROMPT_ASSETS,
});

const TEMPLATE_VERSION = createVersionFingerprint(BUILT_IN_TASK_TEMPLATES);

export function createTaskCacheKey(config: RuntimeConfig, taskRequest: TaskRequest): string {
  const fingerprintPayload = {
    simpleModel: config.defaultSimpleModel,
    complexModel: config.defaultComplexModel,
    request: {
      task: taskRequest.task,
      taskType: taskRequest.taskType,
      qualityBar: taskRequest.qualityBar,
      contexts: taskRequest.contexts,
      constraints: taskRequest.constraints,
      policyOverrides: taskRequest.policyOverrides,
    },
  };

  return crypto.createHash('sha256').update(stableSerialize(fingerprintPayload)).digest('hex');
}

export function resolveTaskCachePath(cachePath = process.env.LLM_CRANE_CACHE_PATH): string {
  return cachePath?.trim() ? cachePath : DEFAULT_CACHE_PATH;
}

function resolveCacheTtlMs(config: RuntimeConfig): number {
  return config.cachePolicy?.ttlMs ?? DEFAULT_CACHE_TTL_MS;
}

export function createTaskCacheMetadata(config: RuntimeConfig): TaskCacheMetadata {
  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    promptVersion: PROMPT_VERSION,
    templateVersion: TEMPLATE_VERSION,
    ttlMs: resolveCacheTtlMs(config),
  };
}

export function validateCachedTaskRecord(
  config: RuntimeConfig,
  cachedRecord: CachedTaskRecord,
  nowIso = new Date().toISOString(),
): CacheValidationResult {
  if (!cachedRecord.metadata) {
    return {
      status: 'invalid',
      reason: 'metadata-missing',
      detail: 'cache metadata missing; treating legacy row as stale',
    };
  }

  const currentMetadata = createTaskCacheMetadata(config);
  if (cachedRecord.metadata.schemaVersion !== currentMetadata.schemaVersion) {
    return {
      status: 'invalid',
      reason: 'schema-version',
      detail: `schema version changed from ${cachedRecord.metadata.schemaVersion} to ${currentMetadata.schemaVersion}`,
      metadata: cachedRecord.metadata,
    };
  }

  if (cachedRecord.metadata.promptVersion !== currentMetadata.promptVersion) {
    return {
      status: 'invalid',
      reason: 'prompt-version',
      detail: 'prompt assets changed since cache entry was stored',
      metadata: cachedRecord.metadata,
    };
  }

  if (cachedRecord.metadata.templateVersion !== currentMetadata.templateVersion) {
    return {
      status: 'invalid',
      reason: 'template-version',
      detail: 'task template definitions changed since cache entry was stored',
      metadata: cachedRecord.metadata,
    };
  }

  const ttlMs = resolveCacheTtlMs(config);
  if (ttlMs > 0) {
    const storedAtMs = Date.parse(cachedRecord.storedAt);
    const nowMs = Date.parse(nowIso);
    if (Number.isFinite(storedAtMs) && Number.isFinite(nowMs) && nowMs - storedAtMs > ttlMs) {
      return {
        status: 'invalid',
        reason: 'expired',
        detail: `ttl expired after ${ttlMs}ms`,
        metadata: cachedRecord.metadata,
      };
    }
  }

  return {
    status: 'valid',
  };
}

export function toPersistedTaskResponse(taskResponse: TaskResponse): PersistedTaskResponse {
  return {
    output: taskResponse.output,
    routeDecision: taskResponse.routeDecision,
    plannerResult: taskResponse.plannerResult,
    reasonerResult: taskResponse.reasonerResult,
    verifierResult: taskResponse.verifierResult,
    selectedProvider: taskResponse.selectedProvider,
    providerResult: taskResponse.providerResult,
    costEstimate: taskResponse.costEstimate,
    checkpoint: taskResponse.checkpoint,
  };
}

function ensureMetadataColumn(database: DatabaseSync): void {
  const columns = database.prepare('PRAGMA table_info(task_cache)').all() as CacheTableColumnRow[];
  if (columns.some((column) => column.name === 'metadata_json')) {
    return;
  }

  database.exec('ALTER TABLE task_cache ADD COLUMN metadata_json TEXT');
}

export class SQLiteTaskCache implements TaskCacheStore {
  private readonly database: DatabaseSync;
  private readonly selectStatement: StatementSync;
  private readonly upsertStatement: StatementSync;
  private readonly deleteStatement: StatementSync;

  constructor(private readonly cachePath: string) {
    if (cachePath !== ':memory:') {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    }

    this.database = new DatabaseSync(cachePath);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS task_cache (
        cache_key TEXT PRIMARY KEY,
        response_json TEXT NOT NULL,
        stored_at TEXT NOT NULL,
        metadata_json TEXT
      )
    `);
    ensureMetadataColumn(this.database);

    this.selectStatement = this.database.prepare(`
      SELECT response_json AS responseJson, stored_at AS storedAt, metadata_json AS metadataJson
      FROM task_cache
      WHERE cache_key = ?
    `);

    this.upsertStatement = this.database.prepare(`
      INSERT INTO task_cache (cache_key, response_json, stored_at, metadata_json)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET
        response_json = excluded.response_json,
        stored_at = excluded.stored_at,
        metadata_json = excluded.metadata_json
    `);

    this.deleteStatement = this.database.prepare('DELETE FROM task_cache WHERE cache_key = ?');
  }

  get(key: string): CachedTaskRecord | undefined {
    const row = this.selectStatement.get(key) as CacheRow | undefined;
    if (!row) {
      return undefined;
    }

    try {
      return {
        key,
        storedAt: row.storedAt,
        response: JSON.parse(row.responseJson) as PersistedTaskResponse,
        metadata: row.metadataJson ? (JSON.parse(row.metadataJson) as TaskCacheMetadata) : undefined,
      };
    } catch {
      this.deleteStatement.run(key);
      return undefined;
    }
  }

  set(key: string, response: PersistedTaskResponse, storedAt: string, metadata: TaskCacheMetadata): void {
    this.upsertStatement.run(key, JSON.stringify(response), storedAt, JSON.stringify(metadata));
  }

  delete(key: string): void {
    this.deleteStatement.run(key);
  }

  close(): void {
    this.database.close();
  }
}