import { collectionReference, formatFindText } from '../find-text';
import { formatShell, quoteShellString } from '../shell/format';
import { URI_EXAMPLE, URI_VARIABLE, type ExportTarget } from './common';

/**
 * A mongosh script (Studio 3T's mongo shell Query Code): the find() or aggregate() as the shell
 * writes it, with the query bar's parts chained, on the query's database, printing each
 * document. The shell takes the connection string on its command line.
 */
export function mongoshProgram(target: ExportTarget, database: string): string {
  const query =
    target.kind === 'find'
      ? formatFindText(target.collection, target.query, { multiline: true, forMongosh: true })
      : `${collectionReference(target.collection)}.aggregate(${formatShell([...target.pipeline], { forMongosh: true })})`;
  return `// npm install -g mongosh
// Set ${URI_VARIABLE} to your connection string, e.g. ${URI_EXAMPLE}, then run:
// mongosh "$${URI_VARIABLE}" --file query.mongosh.js
db = db.getSiblingDB(${quoteShellString(database)});
${query}
  .forEach((document) => printjson(document));
`;
}
