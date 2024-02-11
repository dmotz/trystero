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
      compress: {drop_console: ['log', 'info']},
      format: {comments: false}
    })
  ]
}

export default ['firebase', 'ipfs', 'mqtt', 'torrent'].map(name => ({
  ...config,
  input: `src/${name}.js`
}))
