import { describe, it, expect } from 'vitest';
import { ChangeNotifier, type ChangeEvent } from './change-notifier';

describe('change-notifier', () => {
  describe('ChangeNotifier', () => {
    it('should deliver notifications to subscribers', () => {
      const notifier = new ChangeNotifier();
      const events: ChangeEvent[] = [];
      const listener = (event: ChangeEvent) => events.push(event);

      notifier.subscribe(listener);
      const event: ChangeEvent = { type: 'created', path: 'test.md' };
      notifier.notify(event);

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual(event);
    });

    it('should deliver to multiple subscribers', () => {
      const notifier = new ChangeNotifier();
      const events1: ChangeEvent[] = [];
      const events2: ChangeEvent[] = [];
      const listener1 = (event: ChangeEvent) => events1.push(event);
      const listener2 = (event: ChangeEvent) => events2.push(event);

      notifier.subscribe(listener1);
      notifier.subscribe(listener2);

      const event: ChangeEvent = { type: 'updated', path: 'test.md' };
      notifier.notify(event);

      expect(events1).toHaveLength(1);
      expect(events2).toHaveLength(1);
      expect(events1[0]).toEqual(event);
      expect(events2[0]).toEqual(event);
    });

    it('should support unsubscribe', () => {
      const notifier = new ChangeNotifier();
      const events: ChangeEvent[] = [];
      const listener = (event: ChangeEvent) => events.push(event);

      const unsubscribe = notifier.subscribe(listener);
      notifier.notify({ type: 'created', path: 'test1.md' });
      expect(events).toHaveLength(1);

      unsubscribe();
      notifier.notify({ type: 'updated', path: 'test2.md' });
      expect(events).toHaveLength(1); // Still only 1, unsubscribe worked
    });

    it('should allow other subscribers to continue after one unsubscribes', () => {
      const notifier = new ChangeNotifier();
      const events1: ChangeEvent[] = [];
      const events2: ChangeEvent[] = [];
      const listener1 = (event: ChangeEvent) => events1.push(event);
      const listener2 = (event: ChangeEvent) => events2.push(event);

      const unsub1 = notifier.subscribe(listener1);
      notifier.subscribe(listener2);

      notifier.notify({ type: 'created', path: 'test1.md' });
      expect(events1).toHaveLength(1);
      expect(events2).toHaveLength(1);

      unsub1();
      notifier.notify({ type: 'updated', path: 'test2.md' });
      expect(events1).toHaveLength(1); // listener1 did not receive the second event
      expect(events2).toHaveLength(2); // listener2 still receives it
    });

    it('should handle notify with zero subscribers', () => {
      const notifier = new ChangeNotifier();
      // Should not throw
      notifier.notify({ type: 'created', path: 'test.md' });
    });

    it('should support all event types', () => {
      const notifier = new ChangeNotifier();
      const events: ChangeEvent[] = [];
      notifier.subscribe((event) => events.push(event));

      notifier.notify({ type: 'created', path: 'created.md' });
      notifier.notify({ type: 'updated', path: 'updated.md' });
      notifier.notify({ type: 'deleted', path: 'deleted.md' });

      expect(events).toHaveLength(3);
      expect(events[0].type).toBe('created');
      expect(events[1].type).toBe('updated');
      expect(events[2].type).toBe('deleted');
    });
  });
});
