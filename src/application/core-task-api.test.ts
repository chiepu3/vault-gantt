import { describe, it, expect } from 'vitest';
import { CoreTaskAPI, type CreateTaskInput } from './core-task-api';
import { FakeVaultAdapter } from './fake-vault-adapter';
import { UndoStack } from './undo-stack';
import { ChangeNotifier } from './change-notifier';

describe('core-task-api', () => {
  const fakeNow = () => '2026-07-19';

  function createApi() {
    return new CoreTaskAPI(new FakeVaultAdapter(), {
      undoStack: new UndoStack(),
      notifier: new ChangeNotifier(),
      now: fakeNow,
    });
  }

  describe('createTask', () => {
    it('should create a task with defaults', async () => {
      const api = createApi();
      const input: CreateTaskInput = { displayName: 'Test Task' };
      const result = await api.createTask(input);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const { value } = result;
        expect(value.note.displayName).toBe('Test Task');
        expect(value.note.statusLabel).toBe('active');
        expect(value.note.createdAt).toBe('2026-07-19');
        expect(value.note.updatedAt).toBe('2026-07-19');
        expect(value.note.priority).toBe(0);
        expect(value.note.priorityMode).toBe('auto');
        expect(value.note.completed).toBe(false);
        expect(value.note.tags).toEqual([]);
        expect(value.note.subtasks).toEqual([]);
      }
    });

    it('should create task with custom dueDate and tags', async () => {
      const api = createApi();
      const input: CreateTaskInput = {
        displayName: 'Urgent Task',
        dueDate: '2026-07-21',
        tags: ['urgent', 'work'],
      };
      const result = await api.createTask(input);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.note.dueDate).toBe('2026-07-21');
        expect(result.value.note.tags).toEqual(['urgent', 'work']);
      }
    });

    it('should be readable via getTask immediately after creation', async () => {
      const api = createApi();
      const input: CreateTaskInput = { displayName: 'New Task' };
      const createResult = await api.createTask(input);

      expect(createResult.ok).toBe(true);
      if (createResult.ok) {
        const getResult = await api.getTask(createResult.value.path);
        expect(getResult).not.toBeNull();
        if (getResult) {
          expect(getResult.note.displayName).toBe('New Task');
        }
      }
    });

    it('should reject creation with an invalid dueDate', async () => {
      const api = createApi();
      const result = await api.createTask({
        displayName: 'Task',
        dueDate: 'not-a-date' as unknown as string,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('VALIDATION_ERROR');
      }
    });

    it('should surface a thrown vault adapter error as a VALIDATION_ERROR instead of rejecting', async () => {
      // The real ObsidianVaultAdapter's createTaskFile can throw (e.g. vault.create
      // rejects if the generated path already exists) since VaultAdapterPort's
      // createTaskFile has no Result-shaped failure case, unlike writeTaskFile.
      const adapter = new FakeVaultAdapter();
      adapter.createTaskFile = async () => {
        throw new Error('path already exists');
      };
      const api = new CoreTaskAPI(adapter, { now: fakeNow });

      const result = await api.createTask({ displayName: 'Task' });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('VALIDATION_ERROR');
        if (result.error.code === 'VALIDATION_ERROR') {
          expect(result.error.errors.some((e) => e.includes('path already exists'))).toBe(true);
        }
      }
    });
  });

  describe('updateTaskItem', () => {
    it('should update a single field', async () => {
      const api = createApi();
      const createResult = await api.createTask({ displayName: 'Original' });

      expect(createResult.ok).toBe(true);
      if (createResult.ok) {
        const path = createResult.value.path;
        const revision = createResult.value.revision;

        const updateResult = await api.updateTaskItem({
          path,
          expectedRevision: revision,
          parent: { displayName: 'Updated' },
        });

        expect(updateResult.ok).toBe(true);
        if (updateResult.ok) {
          expect(updateResult.value.note.displayName).toBe('Updated');
        }
      }
    });

    it('should reject update with unknown field', async () => {
      const api = createApi();
      const createResult = await api.createTask({ displayName: 'Task' });

      expect(createResult.ok).toBe(true);
      if (createResult.ok) {
        const path = createResult.value.path;
        const revision = createResult.value.revision;

        const updateResult = await api.updateTaskItem({
          path,
          expectedRevision: revision,
          parent: { unknownField: 'value' },
        });

        expect(updateResult.ok).toBe(false);
        if (!updateResult.ok) {
          expect(updateResult.error.code).toBe('VALIDATION_ERROR');
          if (updateResult.error.code === 'VALIDATION_ERROR') {
            expect(updateResult.error.errors.some((e) => e.includes('Unknown field'))).toBe(true);
          }
        }
      }
    });

    it('should reject update with stale expectedRevision', async () => {
      const api = createApi();
      const createResult = await api.createTask({ displayName: 'Task' });

      expect(createResult.ok).toBe(true);
      if (createResult.ok) {
        const path = createResult.value.path;

        const updateResult = await api.updateTaskItem({
          path,
          expectedRevision: 'old-revision',
          parent: { displayName: 'Updated' },
        });

        expect(updateResult.ok).toBe(false);
        if (!updateResult.ok) {
          expect(updateResult.error.code).toBe('REVISION_CONFLICT');
        }
      }
    });
  });

  describe('updateTaskItemsBatch', () => {
    it('should batch update two different files', async () => {
      const api = createApi();
      const create1 = await api.createTask({ displayName: 'Task 1' });
      const create2 = await api.createTask({ displayName: 'Task 2' });

      expect(create1.ok).toBe(true);
      expect(create2.ok).toBe(true);

      if (create1.ok && create2.ok) {
        const batchResult = await api.updateTaskItemsBatch([
          {
            path: create1.value.path,
            expectedRevision: create1.value.revision,
            parent: { displayName: 'Task 1 Updated' },
          },
          {
            path: create2.value.path,
            expectedRevision: create2.value.revision,
            parent: { displayName: 'Task 2 Updated' },
          },
        ]);

        expect(batchResult.ok).toBe(true);
        if (batchResult.ok) {
          expect(batchResult.value).toHaveLength(2);
          expect(batchResult.value.some((r) => r.note.displayName === 'Task 1 Updated')).toBe(
            true
          );
          expect(batchResult.value.some((r) => r.note.displayName === 'Task 2 Updated')).toBe(
            true
          );
        }
      }
    });

    it('should reject batch when same path has conflicting expectedRevisions', async () => {
      const api = createApi();
      const createResult = await api.createTask({ displayName: 'Task' });

      expect(createResult.ok).toBe(true);
      if (createResult.ok) {
        const path = createResult.value.path;

        const batchResult = await api.updateTaskItemsBatch([
          {
            path,
            expectedRevision: 'rev1',
            parent: { priority: 1 },
          },
          {
            path,
            expectedRevision: 'rev2',
            parent: { priority: 2 },
          },
        ]);

        expect(batchResult.ok).toBe(false);
        if (!batchResult.ok) {
          expect(batchResult.error.code).toBe('VALIDATION_ERROR');
          if (batchResult.error.code === 'VALIDATION_ERROR') {
            expect(
              batchResult.error.errors.some((e) =>
                e.includes('must share the same expectedRevision')
              )
            ).toBe(true);
          }
        }
      }
    });

    it('should not write anything if validation fails on any path', async () => {
      const api = createApi();
      const create1 = await api.createTask({ displayName: 'Task 1' });
      const create2 = await api.createTask({ displayName: 'Task 2' });

      expect(create1.ok).toBe(true);
      expect(create2.ok).toBe(true);

      if (create1.ok && create2.ok) {
        const batchResult = await api.updateTaskItemsBatch([
          {
            path: create1.value.path,
            expectedRevision: create1.value.revision,
            parent: { displayName: 'Task 1 Updated' },
          },
          {
            path: create2.value.path,
            expectedRevision: create2.value.revision,
            parent: { unknownField: 'should fail' }, // Invalid field
          },
        ]);

        expect(batchResult.ok).toBe(false);

        // Verify neither task was modified
        const get1 = await api.getTask(create1.value.path);
        const get2 = await api.getTask(create2.value.path);

        if (get1 && get2) {
          expect(get1.note.displayName).toBe('Task 1'); // Not updated
          expect(get2.note.displayName).toBe('Task 2'); // Not updated
        }
      }
    });

    it('should bank undo/notifications for paths that succeeded before a later write conflict', async () => {
      const adapter = new FakeVaultAdapter();
      const api = new CoreTaskAPI(adapter, { now: fakeNow });
      const create1 = await api.createTask({ displayName: 'Task 1' });
      const create2 = await api.createTask({ displayName: 'Task 2' });

      expect(create1.ok).toBe(true);
      expect(create2.ok).toBe(true);
      if (!create1.ok || !create2.ok) return;

      const events: { type: string; path: string }[] = [];
      api.subscribe((e) => events.push(e));

      // Simulate an external writer racing in strictly between path1's write and
      // path2's write within the same batch call (both paths pass pre-validation
      // cleanly; only the write itself for path2 should fail). Hooking writeTaskFile
      // lets us inject the interference at exactly that point in the write loop,
      // rather than before validation even starts.
      const originalWrite = adapter.writeTaskFile.bind(adapter);
      let path1Written = false;
      adapter.writeTaskFile = async (path, frontmatter, body, expectedRevision) => {
        if (path === create1.value.path) {
          path1Written = true;
        } else if (path === create2.value.path && path1Written) {
          adapter._simulateExternalWrite(create2.value.path, { displayName: 'Task 2' }, 'body');
        }
        return originalWrite(path, frontmatter, body, expectedRevision);
      };

      const batchResult = await api.updateTaskItemsBatch([
        {
          path: create1.value.path,
          expectedRevision: create1.value.revision,
          parent: { displayName: 'Task 1 Updated' },
        },
        {
          path: create2.value.path,
          expectedRevision: create2.value.revision, // now stale
          parent: { displayName: 'Task 2 Updated' },
        },
      ]);

      expect(batchResult.ok).toBe(false);
      if (!batchResult.ok) {
        expect(batchResult.error.code).toBe('REVISION_CONFLICT');
      }

      // path1's write landed on disk and fired a notification even though the call
      // overall reports failure.
      const get1 = await api.getTask(create1.value.path);
      expect(get1?.note.displayName).toBe('Task 1 Updated');
      expect(events.some((e) => e.type === 'updated' && e.path === create1.value.path)).toBe(true);

      // And it's undoable.
      const undoResult = await api.undo();
      expect(undoResult.ok).toBe(true);
      const get1AfterUndo = await api.getTask(create1.value.path);
      expect(get1AfterUndo?.note.displayName).toBe('Task 1');
    });
  });

  describe('deleteTask', () => {
    it('should delete a task', async () => {
      const api = createApi();
      const createResult = await api.createTask({ displayName: 'Task to Delete' });

      expect(createResult.ok).toBe(true);
      if (createResult.ok) {
        const path = createResult.value.path;
        const revision = createResult.value.revision;

        const deleteResult = await api.deleteTask(path, revision);
        expect(deleteResult.ok).toBe(true);

        const getResult = await api.getTask(path);
        expect(getResult).toBeNull();
      }
    });

    it('should reject delete with stale revision', async () => {
      const api = createApi();
      const createResult = await api.createTask({ displayName: 'Task' });

      expect(createResult.ok).toBe(true);
      if (createResult.ok) {
        const path = createResult.value.path;

        const deleteResult = await api.deleteTask(path, 'old-revision');
        expect(deleteResult.ok).toBe(false);
        if (!deleteResult.ok) {
          expect(deleteResult.error.code).toBe('REVISION_CONFLICT');
        }
      }
    });
  });

  describe('undo', () => {
    it('should undo a create operation (delete the task)', async () => {
      const api = createApi();
      const createResult = await api.createTask({ displayName: 'Task' });

      expect(createResult.ok).toBe(true);
      if (createResult.ok) {
        const path = createResult.value.path;

        const getBeforeUndo = await api.getTask(path);
        expect(getBeforeUndo).not.toBeNull();

        const undoResult = await api.undo();
        expect(undoResult.ok).toBe(true);

        const getAfterUndo = await api.getTask(path);
        expect(getAfterUndo).toBeNull();
      }
    });

    it('should undo an update operation', async () => {
      const api = createApi();
      const createResult = await api.createTask({ displayName: 'Original' });

      expect(createResult.ok).toBe(true);
      if (createResult.ok) {
        const path = createResult.value.path;
        const revision = createResult.value.revision;

        const updateResult = await api.updateTaskItem({
          path,
          expectedRevision: revision,
          parent: { displayName: 'Updated' },
        });

        expect(updateResult.ok).toBe(true);
        if (updateResult.ok) {
          const getUpdated = await api.getTask(path);
          expect(getUpdated?.note.displayName).toBe('Updated');

          const undoResult = await api.undo();
          expect(undoResult.ok).toBe(true);

          const getUndone = await api.getTask(path);
          expect(getUndone?.note.displayName).toBe('Original');
        }
      }
    });

    it('should restore a deleted subtask with its original createdAt and fields on undo', async () => {
      const api = createApi();
      const createResult = await api.createTask({ displayName: 'Task' });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const addResult = await api.updateTaskItem({
        path: createResult.value.path,
        expectedRevision: createResult.value.revision,
        newSubtasks: [{ key: 'st1', title: 'Subtask', createdAt: '2020-01-01' }],
      });
      expect(addResult.ok).toBe(true);
      if (!addResult.ok) return;

      const withTags = await api.updateTaskItem({
        path: createResult.value.path,
        expectedRevision: addResult.value.revision,
        subtasks: [{ key: 'st1', fields: { tags: ['important'] } }],
      });
      expect(withTags.ok).toBe(true);
      if (!withTags.ok) return;

      const deleteResult = await api.updateTaskItem({
        path: createResult.value.path,
        expectedRevision: withTags.value.revision,
        deleteSubtaskKeys: ['st1'],
      });
      expect(deleteResult.ok).toBe(true);
      if (!deleteResult.ok) return;
      expect(deleteResult.value.note.subtasks).toHaveLength(0);

      const undoResult = await api.undo();
      expect(undoResult.ok).toBe(true);

      const restored = await api.getTask(createResult.value.path);
      const st = restored?.note.subtasks.find((s) => s.key === 'st1');
      expect(st).toBeDefined();
      expect(st?.createdAt).toBe('2020-01-01');
      expect(st?.tags).toEqual(['important']);
      expect(st?.title).toBe('Subtask');
    });

    it('should fail gracefully on undo with revision conflict', async () => {
      const adapter = new FakeVaultAdapter();
      const apiWithAdapter = new CoreTaskAPI(adapter, { now: fakeNow });
      const createWithAdapter = await apiWithAdapter.createTask({ displayName: 'Task' });

      expect(createWithAdapter.ok).toBe(true);
      if (!createWithAdapter.ok) return;

      const adapterPath = createWithAdapter.value.path;
      await apiWithAdapter.updateTaskItem({
        path: adapterPath,
        expectedRevision: createWithAdapter.value.revision,
        parent: { displayName: 'Updated' },
      });

      adapter._simulateExternalWrite(adapterPath, { displayName: 'External Update' }, 'body');

      const undoResult = await apiWithAdapter.undo();
      expect(undoResult.ok).toBe(false);
      if (!undoResult.ok) {
        expect(undoResult.error.code).toBe('REVISION_CONFLICT');
      }
    });

    it('should return success no-op on undo with empty stack', async () => {
      const api = createApi();
      const undoResult = await api.undo();
      expect(undoResult.ok).toBe(true);
      if (undoResult.ok) {
        expect(undoResult.value).toBeUndefined();
      }
    });
  });

  describe('auto-priority', () => {
    it('should project auto-priority on read based on due date', async () => {
      const api = createApi();
      const createResult = await api.createTask({
        displayName: 'Overdue Task',
        dueDate: '2026-07-19', // Today (2026-07-19)
      });

      expect(createResult.ok).toBe(true);
      if (createResult.ok) {
        // When created with auto priority mode and dueDate today, should have priority 5
        expect(createResult.value.note.priority).toBe(5);

        // But the stored value in frontmatter should still be 0
        const path = createResult.value.path;
        const task = await api.getTask(path);
        expect(task?.note.priority).toBe(5); // Still projected as 5
      }
    });

    it('should not modify raw cached note on auto-priority projection', async () => {
      const api = createApi();
      const createResult = await api.createTask({
        displayName: 'Task',
        dueDate: '2026-07-19',
      });

      expect(createResult.ok).toBe(true);
      if (createResult.ok) {
        const path = createResult.value.path;

        // Call getTask multiple times to ensure cache is used
        const task1 = await api.getTask(path);
        const task2 = await api.getTask(path);

        // Both should have the same projected priority
        expect(task1?.note.priority).toBe(5);
        expect(task2?.note.priority).toBe(5);
      }
    });
  });

  describe('workload deletion', () => {
    it('should delete workload entry when value is 0', async () => {
      const api = createApi();
      const createResult = await api.createTask({ displayName: 'Task' });

      expect(createResult.ok).toBe(true);
      if (createResult.ok) {
        const path = createResult.value.path;
        const revision = createResult.value.revision;

        // First, add a subtask with workload
        const addSubtaskResult = await api.updateTaskItem({
          path,
          expectedRevision: revision,
          newSubtasks: [{ key: 'st1', title: 'Subtask 1' }],
        });

        expect(addSubtaskResult.ok).toBe(true);
        if (addSubtaskResult.ok) {
          const newRevision = addSubtaskResult.value.revision;

          // Now set a workload entry
          const setWorkloadResult = await api.updateTaskItem({
            path,
            expectedRevision: newRevision,
            subtasks: [
              {
                key: 'st1',
                fields: { workloadPlan: { '2026-07-19': 4 } },
              },
            ],
          });

          expect(setWorkloadResult.ok).toBe(true);
          if (setWorkloadResult.ok) {
            const withWorkload = setWorkloadResult.value;
            const st = withWorkload.note.subtasks.find((s) => s.key === 'st1');
            expect(st?.workloadPlan['2026-07-19']).toBe(4);

            // Now delete the entry by setting it to 0
            const deleteWorkloadResult = await api.updateTaskItem({
              path,
              expectedRevision: setWorkloadResult.value.revision,
              subtasks: [
                {
                  key: 'st1',
                  fields: { workloadPlan: { '2026-07-19': 0 } },
                },
              ],
            });

            expect(deleteWorkloadResult.ok).toBe(true);
            if (deleteWorkloadResult.ok) {
              const afterDelete = deleteWorkloadResult.value;
              const stAfter = afterDelete.note.subtasks.find((s) => s.key === 'st1');
              expect(stAfter?.workloadPlan['2026-07-19']).toBeUndefined();
            }
          }
        }
      }
    });
  });

  describe('subscribe/unsubscribe', () => {
    it('should notify subscribers on create', async () => {
      const api = createApi();
      const events: { type: string; path: string }[] = [];
      api.subscribe((event) => events.push(event));

      await api.createTask({ displayName: 'New Task' });

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('created');
    });

    it('should notify subscribers on update', async () => {
      const api = createApi();
      const createResult = await api.createTask({ displayName: 'Task' });

      const events: { type: string; path: string }[] = [];
      api.subscribe((event) => events.push(event));

      if (createResult.ok) {
        await api.updateTaskItem({
          path: createResult.value.path,
          expectedRevision: createResult.value.revision,
          parent: { displayName: 'Updated' },
        });
      }

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('updated');
    });

    it('should notify subscribers on delete', async () => {
      const api = createApi();
      const createResult = await api.createTask({ displayName: 'Task' });

      const events: { type: string; path: string }[] = [];
      api.subscribe((event) => events.push(event));

      if (createResult.ok) {
        await api.deleteTask(createResult.value.path, createResult.value.revision);
      }

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('deleted');
    });

    it('should stop notifying after unsubscribe', async () => {
      const api = createApi();
      const events: { type: string; path: string }[] = [];
      const unsub = api.subscribe((event) => events.push(event));

      await api.createTask({ displayName: 'Task 1' });
      expect(events).toHaveLength(1);

      unsub();

      await api.createTask({ displayName: 'Task 2' });
      expect(events).toHaveLength(1); // Still 1, subscriber was removed
    });
  });

  describe('subtask operations', () => {
    it('should add a new subtask', async () => {
      const api = createApi();
      const createResult = await api.createTask({ displayName: 'Task' });

      expect(createResult.ok).toBe(true);
      if (createResult.ok) {
        const path = createResult.value.path;
        const revision = createResult.value.revision;

        const updateResult = await api.updateTaskItem({
          path,
          expectedRevision: revision,
          newSubtasks: [{ key: 'st1', title: 'Subtask' }],
        });

        expect(updateResult.ok).toBe(true);
        if (updateResult.ok) {
          const st = updateResult.value.note.subtasks.find((s) => s.key === 'st1');
          expect(st).toBeDefined();
          expect(st?.title).toBe('Subtask');
          expect(st?.statusLabel).toBe('active');
        }
      }
    });

    it('should delete a subtask', async () => {
      const api = createApi();
      const createResult = await api.createTask({ displayName: 'Task' });

      expect(createResult.ok).toBe(true);
      if (createResult.ok) {
        const path = createResult.value.path;
        const revision = createResult.value.revision;

        // Add subtask
        const addResult = await api.updateTaskItem({
          path,
          expectedRevision: revision,
          newSubtasks: [{ key: 'st1', title: 'Subtask' }],
        });

        expect(addResult.ok).toBe(true);
        if (addResult.ok) {
          // Delete it
          const delResult = await api.updateTaskItem({
            path,
            expectedRevision: addResult.value.revision,
            deleteSubtaskKeys: ['st1'],
          });

          expect(delResult.ok).toBe(true);
          if (delResult.ok) {
            expect(delResult.value.note.subtasks).toHaveLength(0);
            expect(delResult.value.note.subtaskOrder).toHaveLength(0);
          }
        }
      }
    });

    it('should create a subtask and set its fields in the same patch', async () => {
      const api = createApi();
      const createResult = await api.createTask({ displayName: 'Task' });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const result = await api.updateTaskItem({
        path: createResult.value.path,
        expectedRevision: createResult.value.revision,
        newSubtasks: [{ key: 'st1', title: 'Subtask' }],
        subtasks: [{ key: 'st1', fields: { tags: ['same-call'] } }],
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        const st = result.value.note.subtasks.find((s) => s.key === 'st1');
        expect(st?.tags).toEqual(['same-call']);
      }
    });

    it('should reject a new subtask key that collides with an existing one', async () => {
      const api = createApi();
      const createResult = await api.createTask({ displayName: 'Task' });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const addResult = await api.updateTaskItem({
        path: createResult.value.path,
        expectedRevision: createResult.value.revision,
        newSubtasks: [{ key: 'st1', title: 'Subtask' }],
      });
      expect(addResult.ok).toBe(true);
      if (!addResult.ok) return;

      const collideResult = await api.updateTaskItem({
        path: createResult.value.path,
        expectedRevision: addResult.value.revision,
        newSubtasks: [{ key: 'st1', title: 'Duplicate' }],
      });

      expect(collideResult.ok).toBe(false);
      if (!collideResult.ok) {
        expect(collideResult.error.code).toBe('VALIDATION_ERROR');
      }
    });

    it('should reject a new subtask key that collides with one also being deleted in the same patch', async () => {
      // Creating and deleting the same key in one call is not treated as a
      // "replace" — the API rejects it outright, since newSubtasks is applied
      // before deleteSubtaskKeys and a key-based delete would remove both the
      // old and the newly-created entry, silently losing the subtask entirely.
      const api = createApi();
      const createResult = await api.createTask({ displayName: 'Task' });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const addResult = await api.updateTaskItem({
        path: createResult.value.path,
        expectedRevision: createResult.value.revision,
        newSubtasks: [{ key: 'st1', title: 'Subtask' }],
      });
      expect(addResult.ok).toBe(true);
      if (!addResult.ok) return;

      const replaceResult = await api.updateTaskItem({
        path: createResult.value.path,
        expectedRevision: addResult.value.revision,
        newSubtasks: [{ key: 'st1', title: 'Replacement' }],
        deleteSubtaskKeys: ['st1'],
      });

      expect(replaceResult.ok).toBe(false);
      if (!replaceResult.ok) {
        expect(replaceResult.error.code).toBe('VALIDATION_ERROR');
      }

      // And the original subtask must still be intact, unmodified.
      const after = await api.getTask(createResult.value.path);
      expect(after?.note.subtasks).toHaveLength(1);
      expect(after?.note.subtasks[0].title).toBe('Subtask');
    });

    it('should accept a subtask created by one patch object and field-patched by another patch object in the same batch call', async () => {
      const api = createApi();
      const createResult = await api.createTask({ displayName: 'Task' });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const result = await api.updateTaskItemsBatch([
        {
          path: createResult.value.path,
          expectedRevision: createResult.value.revision,
          newSubtasks: [{ key: 'st1', title: 'Subtask' }],
        },
        {
          path: createResult.value.path,
          expectedRevision: createResult.value.revision,
          subtasks: [{ key: 'st1', fields: { tags: ['from-second-patch'] } }],
        },
      ]);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const st = result.value[0].note.subtasks.find((s) => s.key === 'st1');
        expect(st?.tags).toEqual(['from-second-patch']);
      }
    });

    it('should reject two patch objects in the same batch call creating the same new subtask key', async () => {
      const api = createApi();
      const createResult = await api.createTask({ displayName: 'Task' });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const result = await api.updateTaskItemsBatch([
        {
          path: createResult.value.path,
          expectedRevision: createResult.value.revision,
          newSubtasks: [{ key: 'st1', title: 'First' }],
        },
        {
          path: createResult.value.path,
          expectedRevision: createResult.value.revision,
          newSubtasks: [{ key: 'st1', title: 'Second' }],
        },
      ]);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('VALIDATION_ERROR');
      }

      const after = await api.getTask(createResult.value.path);
      expect(after?.note.subtasks).toHaveLength(0);
    });
  });

  describe('listTasks', () => {
    it('should list all created tasks', async () => {
      const api = createApi();
      await api.createTask({ displayName: 'Task 1' });
      await api.createTask({ displayName: 'Task 2' });

      const tasks = await api.listTasks();
      expect(tasks).toHaveLength(2);
      expect(tasks.some((t) => t.note.displayName === 'Task 1')).toBe(true);
      expect(tasks.some((t) => t.note.displayName === 'Task 2')).toBe(true);
    });

    it('should skip deleted tasks in list', async () => {
      const api = createApi();
      const create1 = await api.createTask({ displayName: 'Task 1' });
      const create2 = await api.createTask({ displayName: 'Task 2' });

      expect(create1.ok && create2.ok).toBe(true);

      if (create1.ok && create2.ok) {
        await api.deleteTask(create1.value.path, create1.value.revision);

        const tasks = await api.listTasks();
        expect(tasks).toHaveLength(1);
        expect(tasks[0].note.displayName).toBe('Task 2');
      }
    });
  });
});
