import { z } from 'zod'
import { validTunnelAddress } from './target-policy'

const port = z.number().int().min(0).max(65535)
const address = z.string().refine(validTunnelAddress).nullable()
export const parentMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('start'), port, uid: z.number().int().nonnegative().nullable() }).strict(),
  z.object({ type: z.literal('tunnel'), tunIp: address, dns: address }).strict(),
  z.object({ type: z.literal('stop') }).strict(),
])
export const childMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('listening'), port: port.refine((value) => value > 0) }).strict(),
  z.object({ type: z.literal('error'), code: z.string().regex(/^[A-Z0-9_]{1,64}$/) }).strict(),
])
export type ParentMessage = z.infer<typeof parentMessage>
export type ChildMessage = z.infer<typeof childMessage>
