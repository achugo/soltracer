const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Decodes standard, padded base64 (what the engine returns) to bytes. Returns null for anything else
 * rather than letting `atob` silently accept loose input.
 */
export function base64ToBytes(value: string): Uint8Array | null {
  if (value.length === 0 || !BASE64.test(value)) return null;
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
