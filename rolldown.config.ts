const strategies = ['firebase', 'ipfs', 'mqtt', 'nostr', 'supabase', 'torrent']

export default strategies.map(name => ({
  input: `packages/${name}/src/index.ts`,
  transform: {
    dropLabels: process.env['NO_MINIFY'] ? [] : ['DEV']
  },
  output: {
    format: 'es',
    minify: !process.env['NO_MINIFY'],
    sourcemap: true,
    codeSplitting: false,
    file: `dist/trystero-${name}.min.js`
  }
}))
