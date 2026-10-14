export type EncryptedCredential = { ciphertext: string; iv: string; keyVersion: string }

export async function encryptCredential(
  value: string,
  keyMaterial: string,
  additionalData?: string,
): Promise<EncryptedCredential> {
  const key = await importKey(keyMaterial, ['encrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
      ...(additionalData ? { additionalData: new TextEncoder().encode(additionalData) } : {}),
    },
    key,
    new TextEncoder().encode(value),
  )
  return {
    ciphertext: encodeBase64(new Uint8Array(ciphertext)),
    iv: encodeBase64(iv),
    keyVersion: 'v1',
  }
}
export async function decryptCredential(
  encrypted: EncryptedCredential,
  keyMaterial: string,
  additionalData?: string,
) {
  if (encrypted.keyVersion !== 'v1') throw new Error('Unsupported token key version')
  const key = await importKey(keyMaterial, ['decrypt'])
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: decodeBase64(encrypted.iv),
      ...(additionalData ? { additionalData: new TextEncoder().encode(additionalData) } : {}),
    },
    key,
    decodeBase64(encrypted.ciphertext),
  )
  return new TextDecoder().decode(plaintext)
}
async function importKey(value: string, usages: ('encrypt' | 'decrypt')[]) {
  return crypto.subtle.importKey(
    'raw',
    decodeKeyMaterial(value),
    { name: 'AES-GCM' },
    false,
    usages,
  )
}
export function decodeKeyMaterial(value: string) {
  const material = value.trim()
  const bytes = /^[0-9a-f]{64}$/i.test(material)
    ? Uint8Array.from(material.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16))
    : decodeBase64(material)
  if (bytes.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must contain 32 bytes')
  return bytes
}
function encodeBase64(bytes: Uint8Array) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}
function decodeBase64(value: string) {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='))
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}
