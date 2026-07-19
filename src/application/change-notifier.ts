/**
 * Change notification system for broadcasting file system events.
 * Multiple subscribers can listen to create/update/delete operations.
 */

export interface ChangeEvent {
  type: 'created' | 'updated' | 'deleted';
  path: string;
}

/**
 * Notifier for broadcasting change events to multiple subscribers.
 */
export class ChangeNotifier {
  private listeners: Set<(event: ChangeEvent) => void> = new Set();

  /**
   * Subscribe to change events.
   * Returns an unsubscribe function that removes this listener.
   */
  subscribe(listener: (event: ChangeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Notify all subscribed listeners of a change event.
   */
  notify(event: ChangeEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
