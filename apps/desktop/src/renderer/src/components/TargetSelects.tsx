import { isSqlEngine } from '@querybara/core';
import { useEffect } from 'react';

import { useConnections } from '../state/connections';
import { useProfiles } from '../state/data';
import { loadChildren, pathKey, useExplorer } from '../state/explorer';
import { metadataCache, useMetadataStatus } from '../state/metadata';
import type { TabTarget } from '../state/runner';
import { Select } from './ui';

const ROOT = pathKey([]);

/**
 * The connection and database a SQL tab or query builder runs on, as two selects at the start
 * of its toolbar. The databases are the explorer's root level, loaded once the connection is
 * open (or when the list is opened). Picking another connection starts on its own database.
 */
export function TargetSelects(props: {
  readonly profileId: string;
  /** The database the tab chose; the connection's own when unset. */
  readonly database: string | undefined;
  readonly disabled?: boolean;
  readonly onChange: (target: TabTarget) => void;
}) {
  const { profileId, onChange } = props;
  const profiles = useProfiles();
  const status = useConnections((state) => state.byProfile[profileId]?.status);
  const root = useExplorer((state) => state.children[profileId]?.[ROOT]);
  // The connection's own database comes with its metadata facts; re-render when they load.
  useMetadataStatus((state) => state.byProfile[profileId]?.loading);

  useEffect(() => {
    if (status === 'ready' && root === undefined) void loadChildren(profileId, []);
  }, [profileId, status, root]);

  const connections = (profiles.data ?? []).filter((p) => isSqlEngine(p.engine));
  const databases = (root?.nodes ?? []).filter((n) => n.kind === 'database').map((n) => n.name);
  const current = props.database ?? metadataCache.facts(profileId)?.database ?? '';
  const options =
    current === '' || databases.includes(current) ? databases : [current, ...databases];

  // Select fills its box: the boxes size the two side by side in the toolbar.
  return (
    <>
      <div className="w-48">
        <Select
          aria-label="Connection"
          data-testid="target-connection"
          value={profileId}
          disabled={props.disabled}
          onChange={(event) => onChange({ profileId: event.target.value, database: undefined })}
        >
          {connections.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
      </div>
      <div className="w-48">
        <Select
          aria-label="Database"
          data-testid="target-database"
          value={current}
          disabled={props.disabled}
          onPointerDown={() => {
            if (root === undefined || (root.error !== undefined && !root.loading)) {
              void loadChildren(profileId, []);
            }
          }}
          onChange={(event) => onChange({ profileId, database: event.target.value || undefined })}
        >
          {current === '' && <option value="" />}
          {options.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </Select>
      </div>
    </>
  );
}
