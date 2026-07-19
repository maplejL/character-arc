import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { config } from '../config.js'

const ALGO = 'aes-256-gcm'

function keyBytes(): Buffer {
  const buf = Buffer.from(config.encryptionKey, 'base64')
  if (buf.length !== 32) {
    throw new Error('ENCRYPTION_KEY must decode to 32 bytes (base64)')
  }
  return buf
}

export function encryptSecret(plain: string): string {
  if (!plain) return ''
  const iv = randomBytes(12)
  const cipher = createCipheriv(ALGO, keyBytes(), iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`
}

export function decryptSecret(payload: string): string {
  if (!payload) return ''
  const [ivB64, tagB64, dataB64] = payload.split('.')
  if (!ivB64 || !tagB64 || !dataB64) return ''
  const decipher = createDecipheriv(ALGO, keyBytes(), Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  const dec = Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ])
  return dec.toString('utf8')
}
