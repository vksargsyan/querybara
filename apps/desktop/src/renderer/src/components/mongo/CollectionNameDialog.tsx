import {
  closeCollectionAction,
  copyName,
  submitCollectionName,
  useCollectionActions,
} from '../../state/mongo/collection-actions';
import { NameDialog } from './parts';

/**
 * The name dialogs of the tree's Rename Collection… and Duplicate Collection… (ADR 0036), one
 * per connection tree like its create dialogs. The dialog steps aside while its command is
 * confirmed and run; an error from the server brings it back with the name and the message.
 */
export function CollectionNameDialog(props: { readonly profileId: string }) {
  const action = useCollectionActions((s) => s.action);
  if (!action || action.profileId !== props.profileId) return null;
  const rename = action.kind === 'rename';
  return (
    <>
      <NameDialog
        open={!action.busy}
        title={
          rename
            ? `Rename ${action.db}.${action.collection}`
            : `Duplicate ${action.db}.${action.collection}`
        }
        label={rename ? 'New name' : 'Name of the copy'}
        initial={action.name ?? (rename ? action.collection : copyName(action.collection))}
        confirmLabel={rename ? 'Rename' : 'Duplicate'}
        onSubmit={(name) => void submitCollectionName(name)}
        onClose={closeCollectionAction}
      />
      {action.error !== undefined && (
        <p
          role="alert"
          data-testid="collection-action-error"
          className="fixed bottom-6 left-1/2 z-[60] -translate-x-1/2 rounded border border-danger/40 bg-raised px-3 py-1.5 text-xs text-danger shadow-widget"
        >
          {action.error}
        </p>
      )}
    </>
  );
}
