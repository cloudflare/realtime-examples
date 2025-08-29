/**
 * Shared configuration constants for TTS and STT adapters
 */

// Model names
export const TTS_MODEL = '@cf/deepgram/aura-1';
export const STT_MODEL = '@cf/deepgram/nova-3';

// Timeouts and intervals
export const DEFAULT_INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
export const DEFAULT_CLEANUP_GRACE_MS = 100; // 100ms delay for last-client cleanup
export const DEFAULT_MAX_RECONNECT_ATTEMPTS = 5;
export const DEFAULT_MAX_RECONNECT_DELAY_MS = 30000; // 30 seconds

// TTS-specific
export const TTS_BUFFER_CHUNK_SIZE = 16 * 1024; // 16KB - must be less than SFU's 32KB WebSocket message limit

// STT-specific
export const STT_DEBUG_GRACE_MS = 30 * 1000; // 30 seconds grace when debug-restart with no clients
export const STT_NOVA_KEEPALIVE_MS = 5 * 1000; // 5 seconds
export const STT_MAX_QUEUE_BYTES = 2 * 1024 * 1024; // 2MB safety cap
export const STT_MIN_BATCH_BYTES = 3200; // ~100ms @16kHz mono 16-bit
export const STT_MAX_BATCH_BYTES = 16000; // 500ms @16kHz mono 16-bit
export const STT_MAX_DRAIN_BATCHES_PER_TURN = 8;
export const STT_MAX_DRAIN_SLICE_MS = 10;
