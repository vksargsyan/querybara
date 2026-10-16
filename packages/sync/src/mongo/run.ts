import { newId, QuerybaraError } from '@querybara/core';
import type { Session } from '@querybara/core';

/** What one sync command did. */
export interface MongoCommandResult {
  /** Documents inserted, matched, upserted or deleted, as the reply counts them. */
  readonly n: number;
}

interface WriteError {
  readonly index?: number;
  readonly code?: number;
  readonly errmsg?: string;
}

function numberField(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (value !== null && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    for (const key of ['$numberInt', '$numberLong', '$numberDouble']) {
      if (typeof v[key] === 'string') return Number(v[key]);
    }
  }
  return undefined;
}

/**
 * Runs one command document of a sync script through a MongoDB session's execute and fails
 * like a SQL statement would: the server answers write commands with `ok: 1` and their
 * failures in `writeErrors` (a duplicate key, a document the validator rejects), which this
 * turns into an error naming the first failed document.
 */
export async function runMongoCommand(
  session: Session,
  text: string,
  signal?: AbortSignal,
): Promise<MongoCommandResult> {
  let reply: Record<string, unknown> = {};
  for await (const chunk of session.execute(text, {
    executionId: newId(),
    ...(signal !== undefined ? { signal } : {}),
  })) {
    if (chunk.type === 'rows' && chunk.rowCount > 0) {
      const cell = chunk.data[0]?.[0];
      if (typeof cell === 'string') reply = JSON.parse(cell) as Record<string, unknown>;
    }
  }
  const errors = Array.isArray(reply['writeErrors']) ? (reply['writeErrors'] as WriteError[]) : [];
  const first = errors[0];
  if (first !== undefined) {
    const index = numberField(first.index);
    const code = numberField(first.code);
    throw new QuerybaraError({
      code: code === 121 ? 'VALIDATION_FAILED' : 'SQL_ERROR',
      message: `${first.errmsg ?? 'Write failed'}${index !== undefined ? ` (document ${index + 1} of the command)` : ''}`,
      ...(code === 11000
        ? { hint: 'A unique index already has a document with this key' }
        : code === 121
          ? { hint: "The document does not satisfy the target collection's validator" }
          : {}),
    });
  }
  const concern = reply['writeConcernError'] as { errmsg?: string } | undefined;
  if (concern !== undefined) {
    throw new QuerybaraError({
      code: 'SQL_ERROR',
      message: `Write concern failed: ${concern.errmsg ?? 'unknown error'}`,
    });
  }
  return { n: numberField(reply['n']) ?? 0 };
}
