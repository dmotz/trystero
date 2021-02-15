#!/usr/bin/env bash

for name in firebase torrent
do
  echo $name $(echo "import {joinRoom} from './src/$name'; joinRoom()" \
    | rollup --silent -p node-resolve | terser -cm | wc -c)
done
