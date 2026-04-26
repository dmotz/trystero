import {devices} from '@playwright/test'

const minPort = 10_000
const maxPort = 60_000
const configuredPort = Number(process.env['TRYSTERO_TEST_PORT'])
const testPort =
  Number.isInteger(configuredPort) &&
  configuredPort >= minPort &&
  configuredPort <= 65_535
    ? configuredPort
    : Math.floor(Math.random() * (maxPort - minPort + 1)) + minPort
const testUrl = `https://localhost:${testPort}/test`
const randomPort = (except: number[] = []): number => {
  let port = testPort

  while (except.includes(port)) {
    port = Math.floor(Math.random() * (maxPort - minPort + 1)) + minPort
  }

  return port
}
const configuredWsRelayPorts = (process.env['TRYSTERO_WS_RELAY_PORTS'] ?? '')
  .split(',')
  .map(Number)
  .filter(port => Number.isInteger(port) && port >= minPort && port <= 65_535)
const wsRelayPorts =
  configuredWsRelayPorts.length > 0
    ? configuredWsRelayPorts
    : [randomPort([testPort])]

if (wsRelayPorts.length === 1) {
  wsRelayPorts.push(randomPort([testPort, ...wsRelayPorts]))
}

process.env['TRYSTERO_TEST_PORT'] = String(testPort)
process.env['TRYSTERO_WS_RELAY_PORTS'] = wsRelayPorts.join(',')
process.env['TRYSTERO_WS_RELAY_URLS'] = wsRelayPorts
  .map(port => `wss://localhost:${port}`)
  .join(',')

export default {
  timeout: 53_333,
  reporter: [['list'], ['./test/connection-timing-reporter.ts']],
  use: {
    ignoreHTTPSErrors: true,
    headless: true,
    launchOptions: {
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--disable-features=WebRtcHideLocalIpsWithMdns',
        '--disable-setuid-sandbox',
        '--no-sandbox'
      ],
      firefoxUserPrefs: {
        'media.navigator.permission.disabled': true,
        'media.navigator.streams.fake': true,
        'media.peerconnection.ice.obfuscate_host_addresses': false
      }
    }
  },
  projects: [
    {
      name: 'chromium',
      use: {...devices['Desktop Chrome']}
    },
    {
      name: 'firefox',
      use: {...devices['Desktop Firefox']}
    },
    {
      name: 'webkit',
      use: {...devices['Desktop Safari']}
    }
  ],
  webServer: [
    {
      command: `TRYSTERO_WS_RELAY_PORTS=${wsRelayPorts.join(',')} pnpm exec jiti scripts/start-ws-relay.ts`,
      port: wsRelayPorts[0],
      name: 'ws-relay'
    },
    {
      command: `serve -p ${testPort} --ssl-cert ./test/certs/cert.pem --ssl-key ./test/certs/key.pem`,
      url: testUrl,
      ignoreHTTPSErrors: true,
      name: 'serve'
    }
  ]
}
