/**
 * WebSocket connection management utilities
 * Provides deduplication to prevent concurrent connection attempts
 */

export interface DedupedConnectionParams<T extends WebSocket> {
	getCurrent: () => T | null;
	setCurrent: (ws: T | null) => void;
	getCurrentPromise: () => Promise<T> | null;
	setCurrentPromise: (promise: Promise<T> | null) => void;
	connectFn: () => Promise<T>;
	onConnected?: (ws: T) => void;
}

/**
 * Ensures only one WebSocket connection attempt is in flight at a time
 * Returns existing open connection or waits for in-flight attempt
 */
export async function dedupedConnect<T extends WebSocket>(params: DedupedConnectionParams<T>): Promise<T> {
	const { getCurrent, setCurrent, getCurrentPromise, setCurrentPromise, connectFn, onConnected } = params;

	// Check if WebSocket is already open
	const current = getCurrent();
	if (current?.readyState === WebSocket.OPEN) {
		return current;
	}

	// If WebSocket is connecting, wait for the existing connection promise
	if (current?.readyState === WebSocket.CONNECTING) {
		const currentPromise = getCurrentPromise();
		if (currentPromise) {
			return await currentPromise;
		}
	}

	// Check if there's already a connection promise in flight
	const existingPromise = getCurrentPromise();
	if (existingPromise) {
		return await existingPromise;
	}

	// No connection in progress, create a new one
	const promise = connectFn();
	setCurrentPromise(promise);

	try {
		const ws = await promise;
		setCurrent(ws);
		setCurrentPromise(null);
		if (onConnected) {
			onConnected(ws);
		}
		return ws;
	} catch (error) {
		setCurrentPromise(null);
		throw error;
	}
}
