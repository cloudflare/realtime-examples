import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";

import { API_HEADER_LOCAL_IDENTITY } from "../shared/protocol";

export type AuthEnv = {
  AUTH_MODE?: string;
  CF_ACCESS_AUD?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
};

export type AuthenticatedPrincipal = {
  accessExpiresAt?: number;
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
const authModeSchema = z.enum(["cloudflare-access", "local"]);
const localHostSchema = z.enum(["127.0.0.1", "localhost", "[::1]"]);
const localIdentitySchema = z
  .string()
  .trim()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/);
const accessTokenSchema = z.string().min(1);
const accessConfigSchema = z.object({
  CF_ACCESS_AUD: z.string().trim().min(1),
  CF_ACCESS_TEAM_DOMAIN: z
    .string()
    .trim()
    .transform((value) => value.replace(/^https?:\/\//, "").replace(/\/+$/, ""))
    .refine((value) => /^[a-zA-Z0-9.-]+$/.test(value)),
});
const accessClaimsSchema = z
  .object({
    email: z.string().min(1).optional(),
    exp: z
      .number()
      .int()
      .positive()
      .max(Math.floor(Number.MAX_SAFE_INTEGER / 1_000)),
    sub: z.string().min(1).optional(),
  })
  .passthrough()
  .refine((claims) => Boolean(claims.sub ?? claims.email));

export function assertSameOrigin(request: Request): void {
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if ((origin && origin !== url.origin) || fetchSite === "cross-site") {
    throw new RequestError(
      403,
      "cross_origin_request",
      "This operation must be sent from the cloud-gaming application origin.",
    );
  }
}

export async function authenticateUser(
  request: Request,
  env: AuthEnv,
): Promise<AuthenticatedPrincipal> {
  const rawMode = env.AUTH_MODE?.trim();
  const mode = authModeSchema.safeParse(rawMode);
  const url = new URL(request.url);

  if (!rawMode) {
    throw new RequestError(
      503,
      "auth_mode_missing",
      "AUTH_MODE must be configured as cloudflare-access or local.",
    );
  }

  if (!mode.success) {
    throw new RequestError(
      503,
      "auth_mode_invalid",
      "AUTH_MODE must be local or cloudflare-access.",
    );
  }

  if (mode.data === "local") {
    if (!localHostSchema.safeParse(url.hostname).success) {
      throw new RequestError(
        503,
        "local_auth_unavailable",
        "Local identities are disabled on deployed hosts.",
      );
    }
    const identity = localIdentitySchema.safeParse(
      request.headers.get(API_HEADER_LOCAL_IDENTITY),
    );
    if (!identity.success) {
      throw new RequestError(
        401,
        "local_identity_required",
        "Provide a local development identity.",
      );
    }
    return {
      displayHint: identity.data,
      subject: `local:${identity.data.toLowerCase()}`,
    };
  }

  const config = accessConfigSchema.safeParse(env);
  if (!config.success) {
    throw new RequestError(
      503,
      "access_not_configured",
      "Cloudflare Access authentication is not configured.",
    );
  }

  const token = accessTokenSchema.safeParse(
    request.headers.get("cf-access-jwt-assertion"),
  );
  if (!token.success) {
    throw new RequestError(
      401,
      "access_identity_required",
        "Authenticate through Cloudflare Access before using this application.",
    );
  }

  const issuer = `https://${config.data.CF_ACCESS_TEAM_DOMAIN}`;
  let keySet = jwks.get(issuer);
  if (!keySet) {
    keySet = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    jwks.set(issuer, keySet);
  }

  try {
    const { payload } = await jwtVerify(token.data, keySet, {
      audience: config.data.CF_ACCESS_AUD,
      issuer,
    });
    const claims = accessClaimsSchema.parse(payload);
    const subject = claims.sub ?? claims.email;
    const accessExpiresAt = claims.exp * 1_000;
    if (!subject || accessExpiresAt <= Date.now()) {
      throw new Error("missing required Access claims");
    }
    return {
      accessExpiresAt,
      displayHint: claims.email ?? subject,
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
