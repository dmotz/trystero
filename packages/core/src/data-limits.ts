// Physical data frames include the room envelope around an action frame.
export const maxActionFrameBytes = 16 * 1024
export const maxRoomTokenBytes = 128
export const maxRoomFrameBytes = maxActionFrameBytes + 3 + maxRoomTokenBytes
export const maxQueuedDataFrames = 64
export const pendingDataTimeoutMs = 10_000
export const transferTimeoutMs = 120_000
