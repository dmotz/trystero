import mqtt from 'mqtt'
import strategy from './strategy.js'
import {getRelays, selfId, toJson} from './utils.js'

const sockets = {}
const defaultRedundancy = 4
const msgHandlers = {}
const getClientId = ({options}) => options.host + options.path

export const joinRoom = strategy({
  init: config =>
    getRelays(config, defaultRelayUrls, defaultRedundancy).map(url => {
      const client = mqtt.connect(url)
      const clientId = getClientId(client)

      sockets[clientId] = client.stream.socket
      msgHandlers[clientId] = {}

      client
        .on('message', (topic, buffer) =>
          msgHandlers[clientId][topic]?.(topic, buffer.toString())
        )
        .on('error', err => console.error(err))

      return new Promise(res => client.on('connect', () => res(client)))
    }),

  subscribe: (client, rootTopic, selfTopic, onMessage) => {
    const clientId = getClientId(client)

    msgHandlers[clientId][rootTopic] = msgHandlers[clientId][selfTopic] = (
      topic,
      data
    ) => onMessage(topic, data, client.publish.bind(client))

    client.subscribe(rootTopic)
    client.subscribe(selfTopic)

    return () => {
      client.unsubscribe(rootTopic)
      client.unsubscribe(selfTopic)
      delete msgHandlers[clientId][rootTopic]
      delete msgHandlers[clientId][selfTopic]
    }
  },

  announce: (client, rootTopic) =>
    client.publish(rootTopic, toJson({peerId: selfId}))
})

export const getRelaySockets = () => ({...sockets})

export {selfId} from './utils.js'

export const defaultRelayUrls = [
  'test.mosquitto.org:8081/mqtt',
  'broker.emqx.io:8084/mqtt',
  'broker.hivemq.com:8884/mqtt'
].map(url => 'wss://' + url)
