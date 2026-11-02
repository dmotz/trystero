import {ecdsaSign} from './crypto'
import {
  generateNonExtractableIdbRecord,
  verifyUserIdKey,
  verifyWithP256
} from './identity'
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

const buildUserIdentityFromIdbRecord = (
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

const idbGetRecord = (
  db: IDBDatabase,
  appId: string
): Promise<StoredIdbIdentityRecord | undefined> =>
  new Promise((resolve, reject) => {
    const tx = db.transaction(idbStoreName, 'readonly')
    const store = tx.objectStore(idbStoreName)
    const req = store.get(appId)
    req.onsuccess = () =>
      resolve(req.result as StoredIdbIdentityRecord | undefined)
    req.onerror = () => reject(req.error ?? idbGetErr)
  })

const isValidStoredIdbRecord = async (
  rec: StoredIdbIdentityRecord | undefined
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

const idbPutRecord = (
  db: IDBDatabase,
  appId: string,
  candidate: StoredIdbIdentityRecord
): Promise<StoredIdbIdentityRecord> =>
  new Promise((resolve, reject) => {
    const tx = db.transaction(idbStoreName, 'readwrite')
    const putReq = tx.objectStore(idbStoreName).put(candidate, appId)
    putReq.onsuccess = () => resolve(candidate)
    putReq.onerror = () => reject(putReq.error ?? idbErr('put'))
  })

const idbAddOrGetRecord = (
  db: IDBDatabase,
  appId: string,
  candidate: StoredIdbIdentityRecord
): Promise<StoredIdbIdentityRecord> =>
  new Promise((resolve, reject) => {
    const tx = db.transaction(idbStoreName, 'readwrite')
    const store = tx.objectStore(idbStoreName)
    const getReq = store.get(appId)
    getReq.onsuccess = () => {
      const existing = getReq.result as StoredIdbIdentityRecord | undefined
      if (existing !== undefined) {
        isValidStoredIdbRecord(existing).then(valid => {
          if (valid) {
            resolve(existing)
          } else {
            idbPutRecord(db, appId, candidate).then(resolve, reject)
          }
        }, reject)
        return
      }
      const addReq = store.add(candidate, appId)
      addReq.onsuccess = () => resolve(candidate)
      addReq.onerror = event => {
        event?.preventDefault?.()
        // ConstraintError from concurrent tab: read winner in a fresh readonly tx
        idbGetRecord(db, appId).then(winner => {
          if (!winner) {
            reject(addReq.error ?? idbErr('add'))
            return
          }
          isValidStoredIdbRecord(winner).then(valid => {
            if (valid) {
              resolve(winner)
            } else {
              idbPutRecord(db, appId, candidate).then(resolve, reject)
            }
          }, reject)
        }, reject)
      }
    }
    getReq.onerror = () => reject(getReq.error ?? idbGetErr)
  })

const idbDeleteRecord = (db: IDBDatabase, appId: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const tx = db.transaction(idbStoreName, 'readwrite')
    const delReq = tx.objectStore(idbStoreName).delete(appId)
    delReq.onsuccess = () => resolve()
    delReq.onerror = () => reject(delReq.error ?? idbErr('delete'))
  })

const withNavigatorLock = async <T>(
  lockName: string,
  fn: () => Promise<T>
): Promise<T> => {
  const nav =
    typeof navigator !== 'undefined'
      ? (navigator as {
          locks?: {
            request?: <R>(name: string, cb: () => Promise<R>) => Promise<R>
          }
        })
      : undefined
  return nav?.locks && typeof nav.locks.request === 'function'
    ? nav.locks.request(lockName, fn)
    : fn()
}

export const loadOrCreateIdbIdentity = (
  idbKey: string
): Promise<UserIdentity> =>
  withNavigatorLock(`${storagePrefix}${idbKey}`, async () => {
    const db = await openIdentityDb()
    try {
      const existing = await idbGetRecord(db, idbKey)
      if (existing !== undefined) {
        if (await isValidStoredIdbRecord(existing)) {
          return buildUserIdentityFromIdbRecord(existing)
        }
        const repaired = await generateNonExtractableIdbRecord()
        return buildUserIdentityFromIdbRecord(
          await idbPutRecord(db, idbKey, repaired)
        )
      }
      const candidate = await generateNonExtractableIdbRecord()
      return buildUserIdentityFromIdbRecord(
        await idbAddOrGetRecord(db, idbKey, candidate)
      )
    } finally {
      db.close()
    }
  })

export const deleteIdbIdentity = (appId: string): Promise<void> =>
  withNavigatorLock(`${storagePrefix}${appId}`, async () => {
    const db = await openIdentityDb()
    try {
      await idbDeleteRecord(db, appId)
    } finally {
      db.close()
    }
  })
