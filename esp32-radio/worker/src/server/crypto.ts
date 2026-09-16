export async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
export async function equal(a: string, b: string): Promise<boolean> {
  return (await digest(a)) === (await digest(b));
}
