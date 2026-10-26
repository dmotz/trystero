// Physical data frames include the optional overlay header around an action frame.
export const maxActionFrameBytes = 16 * 1024
export const maxOverlayHeaderBytes = 1024
export const maxRoomFrameBytes = maxActionFrameBytes + maxOverlayHeaderBytes
export const maxQueuedDataFrames = 64
export const pendingDataTimeoutMs = 10_000
export const transferTimeoutMs = 120_000
