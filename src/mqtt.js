import mqtt from 'mqtt'
import strategy from './strategy.js'
import {getRelays, selfId, toJson} from './utils.js'

const defaultRelayUrls = [
  'wss://test.mosquitto.org:8081',
  'wss://mqtt.eclipseprojects.io/mqtt',
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://public.mqtthq.com:8084/mqtt'
]

const sockets = {}
const defaultRedundancy = 5
const msgHandlers = {}

export const joinRoom = strategy({
  init: config =>
    getRelays(config, defaultRelayUrls, defaultRedundancy).map(url => {
      const client = mqtt.connect(url)

      sockets[url] = client.stream.socket
      msgHandlers[url] = {}

      client.on('message', (topic, buffer) => {
        if (msgHandlers[url][topic]) {
          msgHandlers[url][topic](topic, buffer.toString())
        }
      })

      return new Promise(res => client.on('connect', () => res(client)))
    }),

  subscribe: (client, rootTopic, selfTopic, onMessage) => {
    const url = client.options.href

    msgHandlers[url][rootTopic] = msgHandlers[url][selfTopic] = (topic, data) =>
      onMessage(topic, data, client.publish.bind(client))

    client.subscribe(rootTopic)
    client.subscribe(selfTopic)
    client.publish(rootTopic, toJson({peerId: selfId}))

    return () => {
      client.unsubscribe(rootTopic)
      client.unsubscribe(selfTopic)
      delete msgHandlers[url][rootTopic]
      delete msgHandlers[url][selfTopic]
    }
  }
})

export const getRelaySockets = () => ({...sockets})

export {selfId} from './utils.js'
