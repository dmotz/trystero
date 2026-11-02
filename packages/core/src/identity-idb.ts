import {ecdsaSign} from './crypto'
import {encodeBytes, libId, mkErr} from './primitives'
import type {UserIdentity} from './types'

export type StoredIdbIdentityRecord = {
  userId: string
  publicKey: string
  signPubJwk: JsonWebKey
  privateKey: CryptoKey
}

const storagePrefix = `${libId}:user_identity:v1:`
const idbDbName = `${libId}_identity_v1`
const idbStoreName = 'identities'
const idbErr = (op: string): Error => mkErr(`IndexedDB ${op} failed`)
const idbGetErr = /*@__PURE__*/ idbErr('get')
const idbProbeBytes = /*@__PURE__*/ encodeBytes(`${libId}:idb-key-probe:v1`)

export const buildUserIdentityFromIdbRecord = (
  rec: StoredIdbIdentityRecord
): UserIdentity => ({
  userId: rec.userId,
  publicKey: rec.publicKey,
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

const idbTxReq = <T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest,
  op: string
): Promise<T> =>
  new Promise((resolve, reject) => {
    const req = run(
      db.transaction(idbStoreName, mode).objectStore(idbStoreName)
    )
    req.onsuccess = () => resolve(req.result as T)
    req.onerror = () => reject(req.error ?? idbErr(op))
  })

const idbGetRecord = (
  db: IDBDatabase,
  appId: string
): Promise<StoredIdbIdentityRecord | undefined> =>
  idbTxReq(db, 'readonly', s => s.get(appId), 'get')

const idbPutRecord = (
  db: IDBDatabase,
  appId: string,
  candidate: StoredIdbIdentityRecord
): Promise<StoredIdbIdentityRecord> =>
  idbTxReq(db, 'readwrite', s => s.put(candidate, appId), 'put').then(
    () => candidate
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
  const lockName = `${storagePrefix}${appId}`
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
    const ensureValid = async (
      rec: StoredIdbIdentityRecord,
      fallback?: StoredIdbIdentityRecord
    ): Promise<StoredIdbIdentityRecord> =>
      (await isValidStoredIdbRecord(rec, verifyUserIdKey, verifyWithP256))
        ? rec
        : idbPutRecord(db, idbKey, fallback ?? (await generateRecord()))

    const existing = await idbGetRecord(db, idbKey)
    if (existing !== undefined) {
      return buildUserIdentityFromIdbRecord(await ensureValid(existing))
    }
    const candidate = await generateRecord()
    const resolved = await new Promise<StoredIdbIdentityRecord>(
      (resolve, reject) => {
        const store = db
          .transaction(idbStoreName, 'readwrite')
          .objectStore(idbStoreName)
        const settleExisting = (rec: StoredIdbIdentityRecord): void => {
          ensureValid(rec, candidate).then(resolve, reject)
        }
        const getReq = store.get(idbKey)
        getReq.onsuccess = () => {
          const found = getReq.result as StoredIdbIdentityRecord | undefined
          if (found !== undefined) {
            settleExisting(found)
            return
          }
          const addReq = store.add(candidate, idbKey)
          addReq.onsuccess = () => resolve(candidate)
          addReq.onerror = event => {
            event?.preventDefault?.()
            idbGetRecord(db, idbKey).then(
              winner =>
                winner
                  ? settleExisting(winner)
                  : reject(addReq.error ?? idbErr('add')),
              reject
            )
          }
        }
        getReq.onerror = () => reject(getReq.error ?? idbGetErr)
      }
    )
    return buildUserIdentityFromIdbRecord(resolved)
  })

export const deleteIdbIdentity = (appId: string): Promise<void> =>
  withNavigatorLock(appId, db =>
    idbTxReq<void>(db, 'readwrite', s => s.delete(appId), 'delete')
  )
