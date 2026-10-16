import { createWriteStream, type WriteStream } from 'node:fs';

import type { JobSummary } from '@querybara/ipc';

/** What the SQL and MongoDB data sync tasks share for their spools and summaries. */

/** Appends lines to a file, waiting for the stream to drain. */
export class LineWriter {
  readonly #stream: WriteStream;

  constructor(path: string) {
    this.#stream = createWriteStream(path);
  }

  async write(line: string): Promise<void> {
    if (!this.#stream.write(`${line}\n`)) {
      await new Promise<void>((resolve) => this.#stream.once('drain', resolve));
    }
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#stream.once('error', reject);
      this.#stream.end(() => resolve());
    });
  }

  destroy(): void {
    this.#stream.destroy();
  }
}

export function dataSummary(
  status: JobSummary['status'],
  durationMs: number,
  outcome: string,
  extra: Partial<JobSummary> = {},
): JobSummary {
  return {
    status,
    rowsRead: 0,
    rowsWritten: 0,
    rowsSkipped: 0,
    durationMs: Math.round(durationMs),
    outcome: outcome.length > 500 ? `${outcome.slice(0, 499)}…` : outcome,
    ...extra,
  };
}
