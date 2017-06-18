const request = require('request')
const _ = require('lodash')
const url = require('url')
const Promise = require('bluebird')
const {HttpsAgent} = require('agentkeepalive')
const PNG = require('pngjs').PNG

const {getCapabilities} = require('./src/wmts-parser')

const baseUrl = 'https://julkinen.liikennevirasto.fi/rasteripalvelu/service/wmts'
const layer = 'liikennevirasto:Merikarttasarjojen erikoiskartat public'

const emptyTileLengths = [662, 658]

const stopAfterZoom = 9

const keepaliveAgent = new HttpsAgent({maxSockets: 50})

getCapabilities(baseUrl)
  .then(capabilities => _.find(capabilities.layers, l => l.id === layer))
  .then(layer => {
    startFetching(layer)
  })

// pruned because of png transparent/white 3, 4, 2
const tileQueue = []
function startFetching(layer) {
  const startTileSet = layer.epsg3395.tileSets[0]
  for (let y = startTileSet.minTileRow; y <= startTileSet.maxTileRow; y++ ) {
    for (let x = startTileSet.minTileColumn; x <= startTileSet.maxTileColumn; x++ ) {
      tileQueue.push([startTileSet.zoom, x, y])
      console.log('starting with', startTileSet.zoom, x, y)
    }
  }
  doFetch(layer)
}

function doFetch(layer) {
  if (tileQueue.length === 0) {
    return
  }

  const tile = tileQueue.shift()
  if (tile[0] > stopAfterZoom) {
    console.log('Stopping search because next tile to reach is at level', tile[0])
    console.log('tiles that should still contain stuff:')
    console.log(tileQueue)
    const tileSet = _.find(layer.epsg3395.tileSets, set => set.zoom === stopAfterZoom + 1)
    console.log('Naive getter would fetch', (tileSet.maxTileRow - tileSet.minTileRow + 1) * (tileSet.maxTileColumn - tileSet.minTileColumn + 1),
      'tiles at zoom', stopAfterZoom + 1)
    console.log('We would only fetch', tileQueue.length, 'tiles at zoom', stopAfterZoom + 1)
    return
  }

  fetchSingleTile(layer, tile[0], tile[1], tile[2]).then(result => {
    if (isEmptyTile(result.data)) {
      console.log('pruning at', tile[0], ',', tile[1], ',', tile[2])
    } else {
      addToQueue([tile[0] + 1, tile[1] * 2, tile[2] * 2])
      addToQueue([tile[0] + 1, tile[1] * 2 + 1, tile[2] * 2])
      addToQueue([tile[0] + 1, tile[1] * 2, tile[2] * 2 + 1])
      addToQueue([tile[0] + 1, tile[1] * 2 + 1, tile[2] * 2 + 1])
    }
    doFetch(layer)
  })
}

function isEmptyTile(tileData) {
  if (!tileData.length) {
    return true
  }
  if (emptyTileLengths.indexOf(tileData.length) !== -1) {
    return true
  }
  const image = PNG.sync.read(tileData)
  for (var index = 0; index < image.data.length; index += 4) {
    if (image.data[index + 3] === 0) {
      continue
    }
    if (image.data[index] === 255 && image.data[index + 1] === 255 && image.data[index + 2] === 255) {
      continue
    }
    return false
  }
  return true
}

function addToQueue(tile) {
  tileQueue.push(tile)
}

function fetchSingleTile(layer, zoom, column, row) {
  const correctTileSet = _.find(layer.epsg3395.tileSets, set => set.zoom === zoom)
  if (row < correctTileSet.minTileRow || row > correctTileSet.maxTileRow ||
      column < correctTileSet.minTileColumn || column > correctTileSet.maxTileColumn) {
    return Promise.resolve({data: {}})
  }
  const tileUrl = createTileUrl({
    baseUrl,
    layerId: layer.id,
    format: layer.format,
    matrixSetId: layer.epsg3395.id,
    tileSetId: correctTileSet.id,
    row: row,
    column: column
  })

  return new Promise((resolve, reject) => {
    request({uri: tileUrl, agent: keepaliveAgent, encoding: null}, (error, response, body) => {
      if (error) {
        return reject(error)
      }
      if (!response) {
        return reject(`No response?`)
      }
      if (response.statusCode !== 200) {
        return reject(`Response ${response.statusCode}`)
      }
      resolve({z: zoom, y: row, x: column, data: response.body})
    })
  })
}

function createTileUrl({layerId, matrixSetId, tileSetId, row, column}) {
  const format = 'image/png'
  const params = {
    layer: layerId,
    style: '',
    tilematrixset: matrixSetId,
    Service: 'WMTS',
    Request: 'GetTile',
    Version: '1.0.0',
    Format: format,
    TileMatrix: tileSetId,
    TileCol: column,
    TileRow: row
  }
  const wmtsBase = url.parse(baseUrl)
  const tileUrl = url.format(_.extend(wmtsBase, {query: params}))
  return tileUrl
}