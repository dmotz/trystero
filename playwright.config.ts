import {createServer, type Server} from 'node:net'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {devices} from '@playwright/test'

const minPort = 10_000

const getFreePorts = async (
  count: number,
  exclude: number[] = []
): Promise<number[]> => {
  const servers: Server[] = []
  const ports: number[] = []
  const forbidden = new Set(exclude)

  try {
    while (ports.length < count) {
      const {server, port} = await new Promise<{server: Server; port: number}>(
        (resolve, reject) => {
          const s = createServer()
          s.unref()
          s.once('error', reject)
          s.listen(0, () => {
            const address = s.address()
            const allocated =
              address && typeof address === 'object' ? address.port : 0
            resolve({server: s, port: allocated})
          })
        }
      )
      servers.push(server)
      if (port >= minPort && !forbidden.has(port)) {
        forbidden.add(port)
        ports.push(port)
      }
    }
    return ports
  } finally {
    await Promise.all(
      servers.map(s => new Promise<void>(resolve => s.close(() => resolve())))
    )
  }
}

const configuredPort = Number(process.env['TRYSTERO_TEST_PORT'])
const hasValidTestPort =
  Number.isInteger(configuredPort) &&
  configuredPort >= minPort &&
  configuredPort <= 65_535
const configuredWsRelayPorts = (process.env['TRYSTERO_WS_RELAY_PORTS'] ?? '')
  .split(',')
  .map(Number)
  .filter(port => Number.isInteger(port) && port >= minPort && port <= 65_535)

const neededRelayPorts = Math.max(0, 2 - configuredWsRelayPorts.length)
const allocatedPorts = await getFreePorts(
  (hasValidTestPort ? 0 : 1) + neededRelayPorts,
  [...(hasValidTestPort ? [configuredPort] : []), ...configuredWsRelayPorts]
)

const testPort = hasValidTestPort ? configuredPort : allocatedPorts.shift()!
const testUrl = `https://127.0.0.1:${testPort}/test`
const wsRelayPorts = [...configuredWsRelayPorts, ...allocatedPorts]

process.env['TRYSTERO_TEST_PORT'] = String(testPort)
process.env['TRYSTERO_WS_RELAY_PORTS'] = wsRelayPorts.join(',')
process.env['TRYSTERO_WS_RELAY_URLS'] = wsRelayPorts
  .map(port => `wss://localhost:${port}`)
  .join(',')
process.env['TRYSTERO_DIAGNOSTIC_LOG_PATH'] ??= join(
  tmpdir(),
  `trystero-diagnostics-${process.pid}-${Date.now()}.jsonl`
)
process.env['TRYSTERO_TEST_COMPLETION_LOG_PATH'] ??= join(
  tmpdir(),
  `trystero-test-completions-${process.pid}-${Date.now()}.jsonl`
)

export default {
  globalSetup: './test/playwright-global-setup.ts',
  timeout: 53_333,
  testIgnore: '**/node/**',
  reporter: [['list'], ['./test/connection-timing-reporter.ts']],
  use: {
    ignoreHTTPSErrors: true,
    headless: true
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            '--disable-features=WebRtcHideLocalIpsWithMdns',
            '--disable-setuid-sandbox',
            '--no-sandbox'
          ]
        }
      }
    },
    {
      name: 'firefox',
      use: {
        ...devices['Desktop Firefox'],
        launchOptions: {
          firefoxUserPrefs: {
            'media.navigator.permission.disabled': true,
            'media.navigator.streams.fake': true,
            'media.peerconnection.ice.obfuscate_host_addresses': false
          }
        }
      }
    },
    {
      name: 'webkit',
      use: {...devices['Desktop Safari']}
    }
  ],
  webServer: [
    {
      command: `TRYSTERO_WS_RELAY_PORTS=${wsRelayPorts.join(',')} node scripts/start-ws-relay.ts`,
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
