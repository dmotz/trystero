const config = {
  output: {
    format: 'es',
    minify: !process.env.NO_MINIFY,
    codeSplitting: false
  }
}

export default ['firebase', 'ipfs', 'mqtt', 'nostr', 'supabase', 'torrent'].map(
  name => ({
    ...config,
    input: `src/${name}.js`,
    output: {
      ...config.output,
      file: `dist/trystero-${name}.min.js`
    }
  })
)
