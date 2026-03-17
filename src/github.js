import {create_github_client} from './github/client.js'
import strategy from './strategy.js'
import {genId, mkErr, selfId} from './utils.js'

const defaultBasePath = '__trystero__'
const defaultSignalBranch = 'trystero-signals'
const defaultPollIntervalMs = 15_000
const defaultPresenceTtlMs = 300_000

const joinPath = (...parts) => parts.filter(Boolean).join('/')

const encodeContent = value =>
  Buffer.from(JSON.stringify(value, null, 2), 'utf8').toString('base64')

const decodeContent = content =>
  JSON.parse(Buffer.from(content, 'base64').toString('utf8'))

const isNotFound = error => error?.status === 404

const ensureSignalBranch = async (gh, owner, repo, branch) => {
  try {
    await gh.rest.git.getRef({owner, repo, ref: `heads/${branch}`})
    return
  } catch (error) {
    if (!isNotFound(error)) {
      throw error
    }
  }

  const {data: repoData} = await gh.rest.repos.get({owner, repo})
  const {data: refData} = await gh.rest.git.getRef({
    owner,
    repo,
    ref: `heads/${repoData.default_branch}`
  })

  try {
    await gh.rest.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${branch}`,
      sha: refData.object.sha
    })
  } catch (error) {
    if (error?.status !== 422) {
      throw error
    }
  }
}

const listDir = async ({gh, owner, repo, signalBranch}, path) => {
  try {
    const {data} = await gh.rest.repos.getContent({
      owner,
      repo,
      path,
      ref: signalBranch
    })

    return Array.isArray(data) ? data : []
  } catch (error) {
    if (isNotFound(error)) {
      return []
    }

    throw error
  }
}

const readJsonFile = async ({gh, owner, repo, signalBranch}, path) => {
  try {
    const {data} = await gh.rest.repos.getContent({
      owner,
      repo,
      path,
      ref: signalBranch
    })

    if (Array.isArray(data)) {
      return null
    }

    return {
      data: decodeContent(data.content),
      sha: data.sha
    }
  } catch (error) {
    if (isNotFound(error)) {
      return null
    }

    throw error
  }
}

const writeJsonFile = async (
  {gh, owner, repo, signalBranch},
  path,
  data,
  message,
  sha
) => {
  const body = {
    owner,
    repo,
    path,
    message,
    content: encodeContent(data),
    branch: signalBranch
  }

  if (sha) {
    body.sha = sha
  }

  await gh.rest.repos.createOrUpdateFileContents(body)
}

const deleteFile = async ({gh, owner, repo, signalBranch}, path, message) => {
  const existing = await readJsonFile({gh, owner, repo, signalBranch}, path)

  if (!existing) {
    return
  }

  try {
    await gh.rest.repos.deleteFile({
      owner,
      repo,
      path,
      message,
      sha: existing.sha,
      branch: signalBranch
    })
  } catch (error) {
    if (!isNotFound(error) && error?.status !== 409) {
      throw error
    }
  }
}

const parseRepo = appId => {
  const [owner, repo, ...rest] = appId.split('/')

  if (!owner || !repo || rest.length) {
    throw mkErr(
      `config.appId must use the format "owner/repo" (received "${appId}")`
    )
  }

  return {owner, repo}
}

const roomPath = (basePath, rootTopic) => joinPath(basePath, rootTopic)

const presencePath = (basePath, rootTopic, selfTopic) =>
  joinPath(roomPath(basePath, rootTopic), `@${selfTopic}.json`)

const inboxPath = (basePath, rootTopic, selfTopic) =>
  joinPath(roomPath(basePath, rootTopic), selfTopic)

const isFreshPresence = (payload, now, ttlMs) =>
  !!payload?.peerId &&
  typeof payload.ts === 'number' &&
  now - payload.ts <= ttlMs

export const joinRoom = strategy({
  init: async config => {
    const {owner, repo} = parseRepo(config.appId)
    const signalBranch = config.signalBranch || defaultSignalBranch
    const gh = create_github_client(config.token)

    await ensureSignalBranch(gh, owner, repo, signalBranch)

    return {
      gh,
      owner,
      repo,
      basePath: config.basePath || defaultBasePath,
      signalBranch,
      pollIntervalMs: config.pollIntervalMs || defaultPollIntervalMs,
      presenceTtlMs: config.presenceTtlMs || defaultPresenceTtlMs
    }
  },

  subscribe: (client, rootTopic, selfTopic, onMessage) => {
    const seenPresence = new Set()
    const seenSignals = new Set()
    const rootDir = roomPath(client.basePath, rootTopic)
    const selfPresencePath = presencePath(client.basePath, rootTopic, selfTopic)
    const selfInboxPath = inboxPath(client.basePath, rootTopic, selfTopic)
    let stopped = false
    let isPolling = false

    const signalPeer = async (peerTopic, signal) => {
      const path = joinPath(
        inboxPath(client.basePath, rootTopic, peerTopic),
        `${selfTopic}_${genId(8)}.json`
      )

      await writeJsonFile(client, path, signal, `signal ${rootTopic}:${peerTopic}`)
    }

    const pollOnce = async () => {
      if (stopped || isPolling) {
        return
      }

      isPolling = true

      try {
        const now = Date.now()
        const occupants = await listDir(client, rootDir)

        for (const item of occupants) {
          if (stopped || item.type !== 'file' || !item.name.startsWith('@')) {
            continue
          }

          if (seenPresence.has(item.path)) {
            continue
          }

          const payload = await readJsonFile(client, item.path)

          if (!payload) {
            seenPresence.add(item.path)
            continue
          }

          if (!isFreshPresence(payload.data, now, client.presenceTtlMs)) {
            seenPresence.add(item.path)
            await deleteFile(client, item.path, `prune presence ${item.name}`)
            continue
          }

          seenPresence.add(item.path)
          onMessage(rootTopic, payload.data, signalPeer)
        }

        const signals = await listDir(client, selfInboxPath)

        for (const item of signals) {
          if (stopped || item.type !== 'file' || !item.name.endsWith('.json')) {
            continue
          }

          if (seenSignals.has(item.path)) {
            continue
          }

          const payload = await readJsonFile(client, item.path)

          seenSignals.add(item.path)

          if (!payload) {
            continue
          }

          onMessage(selfTopic, payload.data, signalPeer)
          await deleteFile(client, item.path, `delete signal ${item.name}`)
        }
      } finally {
        isPolling = false
      }
    }

    pollOnce().catch(console.warn)

    const timer = setInterval(() => {
      pollOnce().catch(console.warn)
    }, client.pollIntervalMs)

    return async () => {
      stopped = true
      clearInterval(timer)
      await deleteFile(client, selfPresencePath, `leave room ${rootTopic}`)
    }
  },

  announce: async (client, rootTopic, selfTopic) => {
    const path = presencePath(client.basePath, rootTopic, selfTopic)
    const existing = await readJsonFile(client, path)

    await writeJsonFile(
      client,
      path,
      {peerId: selfId, ts: Date.now()},
      `announce ${rootTopic}`,
      existing?.sha
    )

    return client.pollIntervalMs
  }
})

export {selfId}