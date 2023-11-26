#!/usr/bin/env bash

mkdir -p dist
for name in torrent firebase ipfs
do
  rollup src/$name.js -p 'node-resolve={browser: true}' -p commonjs --format es |
  terser -cm --comments false > dist/trystero-$name.min.js
done
