import { create } from 'zustand';

/**
 * Toasts in the corner of the window (components/Toasts.tsx shows them): the side bar's errors,
 * which would otherwise be written into the tree. A toast puts itself away after a while (not
 * while the pointer or the focus is on it); the same message again replaces the one showing,
 * restarting its time, rather than stacking a copy.
 */

export interface Toast {
  /** New each time the message is shown, so a repeat starts its time over. */
  readonly id: number;
  /** What the message is about: a connection's name. */
  readonly title?: string;
  readonly message: string;
  /** Called when the user closes the toast, not when it times out. */
  readonly onClose?: () => void;
}

interface ToastsState {
  readonly toasts: readonly Toast[];
}

/** More than this and the oldest go. */
const MAX_TOASTS = 4;

export const useToasts = create<ToastsState>()(() => ({ toasts: [] }));

let nextId = 1;

export function toastError(
  message: string,
  options: { readonly title?: string; readonly onClose?: () => void } = {},
): void {
  const toast: Toast = { id: nextId++, message, ...options };
  useToasts.setState((state) => ({
    toasts: [
      ...state.toasts.filter((t) => t.message !== message || t.title !== options.title),
      toast,
    ].slice(-MAX_TOASTS),
  }));
}

export function dismissToast(id: number): void {
  useToasts.setState((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
}
