const express = require('express')
const cors = require('cors')
const axios = require('axios')
const PlaylistParser = require('iptv-playlist-parser')
const app = express()
app.use(cors())
app.use(express.json())
const keys = {}
const cache = {}
const tmdbCache = {}
const TMDB_KEY = process.env.TMDB_API_KEY

async function getTMDB(name, type) {
  const cacheKey = name + type
  if (tmdbCache[cacheKey]) return tmdbCache[cacheKey]
  try {
    const searchType = type === 'movie' ? 'movie' : 'tv'
    const clean = name.replace(/\(.*?\)/g, '').replace(/\[.*?\]/g, '').trim()
    const url = `https://api.themoviedb.org/3/search/${searchType}?api_key=${TMDB_KEY}&query=${encodeURIComponent(clean)}`
    const resp = await axios.get(url, { timeout: 5000 })
    const result = resp.data.results[0]
    if (result) {
      const data = {
        poster: result.poster_path ? `https://image.tmdb.org/t/p/w500${result.poster_path}` : '',
        background: result.backdrop_path ? `https://image.tmdb.org/t/p/w1280${result.backdrop_path}` : '',
        description: result.overview || '',
        year: (result.release_date || result.first_air_date || '').slice(0, 4),
        rating: result.vote_average ? result.vote_average.toFixed(1) : ''
      }
      tmdbCache[cacheKey] = data
      return data
    }
  } catch (e) {}
  return null
}

function generateKey() {
  return Math.random().toString(36).substring(2, 10).toUpperCase()
}
app.post('/api/generate-key', (req, res) => {
  const body = req.body
  if (!body.m3uUrl) return res.status(400).json({ error: 'M3U URL required' })
  const key = generateKey()
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000)
  keys[key] = { m3uUrl: body.m3uUrl, expiresAt, plan: 'trial' }
  res.json({ key, expiresAt })
})
async function getChannels(m3uUrl) {
  if (cache[m3uUrl] && Date.now() - cache[m3uUrl].time < 5 * 60 * 1000) {
    return cache[m3uUrl].data
  }
  const resp = await axios.get(m3uUrl, { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } })
  const result = PlaylistParser.parse(resp.data)
  const channels = result.items.map((ch, i) => {
    const name = ch.name || 'Channel ' + i
    const group = ch.group && ch.group.title ? ch.group.title : 'General'
    const groupLower = group.toLowerCase()
    let type = 'tv'
    if (groupLower.includes('movie') || groupLower.includes('film') || groupLower.includes('vod')) type = 'movie'
    else if (groupLower.includes('series') || groupLower.includes('show') || groupLower.includes('episode')) type = 'series'
    return { id: 'synclio_' + Buffer.from(name + i).toString('base64').slice(0, 16), name, logo: ch.tvg && ch.tvg.logo ? ch.tvg.logo : '', group, url: ch.url, type }
  })
  cache[m3uUrl] = { data: channels, time: Date.now() }
  return channels
}
app.get('/:key/manifest.json', (req, res) => {
  const config = keys[req.params.key]
  if (!config) return res.status(404).json({ error: 'Invalid key' })
  if (new Date() > new Date(config.expiresAt)) return res.status(403).json({ error: 'Key expired' })
  res.json({ id: 'com.synclio.' + req.params.key, version: '1.0.0', name: 'Synclio IPTV', description: 'Your personal IPTV playlist in Stremio', resources: ['catalog', 'meta', 'stream'], types: ['tv', 'movie', 'series'], catalogs: [{ type: 'tv', id: 'synclio-live', name: 'Live TV', extra: [{ name: 'genre', isRequired: false }, { name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] }, { type: 'movie', id: 'synclio-movies', name: 'Movies', extra: [{ name: 'genre', isRequired: false }, { name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] }, { type: 'series', id: 'synclio-series', name: 'Series', extra: [{ name: 'genre', isRequired: false }, { name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] }], behaviorHints: { configurable: false } })
})
app.get('/:key/catalog/:type/:id.json', async (req, res) => {
  const config = keys[req.params.key]
  if (!config) return res.json({ metas: [] })
  try {
    let channels = await getChannels(config.m3uUrl)
    const type = req.params.type
    const genre = req.query.genre
    const search = req.query.search
    const skip = req.query.skip
    channels = channels.filter(c => c.type === type)
    if (genre) channels = channels.filter(c => c.group === genre)
    if (search) channels = channels.filter(c => c.name.toLowerCase().includes(search.toLowerCase()))
    if (skip) channels = channels.slice(Number(skip))
    const metas = await Promise.all(channels.slice(0, 200).map(async ch => {
      let poster = ch.logo
      let background = ch.logo
      let description = ''
      let year = ''
      if (type !== 'tv' && TMDB_KEY) {
        const tmdb = await getTMDB(ch.name, type)
        if (tmdb) {
          poster = tmdb.poster || ch.logo
          background = tmdb.background || ch.logo
          description = tmdb.description
          year = tmdb.year
        }
      }
      return { id: ch.id, type: ch.type, name: ch.name, poster, background, description, year, genres: [ch.group] }
    }))
    res.json({ metas })
  } catch (e) {
    console.error(e.message)
    res.json({ metas: [] })
  }
})
app.get('/:key/meta/:type/:id.json', async (req, res) => {
  const config = keys[req.params.key]
  if (!config) return res.json({ meta: null })
  try {
    const channels = await getChannels(config.m3uUrl)
    const ch = channels.find(c => c.id === req.params.id)
    if (!ch) return res.json({ meta: null })
    let poster = ch.logo
    let background = ch.logo
    let description = ''
    let year = ''
    if (req.params.type !== 'tv' && TMDB_KEY) {
      const tmdb = await getTMDB(ch.name, req.params.type)
      if (tmdb) {
        poster = tmdb.poster || ch.logo
        background = tmdb.background || ch.logo
        description = tmdb.description
        year = tmdb.year
      }
    }
    res.json({ meta: { id: ch.id, type: ch.type, name: ch.name, poster, background, description, year, genres: [ch.group] } })
  } catch (e) {
    res.json({ meta: null })
  }
})
app.get('/:key/stream/:type/:id.json', async (req, res) => {
  const config = keys[req.params.key]
  if (!config) return res.json({ streams: [] })
  try {
    const channels = await getChannels(config.m3uUrl)
    const ch = channels.find(c => c.id === req.params.id)
    if (!ch) return res.json({ streams: [] })
    res.json({ streams: [{ url: ch.url, title: ch.name, behaviorHints: { notWebReady: false } }] })
  } catch (e) {
    res.json({ streams: [] })
  }
})
const PORT = process.env.PORT || 3001
app.listen(PORT, () => console.log('Synclio backend running on port ' + PORT))
