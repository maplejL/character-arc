import { config } from '../src/config.js'
import Fastify from 'fastify'

const bytes = config.bodyLimitMb * 1024 * 1024
console.log('bodyLimitMb', config.bodyLimitMb)
console.log('bytes', bytes, 'isInteger', Number.isInteger(bytes))

const app = Fastify({ logger: false, bodyLimit: bytes })
console.log('fastify initialConfig.bodyLimit', (app as { initialConfig?: { bodyLimit?: number } }).initialConfig?.bodyLimit)

await app.close()
