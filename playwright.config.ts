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

process.env['TRYSTERO_TEST_PORT'] = String(testPort)

export default {
  timeout: 53_333,
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
  webServer: {
    command: `serve -p ${testPort} --ssl-cert ./test/certs/cert.pem --ssl-key ./test/certs/key.pem`,
    url: testUrl,
    ignoreHTTPSErrors: true
  }
}
