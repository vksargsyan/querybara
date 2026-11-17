import {
  GridFSBucket,
  MongoClient,
  type Db,
  type GridFSBucketOptions,
  type MongoClientOptions,
  type TopologyDescriptionChangedEvent,
} from 'mongodb';
import { GridFSBucket as LegacyGridFSBucket, MongoClient as LegacyMongoClient } from 'mongodb6';

import { isServerTooOld } from './errors';

/**
 * The two releases of the official driver Querybara ships: mongodb 7 for MongoDB 4.4 and later,
 * and mongodb 6 for MongoDB 4.2, which 7 no longer speaks. A connection starts with the current
 * driver and moves to the legacy one only when the server is too old for it (connectMongoClient).
 *
 * Both run on the same bson 7 (a pnpm override in pnpm-workspace.yaml), so documents, ObjectIds
 * and the other values pass between them and the rest of the repo unchanged. The legacy client
 * is typed as the current one: the calls Querybara makes have the same shape in both.
 */
export type DriverRelease = 'current' | 'legacy';

/** A client of the given driver release. */
export function createMongoClient(
  url: string,
  options: MongoClientOptions,
  release: DriverRelease = 'current',
): MongoClient {
  if (release === 'current') return new MongoClient(url, options);
  return new LegacyMongoClient(
    url,
    options as ConstructorParameters<typeof LegacyMongoClient>[1],
  ) as unknown as MongoClient;
}

/** Which driver release made `client`. */
export function releaseOf(client: MongoClient): DriverRelease {
  return (client as unknown) instanceof LegacyMongoClient ? 'legacy' : 'current';
}

/**
 * A connected client through the current driver, or through the legacy one when the current
 * driver refuses the server as too old (that refusal comes at the handshake, before any login).
 * Failures come back unmapped.
 */
export async function connectMongoDriver(
  url: string,
  options: MongoClientOptions,
): Promise<MongoClient> {
  try {
    return await connectClient(url, options, 'current');
  } catch (error) {
    if (!isServerTooOld(error)) throw error;
    return connectClient(url, options, 'legacy');
  }
}

/**
 * Connects a client of one driver release. A server whose wire versions the driver does not
 * speak fails every handshake the same way: once every known server has, this stops rather
 * than wait out server selection, and throws that refusal instead of a selection timeout.
 */
async function connectClient(
  url: string,
  options: MongoClientOptions,
  release: DriverRelease,
): Promise<MongoClient> {
  const client = createMongoClient(url, options, release);
  let incompatible: unknown;
  const onTopology = (event: TopologyDescriptionChangedEvent): void => {
    const servers = [...event.newDescription.servers.values()];
    if (
      incompatible === undefined &&
      servers.length > 0 &&
      servers.every((server) => server.error?.name === 'MongoCompatibilityError')
    ) {
      incompatible = servers[0]!.error;
      void client.close().catch(() => undefined);
    }
  };
  client.on('topologyDescriptionChanged', onTopology);
  try {
    await client.connect();
    return client;
  } catch (error) {
    await client.close().catch(() => undefined);
    throw incompatible ?? error;
  } finally {
    client.off('topologyDescriptionChanged', onTopology);
  }
}

/** A GridFS bucket from the driver release that made `db`'s client. */
export function gridFSBucketOf(db: Db, options: GridFSBucketOptions): GridFSBucket {
  if (releaseOf(db.client) === 'current') return new GridFSBucket(db, options);
  return new LegacyGridFSBucket(
    db as unknown as ConstructorParameters<typeof LegacyGridFSBucket>[0],
    options,
  ) as unknown as GridFSBucket;
}
