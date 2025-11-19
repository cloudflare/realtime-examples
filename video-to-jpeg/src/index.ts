import playerHtml from "./player.html";

// Export Durable Objects from their modules
export { VideoAdapter } from "./video-adapter";

/**
 * Main Worker handler for the video-to-jpeg demo.
 *
 * Routes incoming HTTP requests to the appropriate Durable Object instance
 * based on the session name (the first URL path segment).
 */
export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const pathParts = url.pathname
      .substring(1)
      .split("/")
      .filter((p) => p);

    // Root request handler
    if (pathParts.length === 0) {
      return new Response(
        "Welcome! Use /<session>/publisher to publish video or /<session>/viewer to see JPEG snapshots.",
        { status: 200 }
      );
    }

    const sessionName = pathParts[0];
    const action = pathParts.length > 1 ? pathParts[1] : null;

    // Serve UI shell: GET /<session>/(publisher|viewer)
    if (action && ["publisher", "viewer"].includes(action) && request.method === "GET") {
      return new Response(playerHtml, {
        headers: { "Content-Type": "text/html;charset=UTF-8" },
      });
    }

    // Debug cleanup: DELETE /<session>
    if (!action && request.method === "DELETE") {
      const videoId = env.VIDEO_ADAPTER.idFromName(sessionName);
      const videoStub = env.VIDEO_ADAPTER.get(videoId);

      ctx.waitUntil(
        Promise.allSettled([
          // Durable Object RPC to class method
          videoStub.destroy(),
        ])
      );

      return new Response(`Session ${sessionName} destroy signal sent.`, { status: 202 });
    }

    // Route: /<session>/video/* - video adapter endpoints (HTTP + WebSocket)
    if (action === "video") {
      const videoId = env.VIDEO_ADAPTER.idFromName(sessionName);
      const videoStub = env.VIDEO_ADAPTER.get(videoId);
      return videoStub.fetch(request);
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
