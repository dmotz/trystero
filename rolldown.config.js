const config = {
  format: 'es',
  minify: !process.env.NO_MINIFY,
  sourcemap: true,
  codeSplitting: false
}

export default ['firebase', 'ipfs', 'mqtt', 'nostr', 'supabase', 'torrent'].map(
  name => ({
    input: `src/${name}.js`,
    output: {
      ...config,
      file: `dist/trystero-${name}.min.js`
    }
  })
)
