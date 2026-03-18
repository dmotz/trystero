import {devices} from '@playwright/test'

/** Perf-only config: one project per strategy so each runs in its own worker (fresh Chrome, resets RTCPeerConnection limit). */
export default {
  timeout: 53_333,
  reporter: [
    ['list'],
    ['./scripts/perf-trickle-summary-reporter.js']
  ],
  use: {
    ignoreHTTPSErrors: true,
    headless: true,
    launchOptions: {
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--disable-setuid-sandbox',
        '--no-sandbox'
      ]
    }
  },
  // One project per strategy; each project matches exactly one spec file so each
  // runs in its own worker (fresh Chrome, resets RTCPeerConnection limit).
  projects: [
    {
      name: 'perf-firebase',
      testMatch: /perf-trickle-firebase\.spec\.js/,
      use: {...devices['Desktop Chrome']}
    },
    {
      name: 'perf-mqtt',
      testMatch: /perf-trickle-mqtt\.spec\.js/,
      use: {...devices['Desktop Chrome']}
    },
    {
      name: 'perf-nostr',
      testMatch: /perf-trickle-nostr\.spec\.js/,
      use: {...devices['Desktop Chrome']}
    },
    {
      name: 'perf-torrent',
      testMatch: /perf-trickle-torrent\.spec\.js/,
      use: {...devices['Desktop Chrome']}
    }
  ],
  webServer: {
    command:
      'serve -p 8080 --ssl-cert ./test/certs/cert.pem --ssl-key ./test/certs/key.pem',
    url: 'https://localhost:8080/test',
    ignoreHTTPSErrors: true
  }
}
