type TestAny = any

declare global {
  interface Window {
    [key: string]: TestAny
    trystero: TestAny
    __streamSwitchLocalStream?: MediaStream
  }
}

export {}
