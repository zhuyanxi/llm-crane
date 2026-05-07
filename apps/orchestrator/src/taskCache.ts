import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { RuntimeConfig, TaskRequest, TaskResponse } from '@llm-crane/schemas';

const CACHE_VERSION = 'v1';
const DEFAULT_CACHE_DIRECTORY = path.resolve(process.cwd(), '.llm-crane');
const DEFAULT_CACHE_PATH = path.join(DEFAULT_CACHE_DIRECTORY, 'task-cache.sqlite');

type PersistedTaskResponse = Pick<
  TaskResponse,
  'output' | 'routeDecision' | 'plannerResult' | 'reasonerResult' | 'selectedProvider' | 'providerResult' | 'costEstimate' | 'checkpoint'
>;

export type CachedTaskRecord = {
  key: string;
  storedAt: string;
  response: PersistedTaskResponse;
};

export interface TaskCacheStore {
  get(key: string): CachedTaskRecord | undefined;
  set(key: string, response: PersistedTaskResponse, storedAt: string): void;
  close(): void;
}

type CacheRow = {
  responseJson: string;
  storedAt: string;
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

export function createTaskCacheKey(config: RuntimeConfig, taskRequest: TaskRequest): string {
  const fingerprintPayload = {
    version: CACHE_VERSION,
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

export function toPersistedTaskResponse(taskResponse: TaskResponse): PersistedTaskResponse {
  return {
    output: taskResponse.output,
    routeDecision: taskResponse.routeDecision,
    plannerResult: taskResponse.plannerResult,
    reasonerResult: taskResponse.reasonerResult,
    selectedProvider: taskResponse.selectedProvider,
    providerResult: taskResponse.providerResult,
    costEstimate: taskResponse.costEstimate,
    checkpoint: taskResponse.checkpoint,
  };
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
        stored_at TEXT NOT NULL
      )
    `);

    this.selectStatement = this.database.prepare(`
      SELECT response_json AS responseJson, stored_at AS storedAt
      FROM task_cache
      WHERE cache_key = ?
    `);

    this.upsertStatement = this.database.prepare(`
      INSERT INTO task_cache (cache_key, response_json, stored_at)
      VALUES (?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET
        response_json = excluded.response_json,
        stored_at = excluded.stored_at
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
      };
    } catch {
      this.deleteStatement.run(key);
      return undefined;
    }
  }

  set(key: string, response: PersistedTaskResponse, storedAt: string): void {
    this.upsertStatement.run(key, JSON.stringify(response), storedAt);
  }

  close(): void {
    this.database.close();
  }
}