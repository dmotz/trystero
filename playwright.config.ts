import {rmSync} from 'node:fs'
import {createServer} from 'node:net'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {devices} from '@playwright/test'

const minPort = 10_000

const getFreePort = async (exclude: number[] = []): Promise<number> => {
  for (;;) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer()
      server.unref()
      server.once('error', reject)
      server.listen(0, () => {
        const address = server.address()
        const allocated =
          address && typeof address === 'object' ? address.port : 0
        server.close(err => (err ? reject(err) : resolve(allocated)))
      })
    })
    if (port >= minPort && !exclude.includes(port)) {
      return port
    }
  }
}

const configuredPort = Number(process.env['TRYSTERO_TEST_PORT'])
const testPort =
  Number.isInteger(configuredPort) &&
  configuredPort >= minPort &&
  configuredPort <= 65_535
    ? configuredPort
    : await getFreePort()

const testUrl = `https://127.0.0.1:${testPort}/test`
const defaultCompletionLogPath = join(
  tmpdir(),
  `trystero-test-completions-${process.cwd().replaceAll(/\W/g, '_')}.jsonl`
)
const configuredWsRelayPorts = (process.env['TRYSTERO_WS_RELAY_PORTS'] ?? '')
  .split(',')
  .map(Number)
  .filter(port => Number.isInteger(port) && port >= minPort && port <= 65_535)
const wsRelayPorts =
  configuredWsRelayPorts.length > 0
    ? [...configuredWsRelayPorts]
    : [await getFreePort([testPort])]

if (wsRelayPorts.length === 1) {
  wsRelayPorts.push(await getFreePort([testPort, ...wsRelayPorts]))
}

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
if (!process.env['TEST_WORKER_INDEX']) {
  rmSync(process.env['TRYSTERO_DIAGNOSTIC_LOG_PATH'], {force: true})
  rmSync(process.env['TRYSTERO_TEST_COMPLETION_LOG_PATH'], {force: true})
  rmSync(defaultCompletionLogPath, {force: true})
}

export default {
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
