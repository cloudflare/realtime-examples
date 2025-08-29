/**
 * Generic state management utilities for Durable Objects
 */

// DurableObjectState is available globally

export interface StateStore<T> {
	state: T;
	save(): Promise<void>;
	restore(): Promise<void>;
	update(updates: Partial<T>, skipAlarmReschedule?: boolean): Promise<void>;
	deleteKeys(keys: (keyof T)[], skipAlarmReschedule?: boolean): Promise<void>;
}

/**
 * Creates a state store with batched updates and alarm management
 */
export function createStateStore<T extends Record<string, any>>(
	ctx: DurableObjectState,
	storageKey: string,
	initialState: T,
	getDeadlines?: (state: T) => number[]
): StateStore<T> & { rescheduleAlarm(): Promise<void> } {
	const store = {
		state: { ...initialState },

		async save(): Promise<void> {
			await ctx.storage.put(storageKey, store.state);
		},

		async restore(): Promise<void> {
			const savedState = await ctx.storage.get<T>(storageKey);
			if (savedState) {
				store.state = { ...initialState, ...savedState };
			}
		},

		/**
		 * Updates state and optionally reschedules alarm
		 * @param updates Partial state updates to apply
		 * @param skipAlarmReschedule Skip alarm rescheduling if true
		 */
		async update(updates: Partial<T>, skipAlarmReschedule = false): Promise<void> {
			Object.assign(store.state, updates);
			await store.save();
			if (!skipAlarmReschedule && getDeadlines) {
				await store.rescheduleAlarm();
			}
		},

		/**
		 * Deletes specified keys from state
		 * @param keys Keys to delete from state
		 * @param skipAlarmReschedule Skip alarm rescheduling if true
		 */
		async deleteKeys(keys: (keyof T)[], skipAlarmReschedule = false): Promise<void> {
			for (const key of keys) {
				delete store.state[key];
			}
			await store.save();
			if (!skipAlarmReschedule && getDeadlines) {
				await store.rescheduleAlarm();
			}
		},

		async rescheduleAlarm(): Promise<void> {
			if (!getDeadlines) return;

			const deadlines = getDeadlines(store.state);
			const validDeadlines = deadlines.filter((d) => typeof d === 'number' && d > 0);

			if (validDeadlines.length > 0) {
				await ctx.storage.setAlarm(Math.min(...validDeadlines));
			} else {
				await ctx.storage.deleteAlarm();
			}
		},
	};

	return store;
}
