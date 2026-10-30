import { Toast } from 'radix-ui';

import { dismissToast, useToasts } from '../state/toasts';
import { Icon } from './ui';

/** How long a toast stays up, not counting while the pointer or the focus is on it. */
const DURATION_MS = 8000;

/**
 * The toasts of state/toasts.ts, newest at the bottom. Escape closes them, F8 moves the focus to
 * them, and a swipe to the right puts one away.
 */
export function Toasts() {
  const toasts = useToasts((state) => state.toasts);
  return (
    <Toast.Provider duration={DURATION_MS} swipeDirection="right">
      {toasts.map((toast) => (
        <Toast.Root
          key={toast.id}
          onOpenChange={(open) => {
            if (!open) dismissToast(toast.id);
          }}
          data-testid="toast"
          className="flex w-[360px] max-w-[calc(100vw-2rem)] items-start gap-2 rounded-md border border-danger/60 bg-raised px-3 py-2.5 text-[13px] shadow-widget data-[swipe=cancel]:translate-x-0 data-[swipe=cancel]:transition-transform data-[swipe=end]:translate-x-(--radix-toast-swipe-end-x) data-[swipe=move]:translate-x-(--radix-toast-swipe-move-x)"
        >
          <Icon name="warning" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger" />
          <div className="min-w-0 flex-1">
            {toast.title !== undefined && (
              <Toast.Title className="truncate font-medium text-fg">{toast.title}</Toast.Title>
            )}
            <Toast.Description className="text-xs break-words text-muted select-text">
              {toast.message}
            </Toast.Description>
          </div>
          <Toast.Close
            aria-label="Dismiss the error"
            title="Dismiss"
            onClick={toast.onClose}
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-muted hover:bg-hover hover:text-fg"
          >
            <Icon name="close" className="h-3 w-3" />
          </Toast.Close>
        </Toast.Root>
      ))}
      <Toast.Viewport className="flex max-h-[calc(100vh-2rem)] flex-col items-end gap-2 outline-none" />
    </Toast.Provider>
  );
}
