import commonJs from '@rollup/plugin-commonjs'
import replace from '@rollup/plugin-replace'
import resolve from '@rollup/plugin-node-resolve'
import terser from '@rollup/plugin-terser'

const config = {
  output: {
    compact: true,
    dir: 'dist',
    entryFileNames: 'trystero-[name].min.js',
    format: 'es'
  },
  plugins: [
    resolve({browser: true}),
    commonJs(),
    replace({
      'process.env.NODE_ENV': JSON.stringify('production'),
      preventAssignment: true
    }),
    terser({
      compress: {
        ecma: 2015,
        drop_console: ['log', 'info'],
        keep_fargs: false,
        module: true,
        toplevel: true,
        unsafe: true,
        unsafe_arrows: true,
        unsafe_methods: true,
        unsafe_proto: true,
        unsafe_symbols: true
      },
      format: {ecma: 2015, comments: false},
      mangle: {module: true, toplevel: true}
    })
  ]
}

export default ['firebase', 'ipfs', 'mqtt', 'nostr', 'torrent'].map(name => ({
  ...config,
  input: `src/${name}.js`
}))
