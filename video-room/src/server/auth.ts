import { createRemoteJWKSet, jwtVerify } from "jose";

import { API_HEADER_LOCAL_IDENTITY } from "../shared/protocol";

export type AuthEnv = {
  AUTH_MODE?: string;
  CF_ACCESS_AUD?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
};

export type AuthenticatedPrincipal = {
  displayHint: string;
  subject: string;
};

export class RequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "RequestError";
  }
}

const jwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const LOCAL_IDENTITY = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export function assertSameOrigin(request: Request): void {
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if ((origin && origin !== url.origin) || fetchSite === "cross-site") {
    throw new RequestError(
      403,
      "cross_origin_request",
      "Room mutations must be sent from this application origin.",
    );
  }
}

export async function authenticateRequest(
  request: Request,
  env: AuthEnv,
): Promise<AuthenticatedPrincipal> {
  const mode = env.AUTH_MODE?.trim();
  const url = new URL(request.url);

  if (!mode) {
    throw new RequestError(
      503,
      "auth_mode_missing",
      "AUTH_MODE must be configured as cloudflare-access or local.",
    );
  }

  if (mode === "local") {
    if (!LOCAL_HOSTS.has(url.hostname)) {
      throw new RequestError(
        503,
        "local_auth_unavailable",
        "Local identities are disabled on deployed hosts. Configure Cloudflare Access authentication.",
      );
    }
    const identity = request.headers.get(API_HEADER_LOCAL_IDENTITY)?.trim();
    if (!identity || !LOCAL_IDENTITY.test(identity)) {
      throw new RequestError(
        401,
        "local_identity_required",
        "Enter a local development identity before joining.",
      );
    }
    return {
      displayHint: identity,
      subject: `local:${identity.toLowerCase()}`,
    };
  }

  if (mode !== "cloudflare-access") {
    throw new RequestError(
      503,
      "auth_mode_invalid",
      "AUTH_MODE must be local or cloudflare-access.",
    );
  }

  const audience = env.CF_ACCESS_AUD?.trim();
  const teamDomain = env.CF_ACCESS_TEAM_DOMAIN?.trim().replace(/^https?:\/\//, "");
  if (!audience || !teamDomain) {
    throw new RequestError(
      503,
      "access_not_configured",
      "Cloudflare Access authentication is not configured for this deployment.",
    );
  }
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) {
    throw new RequestError(
      401,
      "access_identity_required",
      "Authenticate through Cloudflare Access before joining this room.",
    );
  }

  const issuer = `https://${teamDomain}`;
  let keySet = jwks.get(issuer);
  if (!keySet) {
    keySet = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    jwks.set(issuer, keySet);
  }
  try {
    const { payload } = await jwtVerify(token, keySet, {
      audience,
      issuer,
    });
    const subject =
      typeof payload.sub === "string"
        ? payload.sub
        : typeof payload.email === "string"
          ? payload.email
          : undefined;
    if (!subject) {
      throw new Error("missing subject");
    }
    return {
      displayHint:
        typeof payload.email === "string" ? payload.email : subject,
      subject: `access:${subject}`,
    };
  } catch {
    throw new RequestError(
      401,
      "access_identity_invalid",
      "The Cloudflare Access identity could not be verified.",
    );
  }
}
