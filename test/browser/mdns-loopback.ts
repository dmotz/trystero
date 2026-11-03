import type {Page} from '@playwright/test'

export const installLoopbackMdnsInWindow = (): void => {
  const NativePeerConnection = window.RTCPeerConnection
  if (!NativePeerConnection) {
    return
  }

  const rewriteMdns = (sdp: string): string =>
    sdp.replace(/ (\S+\.local) (\d+) typ host/g, ' 127.0.0.1 $2 typ host')

  const wrapIceEvent = (event: Event): Event => {
    const iceEvent = event as RTCPeerConnectionIceEvent
    const orig = iceEvent.candidate
    if (!orig || typeof orig.candidate !== 'string') {
      return event
    }
    const candidateStr = rewriteMdns(orig.candidate)
    if (candidateStr === orig.candidate) {
      return event
    }
    const wrappedCandidate = {
      candidate: candidateStr,
      sdpMid: orig.sdpMid,
      sdpMLineIndex: orig.sdpMLineIndex,
      usernameFragment: orig.usernameFragment,
      toJSON: () => ({
        ...(typeof orig.toJSON === 'function' ? orig.toJSON() : {}),
        candidate: candidateStr,
        sdpMid: orig.sdpMid,
        sdpMLineIndex: orig.sdpMLineIndex,
        usernameFragment: orig.usernameFragment
      })
    }
    return Object.assign(new Event(event.type), {candidate: wrappedCandidate})
  }

  const iceHandlers = new WeakMap<
    RTCPeerConnection,
    ((this: RTCPeerConnection, ev: RTCPeerConnectionIceEvent) => unknown) | null
  >()
  const listenerMaps = new WeakMap<
    RTCPeerConnection,
    WeakMap<EventListenerOrEventListenerObject, EventListener>
  >()
  const getListenerMap = (
    pc: RTCPeerConnection
  ): WeakMap<EventListenerOrEventListenerObject, EventListener> => {
    let map = listenerMaps.get(pc)
    if (!map) {
      map = new WeakMap()
      listenerMaps.set(pc, map)
    }
    return map
  }

  class LoopbackMdnsPeerConnection extends NativePeerConnection {
    override get localDescription(): RTCSessionDescription | null {
      const desc = super.localDescription
      if (!desc) {
        return null
      }
      const sdp = rewriteMdns(desc.sdp)
      return {
        type: desc.type,
        sdp,
        toJSON: () => ({type: desc.type, sdp})
      }
    }

    override get onicecandidate():
      | ((this: RTCPeerConnection, ev: RTCPeerConnectionIceEvent) => unknown)
      | null {
      return iceHandlers.get(this) ?? null
    }

    override set onicecandidate(
      handler:
        | ((this: RTCPeerConnection, ev: RTCPeerConnectionIceEvent) => unknown)
        | null
    ) {
      iceHandlers.set(this, handler)
      super.onicecandidate = handler
        ? ev =>
            handler.call(this, wrapIceEvent(ev) as RTCPeerConnectionIceEvent)
        : null
    }

    override addEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions
    ): void {
      if (type !== 'icecandidate' || !listener) {
        if (options === undefined) {
          super.addEventListener(
            type,
            listener as EventListenerOrEventListenerObject
          )
        } else {
          super.addEventListener(
            type,
            listener as EventListenerOrEventListenerObject,
            options
          )
        }
        return
      }
      const map = getListenerMap(this)
      let wrapped = map.get(listener)
      if (!wrapped) {
        wrapped = ev => {
          const nextEv = wrapIceEvent(ev)
          if (typeof listener === 'function') {
            listener.call(this, nextEv)
          } else {
            listener.handleEvent(nextEv)
          }
        }
        map.set(listener, wrapped)
      }
      if (options === undefined) {
        super.addEventListener(type, wrapped)
      } else {
        super.addEventListener(type, wrapped, options)
      }
    }

    override removeEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | EventListenerOptions
    ): void {
      const wrapped = listener ? getListenerMap(this).get(listener) : undefined
      if (options === undefined) {
        super.removeEventListener(
          type,
          (wrapped ?? listener) as EventListenerOrEventListenerObject
        )
      } else {
        super.removeEventListener(
          type,
          (wrapped ?? listener) as EventListenerOrEventListenerObject,
          options
        )
      }
    }

    override setRemoteDescription(
      description: RTCSessionDescriptionInit
    ): Promise<void> {
      return super.setRemoteDescription(
        description?.sdp
          ? {...description, sdp: rewriteMdns(description.sdp)}
          : description
      )
    }

    override addIceCandidate(
      candidate?: RTCIceCandidateInit | null
    ): Promise<void> {
      if (
        candidate &&
        typeof candidate === 'object' &&
        typeof candidate.candidate === 'string'
      ) {
        return super.addIceCandidate({
          ...candidate,
          candidate: rewriteMdns(candidate.candidate)
        })
      }
      return super.addIceCandidate(candidate ?? undefined)
    }
  }

  window.RTCPeerConnection = LoopbackMdnsPeerConnection
}

export const installLoopbackMdnsPeerConnection = async (
  page: Page
): Promise<void> => {
  await page.addInitScript(installLoopbackMdnsInWindow)
}
