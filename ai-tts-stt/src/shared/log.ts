/**
 * Logging utilities for consistent log formatting across adapters
 */

// Use types from global scope instead of importing

/**
 * Creates an adapter logger with support for aliasing the DO id to a human-readable session name.
 * - aliasOnce(name): logs a one-time mapping and switches future logs to use the name
 * - setAliasSilently(name): switches to the name without emitting the mapping log (useful on restore)
 */
export function createAdapterLogger(adapter: 'TTS' | 'STT', id: DurableObjectId) {
	const adapterName = `${adapter}Adapter`;
	const originalId = id.toString();
	let currentLabel = originalId;

	const format = (message: string) => `[${adapterName}:${currentLabel}] ${message}`;

	return {
		log: (message: string, ...args: any[]) => console.log(format(message), ...args),
		warn: (message: string, ...args: any[]) => console.warn(format(message), ...args),
		error: (message: string, ...args: any[]) => console.error(format(message), ...args),
		aliasOnce: (name: string): boolean => {
			if (!name || name === currentLabel) return false;
			// Announce mapping from the long id to the human-readable session name once
			console.log(`[${adapterName}:${originalId}] Durable Object is now known as "${name}"`);
			currentLabel = name;
			return true;
		},
		setAliasSilently: (name: string): boolean => {
			if (!name || name === currentLabel) return false;
			currentLabel = name;
			return true;
		},
	} as const;
}
