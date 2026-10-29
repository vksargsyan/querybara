import { create } from 'zustand';

/**
 * What the Objects view lists (state/objects-view.ts): the node last picked in the explorer.
 * Kept apart from the view so what only reads the pick (the connection in front) does not load
 * the dock.
 */

export interface ObjectsLocation {
  readonly profileId: string;
  /** The explorer path whose children the view lists. */
  readonly path: readonly string[];
  /** Display names along the path, for the breadcrumb. */
  readonly trail: readonly string[];
  /** The tree node that was clicked (a schema lists its tables folder), marked in the tree. */
  readonly source: readonly string[];
}

interface ObjectsViewState {
  readonly location?: ObjectsLocation;
}

export const useObjectsView = create<ObjectsViewState>()(() => ({}));
