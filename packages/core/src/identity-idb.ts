import {ecdsaSign} from './crypto'
import {domainTag, encodeBytes, libId, mkErr} from './primitives'
import type {UserIdentity} from './types'
import {unreachable} from './utils'

export type StoredIdbIdentityRecord = {
  userId: string
  signPubJwk: JsonWebKey
  privateKey: CryptoKey
}

const lockPrefix = `${libId}:user_identity:v1:`
const idbDbName = `${libId}_identity_v1`
const idbStoreName = 'identities'
const idbErr = (op: string): Error => mkErr(`IndexedDB ${op} failed`)
const idbProbeBytes = /*@__PURE__*/ encodeBytes(domainTag('idb-key-probe', 1))

export const buildUserIdentityFromIdbRecord = (
  rec: StoredIdbIdentityRecord
): UserIdentity => ({
  userId: rec.userId,
  signPubJwk: rec.signPubJwk,
  sign: (payload: Uint8Array) =>
    ecdsaSign(rec.privateKey, payload as BufferSource)
})

const openIdentityDb = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const req = indexedDB.open(idbDbName, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(idbStoreName)) {
        db.createObjectStore(idbStoreName)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? idbErr('open'))
  })

const idbGetRecord = (
  db: IDBDatabase,
  appId: string
): Promise<StoredIdbIdentityRecord | undefined> =>
  new Promise((resolve, reject) => {
    const tx = db.transaction(idbStoreName, 'readonly')
    const req = tx.objectStore(idbStoreName).get(appId)
    req.onsuccess = () =>
      resolve(req.result as StoredIdbIdentityRecord | undefined)
    req.onerror = () => reject(req.error ?? idbErr('get'))
  })

type TxState<T> =
  | {readonly phase: 'pending'}
  | {readonly phase: 'staged'; readonly value: T}
  | {readonly phase: 'done'}

const idbWriteTx = <T>(
  db: IDBDatabase,
  run: (store: IDBObjectStore, setResult: (val: T) => void) => void,
  op: string
): Promise<T> =>
  new Promise((resolve, reject) => {
    const tx = db.transaction(idbStoreName, 'readwrite')
    let state: TxState<T>

    const stageResult = (value: T): void => {
      switch (state.phase) {
        case 'pending':
        case 'staged':
          state = {phase: 'staged', value}
          return
        case 'done':
          return
        default:
          unreachable(state)
      }
    }

    const fail = (err: unknown): void => {
      switch (state.phase) {
        case 'pending':
        case 'staged':
          state = {phase: 'done'}
          reject(err instanceof Error ? err : (tx.error ?? idbErr(op)))
          return
        case 'done':
          return
        default:
          unreachable(state)
      }
    }

    state = {phase: 'pending'}

    tx.oncomplete = () => {
      switch (state.phase) {
        case 'staged': {
          const {value} = state
          state = {phase: 'done'}
          resolve(value)
          return
        }
        case 'pending':
          state = {phase: 'done'}
          reject(idbErr(op))
          return
        case 'done':
          return
        default:
          unreachable(state)
      }
    }
    tx.onabort = () => fail(tx.error)
    tx.onerror = event =>
      fail((event?.target as IDBRequest | null)?.error ?? tx.error)

    try {
      run(tx.objectStore(idbStoreName), stageResult)
    } catch (err) {
      fail(err)
    }
  })

const idbPutRecord = (
  db: IDBDatabase,
  appId: string,
  candidate: StoredIdbIdentityRecord
): Promise<StoredIdbIdentityRecord> =>
  idbWriteTx(
    db,
    (store, setResult) => {
      setResult(candidate)
      store.put(candidate, appId)
    },
    'put'
  )

const checkThenAddIdbRecord = (
  db: IDBDatabase,
  idbKey: string,
  candidate: StoredIdbIdentityRecord
): Promise<readonly [record: StoredIdbIdentityRecord, wasExisting: boolean]> =>
  idbWriteTx(
    db,
    (store, setResult) => {
      const getReq = store.get(idbKey)
      getReq.onsuccess = () => {
        const found = getReq.result as StoredIdbIdentityRecord | undefined
        if (found !== undefined) {
          setResult([found, true])
          return
        }
        setResult([candidate, false])
        store.add(candidate, idbKey)
      }
    },
    'add'
  )

const isValidStoredIdbRecord = async (
  rec: StoredIdbIdentityRecord | undefined,
  verifyUserIdKey: (
    userId: string,
    pubKey: JsonWebKey
  ) => boolean | Promise<boolean>,
  verifyWithP256: (
    sig: Uint8Array,
    payload: Uint8Array,
    pubKey: JsonWebKey
  ) => boolean | Promise<boolean>
): Promise<boolean> => {
  if (
    !rec ||
    typeof rec !== 'object' ||
    !rec.userId ||
    !rec.signPubJwk ||
    !rec.privateKey ||
    !(await verifyUserIdKey(rec.userId, rec.signPubJwk))
  ) {
    return false
  }
  try {
    const sig = await ecdsaSign(rec.privateKey, idbProbeBytes as BufferSource)
    return await verifyWithP256(sig, idbProbeBytes, rec.signPubJwk)
  } catch {
    return false
  }
}

const withNavigatorLock = async <T>(
  appId: string,
  fn: (db: IDBDatabase) => Promise<T>
): Promise<T> => {
  const lockName = `${lockPrefix}${appId}`
  const run = async (): Promise<T> => {
    const db = await openIdentityDb()
    try {
      return await fn(db)
    } finally {
      db.close()
    }
  }
  const locks =
    typeof navigator !== 'undefined'
      ? (
          navigator as {
            locks?: {
              request?: <R>(name: string, cb: () => Promise<R>) => Promise<R>
            }
          }
        ).locks
      : undefined
  return typeof locks?.request === 'function'
    ? locks.request(lockName, run)
    : run()
}

export const loadOrCreateIdbIdentity = (
  idbKey: string,
  generateRecord: () => Promise<StoredIdbIdentityRecord>,
  verifyUserIdKey: (
    userId: string,
    pubKey: JsonWebKey
  ) => boolean | Promise<boolean>,
  verifyWithP256: (
    sig: Uint8Array,
    payload: Uint8Array,
    pubKey: JsonWebKey
  ) => boolean | Promise<boolean>
): Promise<UserIdentity> =>
  withNavigatorLock(idbKey, async db => {
    const validateOrRepair = async (
      rec: StoredIdbIdentityRecord
    ): Promise<StoredIdbIdentityRecord> =>
      (await isValidStoredIdbRecord(rec, verifyUserIdKey, verifyWithP256))
        ? rec
        : idbPutRecord(db, idbKey, await generateRecord())

    const existing = await idbGetRecord(db, idbKey)
    if (existing !== undefined) {
      return buildUserIdentityFromIdbRecord(await validateOrRepair(existing))
    }

    const candidate = await generateRecord()
    const [record, wasExisting] = await checkThenAddIdbRecord(
      db,
      idbKey,
      candidate
    )
    return buildUserIdentityFromIdbRecord(
      wasExisting ? await validateOrRepair(record) : record
    )
  })

export const deleteIdbIdentity = (appId: string): Promise<void> =>
  withNavigatorLock(appId, db =>
    idbWriteTx<void>(
      db,
      (store, setResult) => {
        setResult(undefined)
        store.delete(appId)
      },
      'delete'
    )
  )
