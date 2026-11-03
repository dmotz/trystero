import type {JsonValue, StrategyMessage} from '@trystero-p2p/core'

export type WsRelayClientMessage<TPayload = JsonValue> =
  | {type: 'subscribe'; topic: string}
  | {type: 'unsubscribe'; topic: string}
  | {type: 'publish'; topic: string; payload: TPayload}

export type WsRelayServerMessage<TPayload = JsonValue> = {
  topic: string
  payload: TPayload
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isPayload = (value: unknown): value is JsonValue =>
  value === null ||
  typeof value === 'string' ||
  typeof value === 'number' ||
  typeof value === 'boolean' ||
  Array.isArray(value) ||
  isRecord(value)

const isStrategyMessage = (value: unknown): value is StrategyMessage =>
  typeof value === 'string' || isRecord(value)

export const parseClientMessage = (
  raw: string
): WsRelayClientMessage | null => {
  try {
    const msg = JSON.parse(raw) as Partial<WsRelayClientMessage>

    if (!isRecord(msg) || typeof msg.topic !== 'string') {
      return null
    }

    if (msg.type === 'subscribe' || msg.type === 'unsubscribe') {
      return {type: msg.type, topic: msg.topic}
    }

    if (msg.type === 'publish' && isPayload(msg.payload)) {
      return {type: 'publish', topic: msg.topic, payload: msg.payload}
    }

    return null
  } catch {
    return null
  }
}

export const parseServerMessage = (
  data: string
): WsRelayServerMessage<StrategyMessage> | null => {
  try {
    const msg = JSON.parse(data) as Partial<
      WsRelayServerMessage<StrategyMessage>
    >

    return typeof msg.topic === 'string' && isStrategyMessage(msg.payload)
      ? {topic: msg.topic, payload: msg.payload}
      : null
  } catch {
    return null
  }
}
