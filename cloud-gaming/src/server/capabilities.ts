import { capabilitySchema } from "../shared/schemas";
import { RequestError } from "./auth";

export function createCapability(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

export async function hashCapability(capability: string): Promise<string> {
  if (!capabilitySchema.safeParse(capability).success) {
    throw new RequestError(
      403,
      "capability_invalid",
      "The supplied capability is invalid or expired.",
    );
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(capability),
  );
  return base64Url(new Uint8Array(digest));
}

export async function capabilityMatches(
  capability: string | null,
  expectedHash: string,
): Promise<boolean> {
  const parsed = capabilitySchema.safeParse(capability);
  if (!parsed.success) return false;
  return (await hashCapability(parsed.data)) === expectedHash;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
