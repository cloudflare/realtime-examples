/**
 * Shared utilities for Durable Objects
 */

import { StateStore } from './state-store';

/**
 * Builds a deadline aggregator function for use with StateStore
 * @param keys Array of state keys that contain deadline values
 * @returns Function that extracts all non-undefined deadline values from state
 */
export function buildDeadlineAggregator<T>(keys: (keyof T)[]): (state: T) => number[] {
	return (state: T) => {
		const deadlines: number[] = [];
		for (const key of keys) {
			const value = state[key];
			if (typeof value === 'number') {
				deadlines.push(value);
			}
		}
		return deadlines;
	};
}

/**
 * Schedules a deferred cleanup check via alarm
 * Used to handle DO timing issues where getWebSockets() may include closing sockets
 * @param stateStore State store with cleanupDeadline property
 * @param graceMs Grace period in milliseconds (default 100ms)
 */
export async function scheduleDeferredCleanup<T extends { cleanupDeadline?: number }>(
	stateStore: StateStore<T>,
	graceMs: number = 100
): Promise<void> {
	const target = Date.now() + graceMs;
	const currentCleanup = stateStore.state.cleanupDeadline;

	// Only update if we don't have a deadline or ours is earlier (with churn guard)
	if (!currentCleanup || currentCleanup > target + 250) {
		await stateStore.update({ cleanupDeadline: target } as Partial<T>);
	}
}

/**
 * Gets WebSockets that are actually open (readyState === OPEN)
 * @param ctx Durable Object state context
 * @param predicate Optional predicate to filter sockets
 * @returns Array of open WebSocket instances
 */
export function getOpenSockets(ctx: DurableObjectState, predicate?: (ws: WebSocket) => boolean): WebSocket[] {
	const allSockets = ctx.getWebSockets();
	const openSockets = allSockets.filter((ws) => ws.readyState === WebSocket.OPEN);

	if (predicate) {
		return openSockets.filter(predicate);
	}

	return openSockets;
}

/**
 * Schedules a reconnection attempt with exponential backoff
 * @param stateStore State store with reconnection properties
 * @param options Reconnection options
 */
export async function scheduleReconnect<
	T extends {
		allowReconnect?: boolean;
		reconnectAttempts?: number;
		reconnectType?: string;
		reconnectDeadline?: number;
	}
>(
	stateStore: StateStore<T>,
	options: {
		type: string;
		maxAttempts?: number;
		maxDelayMs?: number;
	}
): Promise<void> {
	const { type, maxAttempts = 5, maxDelayMs = 30000 } = options;

	if (!stateStore.state.allowReconnect) {
		return;
	}

	const currentAttempts = stateStore.state.reconnectAttempts || 0;
	const newAttempts = currentAttempts + 1;

	if (newAttempts > maxAttempts) {
		return;
	}

	const delay = Math.min(1000 * Math.pow(2, newAttempts - 1), maxDelayMs);
	const target = Date.now() + delay;

	const updates: Partial<T> = {
		reconnectAttempts: newAttempts,
		reconnectType: type,
	} as Partial<T>;

	// Only update deadline if needed (with churn guard)
	const currentDeadline = stateStore.state.reconnectDeadline;
	if (!currentDeadline || currentDeadline > target + 250) {
		(updates as any).reconnectDeadline = target;
	}

	await stateStore.update(updates);
}
