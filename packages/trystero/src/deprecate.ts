export default (subpath: string, directPackage: string): never => {
  throw new Error(
    `Importing from "trystero/${subpath}" is deprecated. Install and import from "${directPackage}" instead.`
  )
}
