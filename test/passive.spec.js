import {test, expect} from '@playwright/test'
import chalk from 'chalk'

// Passive mode tests need longer timeout due to waiting for connections
test.setTimeout(120_000)

const testUrl = 'https://localhost:8080/test'
const proxy = process.env.PROXY

const logPrefix = (strategy, browser, pageN) =>
  `${emojis[strategy]} ${colorize[pageN - 1](strategy)} ${shortBrowsers[browser]}${pageN}:`

const onConsole = (strategy, browser, pageN) => msg =>
  console.log(logPrefix(strategy, browser, pageN), msg)

const onError = (strategy, browser, pageN) => err =>
  console.log('❌', logPrefix(strategy, browser, pageN), err)

const colorize = ['magenta', 'yellow', 'blue', 'red', 'green', 'cyan'].map(
  k => chalk[k]
)

const sleep = ms => new Promise(res => setTimeout(res, ms))

const defaultRelayRedundancy = 2

const strategyConfigs = {
  mqtt: {},
  nostr: {},
  torrent: {},
  firebase: {appId: 'trystero-94db3.firebaseio.com'},
  ipfs: {},
  supabase: {
    appId: 'https://vdhmuvvhbnjkrrappkgi.supabase.co',
    supabaseKey:
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZkaG11dnZoYm5qa3JyYXBwa2dpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Mzg0Mzk0NDIsImV4cCI6MjA1NDAxNTQ0Mn0.u8IdjGafCKXFzR4iMfbyTBoQ99stdco5lyxBxtSulbs'
  }
}

// Skip ipfs and supabase - they have general connectivity issues unrelated to passive mode
const strategies = Object.keys(strategyConfigs).filter(
  s => s !== 'ipfs' && s !== 'supabase'
)

// Wait times for "becomes active" test - must be longer than announce interval
const becomeActiveWaitMs = {
  mqtt: 8000,
  nostr: 8000,
  torrent: 40000, // torrent has 33s announce interval
  firebase: 8000,
  ipfs: 15000,
  supabase: 8000
}

const emojis = {
  nostr: '🐦',
  mqtt: '📡',
  torrent: '🌊',
  supabase: '⚡️',
  firebase: '🔥',
  ipfs: '🪐'
}

const shortBrowsers = {
  chromium: chalk.green('CH'),
  webkit: chalk.blue('WK'),
  firefox: chalk.yellow('FF')
}

for (const strategy of strategies) {
  test(`Passive mode: ${strategy} - passive peer connects with active peer`, async ({
    page,
    browser,
    browserName
  }) => {
    console.log(
      `  🔇   ${shortBrowsers[browserName]}: ${emojis[strategy]} ${strategy} passive mode`
    )

    const scriptUrl = `../dist/trystero-${strategy}.min.js`
    const context = await browser.newContext(
      proxy ? {proxy: {server: 'http://' + proxy, bypass: 'localhost'}} : {}
    )
    const page2 = await context.newPage()

    page.on('console', onConsole(strategy, browserName, 1))
    page2.on('console', onConsole(strategy, browserName, 2))
    page.on('pageerror', onError(strategy, browserName, 1))
    page2.on('pageerror', onError(strategy, browserName, 2))

    await page.goto(testUrl)
    await page2.goto(testUrl)

    const loadLib = async path => (window.trystero = await import(path))

    await page.evaluate(loadLib, scriptUrl)
    await page2.evaluate(loadLib, scriptUrl)

    const isRelayStrategy =
      strategy === 'torrent' || strategy === 'nostr' || strategy === 'mqtt'

    const roomConfig = {
      appId: `trystero-passive-test-${Math.random()}`,
      password: 'p@ssw0rd' + Math.random(),
      ...(isRelayStrategy ? {relayRedundancy: defaultRelayRedundancy} : {}),
      ...strategyConfigs[strategy]
    }

    const roomNs = `passiveRoom-${Math.random().toString().replace('.', '')}`

    const getSelfId = () => window.trystero.selfId
    const selfId1 = await page.evaluate(getSelfId)
    const selfId2 = await page2.evaluate(getSelfId)

    // Page 1 joins as PASSIVE
    const joinPassive = ([roomId, config]) => {
      window[roomId] = window.trystero.joinRoom({...config, passive: true}, roomId)
      return new Promise(res => window[roomId].onPeerJoin(res))
    }

    // Page 2 joins as ACTIVE (default)
    const joinActive = ([roomId, config]) => {
      window[roomId] = window.trystero.joinRoom(config, roomId)
      return new Promise(res => window[roomId].onPeerJoin(res))
    }

    const args = [roomNs, roomConfig]
    const start = Date.now()

    // Passive peer joins first, then active peer
    // The active peer should initiate the connection
    const passiveJoinPromise = page.evaluate(joinPassive, args)

    // Give passive peer time to join before active peer
    await sleep(2000)

    const activeJoinPromise = page2.evaluate(joinActive, args)

    const [passivePeerId, activePeerId] = await Promise.all([
      passiveJoinPromise,
      activeJoinPromise
    ])

    const joinTime = Date.now() - start

    // Verify both peers see each other
    expect(passivePeerId).toEqual(selfId2)
    expect(activePeerId).toEqual(selfId1)

    // Verify messaging works
    const makeAction = ([roomId, message]) => {
      const [sendMessage, getMessage] = window[roomId].makeAction('message')
      return new Promise(res => {
        getMessage(res)
        setTimeout(() => sendMessage(message), 333)
      })
    }

    const message1 = 'from-passive-' + Math.random()
    const message2 = 'from-active-' + Math.random()

    const [receivedByPassive, receivedByActive] = await Promise.all([
      page.evaluate(makeAction, [roomNs, message1]),
      page2.evaluate(makeAction, [roomNs, message2])
    ])

    expect(receivedByPassive).toEqual(message2)
    expect(receivedByActive).toEqual(message1)

    console.log(
      '  ✅   ',
      `${shortBrowsers[browserName]}:`,
      emojis[strategy],
      `${strategy} passive`.padEnd(18, ' '),
      `${joinTime}ms`
    )
  })

  test(`Passive mode: ${strategy} - passive peer becomes active after receiving offer`, async ({
    page,
    browser,
    browserName
  }) => {
    console.log(
      `  🔄   ${shortBrowsers[browserName]}: ${emojis[strategy]} ${strategy} passive->active`
    )

    const scriptUrl = `../dist/trystero-${strategy}.min.js`
    const context = await browser.newContext(
      proxy ? {proxy: {server: 'http://' + proxy, bypass: 'localhost'}} : {}
    )
    const page2 = await context.newPage()
    const page3 = await context.newPage()

    page.on('console', onConsole(strategy, browserName, 1))
    page2.on('console', onConsole(strategy, browserName, 2))
    page3.on('console', onConsole(strategy, browserName, 3))
    page.on('pageerror', onError(strategy, browserName, 1))
    page2.on('pageerror', onError(strategy, browserName, 2))
    page3.on('pageerror', onError(strategy, browserName, 3))

    await Promise.all([
      page.goto(testUrl),
      page2.goto(testUrl),
      page3.goto(testUrl)
    ])

    const loadLib = async path => (window.trystero = await import(path))

    await Promise.all([
      page.evaluate(loadLib, scriptUrl),
      page2.evaluate(loadLib, scriptUrl),
      page3.evaluate(loadLib, scriptUrl)
    ])

    const isRelayStrategy =
      strategy === 'torrent' || strategy === 'nostr' || strategy === 'mqtt'

    const roomConfig = {
      appId: `trystero-passive-active-test-${Math.random()}`,
      password: 'p@ssw0rd' + Math.random(),
      ...(isRelayStrategy ? {relayRedundancy: defaultRelayRedundancy} : {}),
      ...strategyConfigs[strategy]
    }

    const roomNs = `passiveActiveRoom-${Math.random().toString().replace('.', '')}`

    const getSelfId = () => window.trystero.selfId
    const selfId1 = await page.evaluate(getSelfId)
    const selfId2 = await page2.evaluate(getSelfId)
    const selfId3 = await page3.evaluate(getSelfId)

    // Page 1 joins as PASSIVE
    const joinPassive = ([roomId, config]) => {
      window[roomId] = window.trystero.joinRoom({...config, passive: true}, roomId)
      window.peerJoins = []
      window[roomId].onPeerJoin(id => window.peerJoins.push(id))
      return 'joined'
    }

    // Page 2 and 3 join as ACTIVE
    const joinActive = ([roomId, config]) => {
      window[roomId] = window.trystero.joinRoom(config, roomId)
      window.peerJoins = []
      window[roomId].onPeerJoin(id => window.peerJoins.push(id))
      return 'joined'
    }

    const args = [roomNs, roomConfig]

    // Step 1: Passive peer (page1) joins first
    await page.evaluate(joinPassive, args)
    await sleep(2000)

    // Step 2: First active peer (page2) joins and connects to passive peer
    await page2.evaluate(joinActive, args)

    // Wait for connection between page1 and page2
    const waitTime = becomeActiveWaitMs[strategy]
    await sleep(waitTime)

    const page1PeersAfterPage2 = await page.evaluate(() => window.peerJoins)
    const page2PeersAfterJoin = await page2.evaluate(() => window.peerJoins)

    expect(page1PeersAfterPage2).toContain(selfId2)
    expect(page2PeersAfterJoin).toContain(selfId1)

    // Step 3: Second active peer (page3) joins
    // If passive peer became active, it should now be able to connect to page3
    await page3.evaluate(joinActive, args)

    // Wait for connections - need to wait for announce cycle
    await sleep(waitTime)

    const page1PeersAfterPage3 = await page.evaluate(() => window.peerJoins)
    const page3PeersAfterJoin = await page3.evaluate(() => window.peerJoins)

    // Page 1 (originally passive) should now see page 3
    // This verifies that page1 became active and can initiate connections
    expect(page1PeersAfterPage3).toContain(selfId3)
    expect(page3PeersAfterJoin).toContain(selfId1)

    console.log(
      '  ✅   ',
      `${shortBrowsers[browserName]}:`,
      emojis[strategy],
      `${strategy} passive->active`.padEnd(18, ' ')
    )
  })

  test(`Passive mode: ${strategy} - two passive peers don't connect without active peer`, async ({
    page,
    browser,
    browserName
  }) => {
    console.log(
      `  🚫   ${shortBrowsers[browserName]}: ${emojis[strategy]} ${strategy} two passive`
    )

    const scriptUrl = `../dist/trystero-${strategy}.min.js`
    const context = await browser.newContext(
      proxy ? {proxy: {server: 'http://' + proxy, bypass: 'localhost'}} : {}
    )
    const page2 = await context.newPage()

    page.on('console', onConsole(strategy, browserName, 1))
    page2.on('console', onConsole(strategy, browserName, 2))
    page.on('pageerror', onError(strategy, browserName, 1))
    page2.on('pageerror', onError(strategy, browserName, 2))

    await page.goto(testUrl)
    await page2.goto(testUrl)

    const loadLib = async path => (window.trystero = await import(path))

    await page.evaluate(loadLib, scriptUrl)
    await page2.evaluate(loadLib, scriptUrl)

    const isRelayStrategy =
      strategy === 'torrent' || strategy === 'nostr' || strategy === 'mqtt'

    const roomConfig = {
      appId: `trystero-two-passive-test-${Math.random()}`,
      password: 'p@ssw0rd' + Math.random(),
      ...(isRelayStrategy ? {relayRedundancy: defaultRelayRedundancy} : {}),
      ...strategyConfigs[strategy]
    }

    const roomNs = `twoPassiveRoom-${Math.random().toString().replace('.', '')}`

    // Both pages join as PASSIVE
    const joinPassive = ([roomId, config]) => {
      window[roomId] = window.trystero.joinRoom({...config, passive: true}, roomId)
      window.peerJoined = false
      window[roomId].onPeerJoin(() => {
        window.peerJoined = true
      })
      return 'joined'
    }

    const args = [roomNs, roomConfig]

    await page.evaluate(joinPassive, args)
    await page2.evaluate(joinPassive, args)

    // Wait some time - they should NOT connect
    await sleep(8000)

    const page1Connected = await page.evaluate(() => window.peerJoined)
    const page2Connected = await page2.evaluate(() => window.peerJoined)

    // Two passive peers should not be able to connect to each other
    // because neither sends offers
    expect(page1Connected).toBe(false)
    expect(page2Connected).toBe(false)

    console.log(
      '  ✅   ',
      `${shortBrowsers[browserName]}:`,
      emojis[strategy],
      `${strategy} two passive (no connect)`.padEnd(18, ' ')
    )
  })

  test(`Passive mode: ${strategy} - passive peer returns to passive after active peer disconnects`, async ({
    page,
    browser,
    browserName
  }) => {
    // Skip for non-torrent strategies as they may retain presence (ghosts)
    // causing false positives for this specific behavioral check
    if (strategy !== 'torrent') {
      test.skip()
    }

    console.log(
      `  🔄   ${shortBrowsers[browserName]}: ${emojis[strategy]} ${strategy} passive return to passive`
    )

    const scriptUrl = `../dist/trystero-${strategy}.min.js`
    const context = await browser.newContext(
      proxy ? {proxy: {server: 'http://' + proxy, bypass: 'localhost'}} : {}
    )
    const page2 = await context.newPage()
    const page3 = await context.newPage()

    page.on('console', onConsole(strategy, browserName, 1))
    page2.on('console', onConsole(strategy, browserName, 2))
    page3.on('console', onConsole(strategy, browserName, 3))

    await Promise.all([
      page.goto(testUrl),
      page2.goto(testUrl),
      page3.goto(testUrl)
    ])

    const loadLib = async path => (window.trystero = await import(path))

    await Promise.all([
      page.evaluate(loadLib, scriptUrl),
      page2.evaluate(loadLib, scriptUrl),
      page3.evaluate(loadLib, scriptUrl)
    ])

    const isRelayStrategy =
      strategy === 'torrent' || strategy === 'nostr' || strategy === 'mqtt'

    const roomConfig = {
      appId: `trystero-return-passive-test-${Math.random()}`,
      password: 'p@ssw0rd' + Math.random(),
      ...(isRelayStrategy ? {relayRedundancy: defaultRelayRedundancy} : {}),
      ...strategyConfigs[strategy]
    }

    const roomNs = `returnPassiveRoom-${Math.random().toString().replace('.', '')}`

    // Page 1 and 3 are PASSIVE
    const joinPassive = ([roomId, config]) => {
      window[roomId] = window.trystero.joinRoom({...config, passive: true}, roomId)
      window.peerJoins = []
      window[roomId].onPeerJoin(id => window.peerJoins.push(id))
      window[roomId].onPeerLeave(id => window.peerJoins = window.peerJoins.filter(p => p !== id))
      return 'joined'
    }

    // Page 2 is ACTIVE
    const joinActive = ([roomId, config]) => {
      window[roomId] = window.trystero.joinRoom(config, roomId)
      return 'joined'
    }

    const args = [roomNs, roomConfig]

    // 1. Passive 1 joins
    await page.evaluate(joinPassive, args)
    await sleep(1000)

    // 2. Active 1 (page2) joins
    await page2.evaluate(joinActive, args)

    // Wait for connection
    await sleep(becomeActiveWaitMs[strategy])
    
    // Verify connection happened
    const p1Joins = await page.evaluate(() => window.peerJoins.length)
    expect(p1Joins).toBe(1)

    // 3. Active 1 leaves gracefully
    await page2.evaluate(([roomId]) => window[roomId].leave(), args)

    // Wait for disconnect detection (should be fast with explicit leave)
    await sleep(2000)
    
    const p1JoinsAfterLeave = await page.evaluate(() => window.peerJoins.length)
    expect(p1JoinsAfterLeave).toBe(0)

    // 4. Passive 2 (page3) joins
    await page3.evaluate(joinPassive, args)

    // Wait to ensure they DO NOT connect
    await sleep(becomeActiveWaitMs[strategy])

    const p1JoinsFinal = await page.evaluate(() => window.peerJoins.length)
    const p3JoinsFinal = await page3.evaluate(() => window.peerJoins.length)

    // Should be 0 if Passive 1 correctly returned to passive mode
    // If it stayed active, it would connect to Passive 2
    expect(p1JoinsFinal).toBe(0)
    expect(p3JoinsFinal).toBe(0)

    console.log(
      '  ✅   ',
      `${shortBrowsers[browserName]}:`,
      emojis[strategy],
      `${strategy} return to passive`.padEnd(18, ' ')
    )
  })
}
