const express = require('express')
const cors = require('cors')
const axios = require('axios')
const app = express()
app.use(cors())
app.use(express.json())

const keys = {}
const cache = {}
const CACHE_TTL = 15 * 60 * 1000 // 15 minutes
const PAGE_SIZE = 100 // items per page sent to Stremio

function generateKey() {
  return Math.random().toString(36).substring(2, 10).toUpperCase()
}

// ─── CACHE HELPER ────────────────────────────────────────────────────────────
async function xtreamGet(server, username, password, action, extra = '') {
  const cacheKey = `${server}|${action}|${extra}`
  if (cache[cacheKey] && Date.now() - cache[cacheKey].time < CACHE_TTL) {
    return cache[cacheKey].data
  }
  const url = `${server}/player_api.php?username=${username}&password=${password}&action=${action}${extra}`
  const resp = await axios.get(url, {
    timeout: 20000,
    headers: { 'User-Agent': 'Mozilla/5.0' }
  })
  cache[cacheKey] = { data: resp.data, time: Date.now() }
  return resp.data
}

// ─── GENERATE KEY ────────────────────────────────────────────────────────────
app.post('/api/generate-key', (req, res) => {
  const { server, username, password } = req.body
  if (!server || !username || !password)
    return res.status(400).json({ error: 'Server, username and password required' })
  const key = generateKey()
  const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000) // 48h
  keys[key] = { server, username, password, expiresAt }
  console.log(`[KEY] Created: ${key}`)
  res.json({ key, expiresAt })
})

// ─── MANIFEST ────────────────────────────────────────────────────────────────
app.get('/:key/manifest.json', (req, res) => {
  const config = keys[req.params.key]
  if (!config) return res.status(404).json({ error: 'Invalid key' })
  if (new Date() > new Date(config.expiresAt))
    return res.status(403).json({ error: 'Key expired' })
  res.json({
    id: 'com.synclio.' + req.params.key,
    version: '2.0.0',
    name: 'Synclio IPTV',
    description: 'Your personal IPTV addon for Stremio',
    resources: ['catalog', 'meta', 'stream'],
    types: ['tv', 'movie', 'series'],
    catalogs: [
      {
        type: 'movie',
        id: 'synclio-movies',
        name: '🎬 Movies',
        extra: [
          { name: 'genre', isRequired: false },
          { name: 'search', isRequired: false },
          { name: 'skip', isRequired: false }
        ]
      },
      {
        type: 'series',
        id: 'synclio-series',
        name: '📺 Series',
        extra: [
          { name: 'genre', isRequired: false },
          { name: 'search', isRequired: false },
          { name: 'skip', isRequired: false }
        ]
      },
      {
        type: 'tv',
        id: 'synclio-live',
        name: '📡 Live TV',
        extra: [
          { name: 'genre', isRequired: false },
          { name: 'search', isRequired: false },
          { name: 'skip', isRequired: false }
        ]
      }
    ],
    behaviorHints: { configurable: false }
  })
})

// ─── MOVIES CATALOG ──────────────────────────────────────────────────────────
// Loads ALL movies from ALL categories with pagination
app.get('/:key/catalog/movie/synclio-movies.json', async (req, res) => {
  const config = keys[req.params.key]
  if (!config) return res.json({ metas: [] })
  try {
    const { genre, search, skip } = req.query
    const skipNum = Number(skip) || 0
    let movies = []

    if (genre) {
      // Load specific category
      movies = await xtreamGet(config.server, config.username, config.password, 'get_vod_streams', `&category_id=${genre}`)
    } else {
      // Load ALL movies from ALL categories (cached so no lag on repeat visits)
      const allMoviesCacheKey = `${config.server}|all_movies`
      if (cache[allMoviesCacheKey] && Date.now() - cache[allMoviesCacheKey].time < CACHE_TTL) {
        movies = cache[allMoviesCacheKey].data
      } else {
        movies = await xtreamGet(config.server, config.username, config.password, 'get_vod_streams', '')
        cache[allMoviesCacheKey] = { data: movies, time: Date.now() }
      }
    }

    if (!Array.isArray(movies)) movies = []

    // Search filter
    if (search) {
      movies = movies.filter(m => m.name.toLowerCase().includes(search.toLowerCase()))
    }

    const total = movies.length
    const page = movies.slice(skipNum, skipNum + PAGE_SIZE)

    res.json({
      metas: page.map(m => ({
        id: m.tmdb ? `tt${m.tmdb}` : `synclio_vod_${m.stream_id}_${m.container_extension || 'mkv'}`,
        type: 'movie',
        name: m.name,
        poster: m.stream_icon || '',
        background: m.stream_icon || '',
        year: m.year || '',
        description: m.plot || '',
        genres: [m.category_name || 'Movies']
      })),
      // Tell Stremio there are more pages
      ...(skipNum + PAGE_SIZE < total ? { hasMore: true } : {})
    })
  } catch (e) {
    console.error('[MOVIES CATALOG]', e.message)
    res.json({ metas: [] })
  }
})

// ─── SERIES CATALOG ──────────────────────────────────────────────────────────
app.get('/:key/catalog/series/synclio-series.json', async (req, res) => {
  const config = keys[req.params.key]
  if (!config) return res.json({ metas: [] })
  try {
    const { genre, search, skip } = req.query
    const skipNum = Number(skip) || 0
    let series = []

    if (genre) {
      series = await xtreamGet(config.server, config.username, config.password, 'get_series', `&category_id=${genre}`)
    } else {
      const allSeriesCacheKey = `${config.server}|all_series`
      if (cache[allSeriesCacheKey] && Date.now() - cache[allSeriesCacheKey].time < CACHE_TTL) {
        series = cache[allSeriesCacheKey].data
      } else {
        series = await xtreamGet(config.server, config.username, config.password, 'get_series', '')
        cache[allSeriesCacheKey] = { data: series, time: Date.now() }
      }
    }

    if (!Array.isArray(series)) series = []

    if (search) {
      series = series.filter(s => s.name.toLowerCase().includes(search.toLowerCase()))
    }

    const total = series.length
    const page = series.slice(skipNum, skipNum + PAGE_SIZE)

    res.json({
      metas: page.map(s => ({
        id: `synclio_series_${s.series_id}`,
        type: 'series',
        name: s.name,
        poster: s.cover || '',
        background: s.backdrop_path?.[0] || s.cover || '',
        year: s.year || '',
        description: s.plot || '',
        genres: [s.genre || 'Series']
      })),
      ...(skipNum + PAGE_SIZE < total ? { hasMore: true } : {})
    })
  } catch (e) {
    console.error('[SERIES CATALOG]', e.message)
    res.json({ metas: [] })
  }
})

// ─── LIVE TV CATALOG ─────────────────────────────────────────────────────────
app.get('/:key/catalog/tv/synclio-live.json', async (req, res) => {
  const config = keys[req.params.key]
  if (!config) return res.json({ metas: [] })
  try {
    const { genre, search, skip } = req.query
    const skipNum = Number(skip) || 0
    let channels = []

    if (genre) {
      channels = await xtreamGet(config.server, config.username, config.password, 'get_live_streams', `&category_id=${genre}`)
    } else {
      const allLiveCacheKey = `${config.server}|all_live`
      if (cache[allLiveCacheKey] && Date.now() - cache[allLiveCacheKey].time < CACHE_TTL) {
        channels = cache[allLiveCacheKey].data
      } else {
        channels = await xtreamGet(config.server, config.username, config.password, 'get_live_streams', '')
        cache[allLiveCacheKey] = { data: channels, time: Date.now() }
      }
    }

    if (!Array.isArray(channels)) channels = []

    if (search) {
      channels = channels.filter(c => c.name.toLowerCase().includes(search.toLowerCase()))
    }

    const total = channels.length
    const page = channels.slice(skipNum, skipNum + PAGE_SIZE)

    res.json({
      metas: page.map(c => ({
        id: `synclio_live_${c.stream_id}`,
        type: 'tv',
        name: c.name,
        poster: c.stream_icon || '',
        background: c.stream_icon || '',
        genres: [c.category_name || 'Live TV']
      })),
      ...(skipNum + PAGE_SIZE < total ? { hasMore: true } : {})
    })
  } catch (e) {
    console.error('[LIVE CATALOG]', e.message)
    res.json({ metas: [] })
  }
})

// ─── META ─────────────────────────────────────────────────────────────────────
app.get('/:key/meta/:type/:id.json', async (req, res) => {
  const config = keys[req.params.key]
  if (!config) return res.json({ meta: null })
  try {
    const { type, id } = req.params

    if (type === 'movie') {
      if (id.startsWith('tt')) {
        // TMDB id — find in VOD list
        const tmdbId = id.replace('tt', '')
        const allMovies = await xtreamGet(config.server, config.username, config.password, 'get_vod_streams', '')
        const match = Array.isArray(allMovies) ? allMovies.find(m => String(m.tmdb) === tmdbId) : null
        if (match) {
          const info = await xtreamGet(config.server, config.username, config.password, 'get_vod_info', `&vod_id=${match.stream_id}`)
          const m = info.info || {}
          return res.json({ meta: { id, type: 'movie', name: m.name || match.name, poster: m.movie_image || match.stream_icon || '', background: m.backdrop_path || m.movie_image || '', description: m.plot || '', year: m.releasedate?.slice(0, 4) || '', genres: [m.genre || 'Movies'] } })
        }
        return res.json({ meta: null })
      }
      // synclio_vod_ID_EXT format
      const parts = id.replace('synclio_vod_', '').split('_')
      const streamId = parts[0]
      const info = await xtreamGet(config.server, config.username, config.password, 'get_vod_info', `&vod_id=${streamId}`)
      const m = info.info || {}
      return res.json({ meta: { id, type: 'movie', name: m.name || id, poster: m.movie_image || '', background: m.backdrop_path || m.movie_image || '', description: m.plot || '', year: m.releasedate?.slice(0, 4) || '', genres: [m.genre || 'Movies'] } })
    }

    if (type === 'series') {
      const seriesId = id.replace('synclio_series_', '')
      const info = await xtreamGet(config.server, config.username, config.password, 'get_series_info', `&series_id=${seriesId}`)
      const s = info.info || {}
      const videos = []
      if (info.episodes) {
        Object.keys(info.episodes).forEach(season => {
          info.episodes[season].forEach(ep => {
            videos.push({
              id: `synclio_ep_${ep.id}_${ep.container_extension || 'mkv'}`,
              title: ep.title || `Episode ${ep.episode_num}`,
              season: Number(season),
              episode: ep.episode_num,
              released: ep.added ? new Date(ep.added * 1000).toISOString() : ''
            })
          })
        })
      }
      return res.json({ meta: { id, type: 'series', name: s.name || id, poster: s.cover || '', background: s.backdrop_path?.[0] || s.cover || '', description: s.plot || '', year: s.releaseDate?.slice(0, 4) || '', genres: [s.genre || 'Series'], videos } })
    }

    if (type === 'tv') {
      const streamId = id.replace('synclio_live_', '')
      const allChannels = await xtreamGet(config.server, config.username, config.password, 'get_live_streams', '')
      const ch = Array.isArray(allChannels) ? allChannels.find(c => String(c.stream_id) === streamId) : null
      return res.json({ meta: { id, type: 'tv', name: ch?.name || id, poster: ch?.stream_icon || '', background: ch?.stream_icon || '' } })
    }

    res.json({ meta: null })
  } catch (e) {
    console.error('[META]', e.message)
    res.json({ meta: null })
  }
})

// ─── STREAM ───────────────────────────────────────────────────────────────────
app.get('/:key/stream/:type/:id.json', async (req, res) => {
  const config = keys[req.params.key]
  if (!config) return res.json({ streams: [] })
  try {
    const { type, id } = req.params
    let url

    if (type === 'movie') {
      if (id.startsWith('tt')) {
        // Match by TMDB id
        const tmdbId = id.replace('tt', '')
        const allMovies = await xtreamGet(config.server, config.username, config.password, 'get_vod_streams', '')
        const match = Array.isArray(allMovies) ? allMovies.find(m => String(m.tmdb) === tmdbId) : null
        if (!match) {
          console.log(`[STREAM] No match for TMDB id: ${id}`)
          return res.json({ streams: [] })
        }
        const ext = match.container_extension || 'mkv'
        url = `${config.server}/movie/${config.username}/${config.password}/${match.stream_id}.${ext}`
      } else {
        // synclio_vod_STREAMID_EXT
        const parts = id.replace('synclio_vod_', '').split('_')
        const streamId = parts[0]
        const ext = parts[1] || 'mkv'
        url = `${config.server}/movie/${config.username}/${config.password}/${streamId}.${ext}`
      }
    } else if (type === 'series') {
      // synclio_ep_EPISODEID_EXT
      const parts = id.replace('synclio_ep_', '').split('_')
      const epId = parts[0]
      const ext = parts[1] || 'mkv'
      url = `${config.server}/series/${config.username}/${config.password}/${epId}.${ext}`
    } else {
      // Live TV
      const streamId = id.replace('synclio_live_', '')
      url = `${config.server}/live/${config.username}/${config.password}/${streamId}.m3u8`
    }

    console.log(`[STREAM] ${type} → ${url}`)
    res.json({
      streams: [{
        url,
        title: 'Synclio Stream',
        behaviorHints: { notWebReady: false }
      }]
    })
  } catch (e) {
    console.error('[STREAM]', e.message)
    res.json({ streams: [] })
  }
})

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', keys: Object.keys(keys).length }))

const PORT = process.env.PORT || 3001
app.listen(PORT, () => console.log(`Synclio backend running on port ${PORT}`))
