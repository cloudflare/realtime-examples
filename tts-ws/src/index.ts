import playerHtml from './player.html';

// Export Durable Objects from their separate modules
export { TTSAdapter } from './tts-adapter';
export { STTAdapter } from './stt-adapter';

/**
 * Main Worker Handler
 *
 * Routes incoming HTTP requests to the appropriate Durable Object instance based on the session name
 * (the first URL path segment). This ensures that multiple requests with the same session name are handled
 * by the same instance, allowing session-specific requests to the correct Durable Object instance.
 */
export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);
		const pathParts = url.pathname
			.substring(1)
			.split('/')
			.filter((p) => p);

		// Root request handler.
		if (pathParts.length === 0) {
			return new Response('Welcome! Use /<session-name>/publisher to control or /<session-name>/player to listen.', { status: 200 });
		}

		const sessionName = pathParts[0];
		const action = pathParts.length > 1 ? pathParts[1] : null;

		// Route: GET /<session-name>/player OR GET /<session-name>/publisher
		// These are stateless requests to serve the UI. Both routes serve the same HTML file.
		if (action && ['player', 'publisher'].includes(action) && request.method === 'GET') {
			return new Response(playerHtml, {
				headers: { 'Content-Type': 'text/html;charset=UTF-8' },
			});
		}

		// Route: DELETE /<session-name>
		// Forcibly terminates a session across both TTS and STT adapters and wipes state.
		if (!action && request.method === 'DELETE') {
			const ttsId = env.TTS_ADAPTER.idFromName(sessionName);
			const ttsStub = env.TTS_ADAPTER.get(ttsId);
			const sttId = env.STT_ADAPTER.idFromName(sessionName);
			const sttStub = env.STT_ADAPTER.get(sttId);

			// Run both destroys concurrently in the background
			ctx.waitUntil(
				Promise.allSettled([
					// These are Durable Object RPC calls to class methods
					// They will create/wake the instances as needed
					ttsStub.destroy(),
					sttStub.destroy(),
				])
			);
			return new Response(`Session ${sessionName} destroy signal sent.`, { status: 202 });
		}

		// Route: /<session-name>/stt/* - STT endpoints
		if (action === 'stt' && pathParts.length > 2) {
			const sttAdapterId = env.STT_ADAPTER.idFromName(sessionName);
			const sttAdapterStub = env.STT_ADAPTER.get(sttAdapterId);
			return await sttAdapterStub.fetch(request);
		}

		// All other actions are stateful and must be forwarded to the Durable Object.
		if (action && ['publish', 'unpublish', 'connect', 'generate', 'subscribe'].includes(action)) {
			const id = env.TTS_ADAPTER.idFromName(sessionName);
			const stub = env.TTS_ADAPTER.get(id);
			return stub.fetch(request);
		}

		return new Response('Not Found', { status: 404 });
	},
} satisfies ExportedHandler<Env>;
