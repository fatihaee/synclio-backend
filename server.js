const express = require('express')
const cors = require('cors')
const axios = require('axios')
const app = express()
app.use(cors())
app.use(express.json())

const keys = {}
const cache = {}

function generateKey() {
  return Math.random().toString(36).substring(2, 10).toUpperCase()
}

async function xtreamGet(server, username, password, action, extra = '') {
  const cacheKey = `${server}${action}${extra}`
  if (cache[cacheKey] && Date.now() - cache[cacheKey].time < 10 * 60 * 1000) {
    return cache[cacheKey].data
  }
  const url = `${server}/player_api.php?username=${username}&password=${password}&action=${action}${extra}`
  const resp = await axios.get(url, { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } })
  cache[cacheKey] = { data: resp.data, time: Date.now() }
  return resp.data
}

app.post('/api/generate-key', (req, res) => {
  const { server, username, password } = req.body
  if (!server || !username || !password) return res.status(400).json({ error: 'Server, username and password required' })
  const key = generateKey()
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000)
  keys[key] = { server, username, password, expiresAt }
  console.log('Key created: ' + key)
  res.json({ key, expiresAt })
})

app.get('/:key/manifest.json', (req, res) => {
  const config = keys[req.params.key]
  if (!config) return res.status(404).json({ error: 'Invalid key' })
  if (new Date() > new Date(config.expiresAt)) return res.status(403).json({ error: 'Key expired' })
  res.json({
    id: 'com.synclio.' + req.params.key,
    version: '1.0.0',
    name: 'Synclio IPTV',
    description: 'Your personal IPTV in Stremio',
    resources: ['catalog', 'meta', 'stream'],
    types: ['tv', 'movie', 'series'],
    catalogs: [
      { type: 'movie', id: 'synclio-movies', name: '🎬 Movies', extra: [{ name: 'genre', isRequired: false }, { name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] },
      { type: 'series', id: 'synclio-series', name: '📺 Series', extra: [{ name: 'genre', isRequired: false }, { name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] },
      { type: 'tv', id: 'synclio-live', name: '📡 Live TV', extra: [{ name: 'genre', isRequired: false }, { name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] }
    ],
    behaviorHints: { configurable: false }
  })
})

// MOVIES CATALOG - now fetches ALL movies and uses TMDB id when available
app.get('/:key/catalog/movie/synclio-movies.json', async (req, res) => {
  const config = keys[req.params.key]
  if (!config) return res.json({ metas: [] })
  try {
    const { genre, search, skip } = req.query
    let movies
    if (genre) {
      movies = await xtreamGet(config.server, config.username, config.password, 'get_vod_streams', `&category_id=${genre}`)
    } else {
      // Fetch ALL movies so nothing is missed
      movies = await xtreamGet(config.server, config.username, config.password, 'get_vod_streams', '')
    }
    if (!Array.isArray(movies)) return res.json({ metas: [] })
    if (search) movies = movies.filter(m => m.name.toLowerCase().includes(search.toLowerCase()))
    if (skip) movies = movies.slice(Number(skip))
    res.json({
      metas: movies.slice(0, 200).map(m => {
        // Use TMDB id as stremio id when available — this lets Stremio match posters/metadata automatically
        const stremioId = m.tmdb
          ? 'tt' + m.tmdb
          : 'synclio_vod_' + m.stream_id + '_' + (m.container_extension || 'mkv')
        return {
          id: stremioId,
          type: 'movie',
          name: m.name,
          poster: m.stream_icon || '',
          background: m.stream_icon || '',
          year: m.year || '',
          description: m.plot || '',
          genres: [m.category_name || 'Movies']
        }
      })
    })
  } catch (e) {
    console.error('Movies catalog error:', e.message)
    res.json({ metas: [] })
  }
})

// SERIES CATALOG
app.get('/:key/catalog/series/synclio-series.json', async (req, res) => {
  const config = keys[req.params.key]
  if (!config) return res.json({ metas: [] })
  try {
    const { genre, search, skip } = req.query
    let series
    if (genre) {
      series = await xtreamGet(config.server, config.username, config.password, 'get_series', `&category_id=${genre}`)
    } else {
      series = await xtreamGet(config.server, config.username, config.password, 'get_series', '')
    }
    if (!Array.isArray(series)) return res.json({ metas: [] })
    if (search) series = series.filter(s => s.name.toLowerCase().includes(search.toLowerCase()))
    if (skip) series = series.slice(Number(skip))
    res.json({
      metas: series.slice(0, 200).map(s => ({
        id: 'synclio_series_' + s.series_id,
        type: 'series',
        name: s.name,
        poster: s.cover || '',
        background: s.backdrop_path?.[0] || s.cover || '',
        year: s.year || '',
        description: s.plot || '',
        genres: [s.genre || 'Series']
      }))
    })
  } catch (e) {
    console.error('Series catalog error:', e.message)
    res.json({ metas: [] })
  }
})

// LIVE TV CATALOG
app.get('/:key/catalog/tv/synclio-live.json', async (req, res) => {
  const config = keys[req.params.key]
  if (!config) return res.json({ metas: [] })
  try {
    const { genre, search, skip } = req.query
    let channels
    if (genre) {
      channels = await xtreamGet(config.server, config.username, config.password, 'get_live_streams', `&category_id=${genre}`)
    } else {
      const categories = await xtreamGet(config.server, config.username, config.password, 'get_live_categories')
      const firstCat = categories[0]?.category_id
      channels = await xtreamGet(config.server, config.username, config.password, 'get_live_streams', `&category_id=${firstCat}`)
    }
    if (!Array.isArray(channels)) return res.json({ metas: [] })
    if (search) channels = channels.filter(c => c.name.toLowerCase().includes(search.toLowerCase()))
    if (skip) channels = channels.slice(Number(skip))
    res.json({
      metas: channels.slice(0, 200).map(c => ({
        id: 'synclio_live_' + c.stream_id,
        type: 'tv',
        name: c.name,
        poster: c.stream_icon || '',
        background: c.stream_icon || '',
        genres: [c.category_name || 'Live TV']
      }))
    })
  } catch (e) {
    console.error('Live catalog error:', e.message)
    res.json({ metas: [] })
  }
})

// META
app.get('/:key/meta/:type/:id.json', async (req, res) => {
  const config = keys[req.params.key]
  if (!config) return res.json({ meta: null })
  try {
    const { type, id } = req.params

    if (type === 'movie') {
      if (id.startsWith('synclio_vod_')) {
        const parts = id.replace('synclio_vod_', '').split('_')
        const streamId = parts[0]
        const info = await xtreamGet(config.server, config.username, config.password, 'get_vod_info', `&vod_id=${streamId}`)
        const m = info.info || {}
        return res.json({ meta: { id, type: 'movie', name: m.name || id, poster: m.movie_image || '', background: m.backdrop_path || m.movie_image || '', description: m.plot || '', year: m.releasedate?.slice(0, 4) || '', genres: [m.genre || 'Movies'] } })
      } else if (id.startsWith('tt')) {
        // TMDB id — find matching movie in provider
        const allMovies = await xtreamGet(config.server, config.username, config.password, 'get_vod_streams', '')
        const tmdbId = id.replace('tt', '')
        const match = allMovies.find(m => String(m.tmdb) === String(tmdbId))
        if (match) {
          return res.json({ meta: { id, type: 'movie', name: match.name, poster: match.stream_icon || '', background: match.stream_icon || '' } })
        }
        return res.json({ meta: null })
      }

    } else if (type === 'series') {
      const seriesId = id.replace('synclio_series_', '')
      const info = await xtreamGet(config.server, config.username, config.password, 'get_series_info', `&series_id=${seriesId}`)
      const s = info.info || {}
      const videos = []
      if (info.episodes) {
        Object.keys(info.episodes).forEach(season => {
          info.episodes[season].forEach(ep => {
            videos.push({
              id: 'synclio_ep_' + ep.id + '_' + (ep.container_extension || 'mkv'),
              title: ep.title || `Episode ${ep.episode_num}`,
              season: Number(season),
              episode: ep.episode_num,
              released: ep.added ? new Date(ep.added * 1000).toISOString() : ''
            })
          })
        })
      }
      return res.json({ meta: { id, type: 'series', name: s.name || id, poster: s.cover || '', background: s.backdrop_path?.[0] || s.cover || '', description: s.plot || '', year: s.releaseDate?.slice(0, 4) || '', genres: [s.genre || 'Series'], videos } })

    } else {
      const streamId = id.replace('synclio_live_', '')
      const channels = await xtreamGet(config.server, config.username, config.password, 'get_live_streams', '')
      const ch = channels.find(c => String(c.stream_id) === String(streamId))
      return res.json({ meta: { id, type: 'tv', name: ch?.name || id, poster: ch?.stream_icon || '', background: ch?.stream_icon || '' } })
    }

  } catch (e) {
    console.error('Meta error:', e.message)
    res.json({ meta: null })
  }
})

// STREAM
app.get('/:key/stream/:type/:id.json', async (req, res) => {
  const config = keys[req.params.key]
  if (!config) return res.json({ streams: [] })
  try {
    const { type, id } = req.params
    let url

    if (type === 'movie') {
      if (id.startsWith('synclio_vod_')) {
        const parts = id.replace('synclio_vod_', '').split('_')
        const streamId = parts[0]
        const ext = parts[1] || 'mkv'
        url = `${config.server}/movie/${config.username}/${config.password}/${streamId}.${ext}`
      } else if (id.startsWith('tt')) {
        // TMDB tt ID — search all VOD for matching movie
        const allMovies = await xtreamGet(config.server, config.username, config.password, 'get_vod_streams', '')
        const tmdbId = id.replace('tt', '')
        const match = allMovies.find(m => String(m.tmdb) === String(tmdbId))
        if (match) {
          const ext = match.container_extension || 'mkv'
          url = `${config.server}/movie/${config.username}/${config.password}/${match.stream_id}.${ext}`
        } else {
          console.log('No VOD match found for TMDB id:', tmdbId)
          return res.json({ streams: [] })
        }
      }

    } else if (type === 'series') {
      const parts = id.replace('synclio_ep_', '').split('_')
      const epId = parts[0]
      const ext = parts[1] || 'mkv'
      url = `${config.server}/series/${config.username}/${config.password}/${epId}.${ext}`

    } else {
      const streamId = id.replace('synclio_live_', '')
      url = `${config.server}/live/${config.username}/${config.password}/${streamId}.m3u8`
    }

    console.log('Stream URL:', url)
    res.json({ streams: [{ url, title: 'Synclio Stream', behaviorHints: { notWebReady: false } }] })

  } catch (e) {
    console.error('Stream error:', e.message)
    res.json({ streams: [] })
  }
})

const PORT = process.env.PORT || 3001
app.listen(PORT, () => console.log('Synclio backend running on port ' + PORT))
