import type { SchemaAnalysis } from '@querybara/mongo-tools';
import { describe, expect, it } from 'vitest';

import {
  buildExportJob,
  buildImportJob,
  collectionFromFile,
  csvFields,
  exportFileName,
  exportIssue,
  exportSettings,
  fileFormat,
  importIssue,
  importQuestion,
  importSettings,
  withFile,
  type MongoExportTarget,
  type MongoImportTarget,
} from '../src/renderer/src/state/mongo/file-transfer';

/** The Export and Import dialogs' jobs (ADR 0037), built from what they show. */

const EXPORT: MongoExportTarget = {
  profileId: 'p',
  profileName: 'Shop',
  db: 'shop',
  collections: ['orders'],
  query: {
    collection: 'orders',
    query: { filter: '{"status":"open"}' },
    text: 'db.orders.find(…)',
  },
};

const IMPORT: MongoImportTarget = {
  profileId: 'p',
  profileName: 'Shop',
  db: 'shop',
  readOnly: false,
  production: false,
  confirmWrites: false,
};

describe('export jobs', () => {
  it("exports the tab's query to one file, or collections to a folder", () => {
    const settings = { ...exportSettings(EXPORT), path: '/out/orders.json' };
    expect(settings.useQuery).toBe(true);
    expect(buildExportJob(EXPORT, settings)).toEqual({
      kind: 'mongo-export',
      profileId: 'p',
      database: 'shop',
      collections: ['orders'],
      query: { filter: '{"status":"open"}' },
      format: 'json',
      ejson: 'relaxed',
      output: { kind: 'file', path: '/out/orders.json' },
    });
    const many = {
      ...exportSettings({ ...EXPORT, query: undefined } as MongoExportTarget),
      collections: ['orders', 'people'],
      format: 'csv' as const,
      fields: ['_id', 'name'],
      delimiter: ';',
      gzip: true,
      path: '/out',
    };
    expect(buildExportJob({ ...EXPORT, query: undefined } as MongoExportTarget, many)).toEqual({
      kind: 'mongo-export',
      profileId: 'p',
      database: 'shop',
      collections: ['orders', 'people'],
      format: 'csv',
      fields: ['_id', 'name'],
      csv: { delimiter: ';', header: true },
      gzip: true,
      output: { kind: 'directory', path: '/out' },
    });
  });

  it('says what is missing and names files after the collection', () => {
    const settings = exportSettings(EXPORT);
    expect(exportIssue({ ...settings, collections: [] })).toBe('Choose the collections to export');
    expect(exportIssue(settings)).toBe('Choose a file');
    expect(exportIssue({ ...settings, collections: ['a', 'b'] })).toBe('Choose a folder');
    expect(exportFileName('orders', 'jsonl', false)).toBe('orders.jsonl');
    expect(exportFileName('a/b:c', 'csv', true)).toBe('a_b_c.csv.gz');
  });
});

describe('import jobs', () => {
  it('reads the format and the collection from the file name', () => {
    expect(fileFormat('/in/orders.ndjson.gz')).toBe('jsonl');
    expect(fileFormat('/in/dump/orders.bson')).toBe('bson');
    expect(fileFormat('/in/notes.txt')).toBeUndefined();
    expect(collectionFromFile('C:\\in\\orders.csv.gz')).toBe('orders');
    const picked = withFile(IMPORT, importSettings(IMPORT), '/in/people.tsv');
    expect(picked).toMatchObject({ format: 'csv', delimiter: '\t', collection: 'people' });
    // A collection chosen in the tree stays.
    const into = { ...IMPORT, collection: 'orders' };
    expect(withFile(into, importSettings(into), '/in/people.json').collection).toBe('orders');
  });

  it('builds the job, with the CSV settings only for CSV', () => {
    const settings = withFile(IMPORT, importSettings(IMPORT), '/in/orders.csv');
    expect(buildImportJob(IMPORT, { ...settings, mode: 'upsert' }, false)).toEqual({
      kind: 'mongo-import',
      profileId: 'p',
      database: 'shop',
      collection: 'orders',
      file: {
        path: '/in/orders.csv',
        format: 'csv',
        csv: { delimiter: ',', header: true, types: 'infer', empty: 'omit' },
      },
      mode: 'upsert',
      onError: 'stop',
    });
    const json = withFile(IMPORT, importSettings(IMPORT), '/in/orders.json');
    expect(buildImportJob(IMPORT, json, true)).toMatchObject({
      file: { path: '/in/orders.json', format: 'json' },
      confirmed: true,
    });
    expect(buildImportJob(IMPORT, json, true).file.csv).toBeUndefined();
  });

  it('refuses read-only connections and bad names, and asks before replacing or on production', () => {
    const settings = withFile(IMPORT, importSettings(IMPORT), '/in/orders.json');
    expect(importIssue({ ...IMPORT, readOnly: true }, settings)).toBe(
      'This connection is read-only',
    );
    expect(importIssue(IMPORT, importSettings(IMPORT))).toBe('Choose a file');
    expect(importIssue(IMPORT, { ...settings, collection: ' ' })).toBe('Name the collection');
    expect(importIssue(IMPORT, { ...settings, collection: 'a$b' })).toMatch(/\$/);
    expect(importIssue(IMPORT, settings)).toBeUndefined();
    expect(importQuestion(IMPORT, settings)).toBeUndefined();
    expect(importQuestion(IMPORT, { ...settings, mode: 'replace' })).toMatchObject({
      title: 'Replace the documents of shop.orders?',
      danger: true,
    });
    expect(
      importQuestion({ ...IMPORT, production: true, confirmWrites: true }, settings),
    ).toMatchObject({ title: 'Import into a production connection?', danger: true });
  });
});

describe('csvFields', () => {
  it('takes the leaf fields a schema analysis found, arrays as one column, _id first', () => {
    const field = (path: string, queryPath = path) => ({ path, queryPath }) as never;
    const analysis = {
      documentCount: 10,
      truncated: false,
      fields: [
        field('name'),
        field('_id'),
        field('address'),
        field('address.city'),
        field('tags'),
        field('tags[]', 'tags'),
        field('items[].sku', 'items.sku'),
      ],
    } as unknown as SchemaAnalysis;
    expect(csvFields(analysis)).toEqual(['_id', 'name', 'address.city', 'tags']);
  });
});
