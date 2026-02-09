export default ['firebase', 'ipfs', 'mqtt', 'nostr', 'supabase', 'torrent'].map(
  name => ({
    input: `src/${name}.js`,
    output: {
      format: 'es',
      minify: !process.env.NO_MINIFY,
      sourcemap: true,
      codeSplitting: false,
      file: `dist/trystero-${name}.min.js`
    }
  })
)
