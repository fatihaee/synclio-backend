const express = require('express')
const cors = require('cors')
const axios = require('axios')
const fs = require('fs')
const app = express()

app.use(cors())
app.use(express.json())

// ─── Persistent key storage ───────────────────────────────────────────────────
const KEYS_FILE = './keys.json'
const keys = fs.existsSync(KEYS_FILE)
  ? JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'))
  : {}

function saveKeys() {
  fs.writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2))
}

// ─── In-memory caches ─────────────────────────────────────────────────────────
const xtreamCache = {}      // Xtream API responses
const tmdbCache = {}        // TMDB id → IMDB id mapping

// ─── Config ───────────────────────────────────────────────────────────────────
const TMDB_API_KEY = process.env.TMDB_API_KEY || ''   // Set in env for poster/IMDB matching
const CACHE_TTL = 10 * 60 * 1000                      // 10 minutes

// ─── Helpers ──────────────────────────────────────────────────────────────────
function generateKey() {
  return Math.random().toString(36).substring(2, 10).toUpperCase()
}

function getConfig(key) {
  const config = keys[key]
  if (!config) return null
  if (new Date() > new Date(config.expiresAt)) return null
  return config
}

async function xtreamGet(server, username, password, action, extra = '') {
  const cacheKey = `${server}|${action}|${extra}`
  const cached = xtreamCache[cacheKey]
  if (cached && Date.now() - cached.time < CACHE_TTL) return cached.data

  const url = `${server}/player_api.php?username=${username}&password=${password}&action=${action}${extra}`
  const resp = await axios.get(url, {
    timeout: 15000,
    headers: { 'User-Agent': 'Mozilla/5.0' }
  })
  xtreamCache[cacheKey] = { data: resp.data, time: Date.now() }
  return resp.data
}

/**
 * Convert a TMDB movie ID to an IMDB ID (tt-format).
 * Requires TMDB_API_KEY. Falls back to null if unavailable.
 */
async function tmdbToImdb(tmdbId) {
  if (!TMDB_API_KEY || !tmdbId) return null

  const cached = tmdbCache[tmdbId]
  if (cached !== undefined) return cached   // can be null (meaning "not found")

  try {
    const resp = await axios.get(
      `https://api.themoviedb.org/3/movie/${tmdbId}/external_ids`,
      {
        params: { api_key: TMDB_API_KEY },
        timeout: 5000
      }
    )
    const imdbId = resp.data.imdb_id || null
    tmdbCache[tmdbId] = imdbId
    return imdbId
  } catch {
    tmdbCache[tmdbId] = null
    return null
  }
}

/**
 * Build the best Stremio ID for a VOD item.
 * If TMDB key available and movie has a tmdb field, convert to real IMDB id.
 * Otherwise use synclio_vod_ prefix.
 */
async function buildMovieId(m) {
  if (m.tmdb && TMDB_API_KEY) {
    const imdbId = await tmdbToImdb(m.tmdb)
    if (imdbId) return imdbId
  }
  return `synclio_vod_${m.stream_id}_${m.container_extension || 'mkv'}`
}

// ─── Key generation ───────────────────────────────────────────────────────────
app.post('/api/generate-key', (req, res) => {
  const { server, username, password } = req.body
  if (!server || !username || !password)
    return res.status(400).json({ error: 'server, username and password are required' })

  const key = generateKey()
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000)
  keys[key] = { server, username, password, expiresAt }
  saveKeys()

  console.log('Key created:', key)
  res.json({ key, expiresAt })
})

// ─── Manifest ─────────────────────────────────────────────────────────────────
app.get('/:key/manifest.json', async (req, res) => {
  const config = getConfig(req.params.key)
  if (!config) return res.status(404).json({ error: 'Invalid or expired key' })

  // Fetch category lists to expose genres to Stremio
  let movieGenres = [], seriesGenres = [], liveGenres = []
  try {
    const [mc, sc, lc] = await Promise.all([
      xtreamGet(config.server, config.username, config.password, 'get_vod_categories'),
      xtreamGet(config.server, config.username, config.password, 'get_series_categories'),
      xtreamGet(config.server, config.username, config.password, 'get_live_categories')
    ])
    movieGenres  = Array.isArray(mc) ? mc.map(c => c.category_name).filter(Boolean) : []
    seriesGenres = Array.isArray(sc) ? sc.map(c => c.category_name).filter(Boolean) : []
    liveGenres   = Array.isArray(lc) ? lc.map(c => c.category_name).filter(Boolean) : []
  } catch { /* genres are optional */ }

  res.json({
    id: 'com.synclio.' + req.params.key,
    version: '1.0.0',
    name: 'Synclio IPTV',
    description: 'Your personal IPTV in Stremio',
    resources: ['catalog', 'meta', 'stream'],
    types: ['tv', 'movie', 'series'],
    catalogs: [
      {
        type: 'movie', id: 'synclio-movies', name: '🎬 Movies',
        genres: movieGenres,
        extra: [
          { name: 'genre', isRequired: false },
          { name: 'search', isRequired: false },
          { name: 'skip', isRequired: false }
        ]
      },
      {
        type: 'series', id: 'synclio-series', name: '📺 Series',
        genres: seriesGenres,
        extra: [
          { name: 'genre', isRequired: false },
          { name: 'search', isRequired: false },
          { name: 'skip', isRequired: false }
        ]
      },
      {
        type: 'tv', id: 'synclio-live', name: '📡 Live TV',
        genres: liveGenres,
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

// ─── MOVIES CATALOG ───────────────────────────────────────────────────────────
app.get('/:key/catalog/movie/synclio-movies.json', async (req, res) => {
  const config = getConfig(req.params.key)
  if (!config) return res.json({ metas: [] })

  try {
    const { genre, search, skip } = req.query

    let movies
    if (genre) {
      // Stremio passes the genre *name* — we need to look up the matching category_id
      const categories = await xtreamGet(config.server, config.username, config.password, 'get_vod_categories')
      const cat = Array.isArray(categories)
        ? categories.find(c => c.category_name === genre)
        : null
      if (cat) {
        movies = await xtreamGet(config.server, config.username, config.password, 'get_vod_streams', `&category_id=${cat.category_id}`)
      } else {
        movies = await xtreamGet(config.server, config.username, config.password, 'get_vod_streams')
      }
    } else {
      movies = await xtreamGet(config.server, config.username, config.password, 'get_vod_streams')
    }

    if (!Array.isArray(movies)) return res.json({ metas: [] })

    if (search) movies = movies.filter(m => m.name.toLowerCase().includes(search.toLowerCase()))

    const skipN = Number(skip) || 0
    const page  = movies.slice(skipN, skipN + 200)

    // Build IDs — uses real IMDB ids when TMDB_API_KEY is set
    const metas = await Promise.all(page.map(async m => {
      const id = await buildMovieId(m)
      return {
        id,
        type: 'movie',
        name: m.name,
        poster: m.stream_icon || '',
        background: m.stream_icon || '',
        year: m.year || '',
        description: m.plot || '',
        genres: [m.category_name || 'Movies']
      }
    }))

    res.json({ metas })
  } catch (e) {
    console.error('Movies catalog error:', e.message)
    res.json({ metas: [] })
  }
})

// ─── SERIES CATALOG ───────────────────────────────────────────────────────────
app.get('/:key/catalog/series/synclio-series.json', async (req, res) => {
  const config = getConfig(req.params.key)
  if (!config) return res.json({ metas: [] })

  try {
    const { genre, search, skip } = req.query

    let series
    if (genre) {
      const categories = await xtreamGet(config.server, config.username, config.password, 'get_series_categories')
      const cat = Array.isArray(categories)
        ? categories.find(c => c.category_name === genre)
        : null
      series = cat
        ? await xtreamGet(config.server, config.username, config.password, 'get_series', `&category_id=${cat.category_id}`)
        : await xtreamGet(config.server, config.username, config.password, 'get_series')
    } else {
      series = await xtreamGet(config.server, config.username, config.password, 'get_series')
    }

    if (!Array.isArray(series)) return res.json({ metas: [] })

    if (search) series = series.filter(s => s.name.toLowerCase().includes(search.toLowerCase()))

    const skipN = Number(skip) || 0
    const page  = series.slice(skipN, skipN + 200)

    res.json({
      metas: page.map(s => ({
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

// ─── LIVE TV CATALOG ──────────────────────────────────────────────────────────
app.get('/:key/catalog/tv/synclio-live.json', async (req, res) => {
  const config = getConfig(req.params.key)
  if (!config) return res.json({ metas: [] })

  try {
    const { genre, search, skip } = req.query

    let channels
    if (genre) {
      // Genre filter: look up category_id by name
      const categories = await xtreamGet(config.server, config.username, config.password, 'get_live_categories')
      const cat = Array.isArray(categories)
        ? categories.find(c => c.category_name === genre)
        : null
      channels = cat
        ? await xtreamGet(config.server, config.username, config.password, 'get_live_streams', `&category_id=${cat.category_id}`)
        : await xtreamGet(config.server, config.username, config.password, 'get_live_streams')
    } else if (search) {
      // Search requires ALL channels — don't limit to first category
      channels = await xtreamGet(config.server, config.username, config.password, 'get_live_streams')
    } else {
      // Default: show first category only (avoids loading thousands of channels)
      const categories = await xtreamGet(config.server, config.username, config.password, 'get_live_categories')
      const firstCat = Array.isArray(categories) ? categories[0]?.category_id : null
      channels = firstCat
        ? await xtreamGet(config.server, config.username, config.password, 'get_live_streams', `&category_id=${firstCat}`)
        : await xtreamGet(config.server, config.username, config.password, 'get_live_streams')
    }

    if (!Array.isArray(channels)) return res.json({ metas: [] })

    if (search) channels = channels.filter(c => c.name.toLowerCase().includes(search.toLowerCase()))

    const skipN = Number(skip) || 0
    const page  = channels.slice(skipN, skipN + 200)

    res.json({
      metas: page.map(c => ({
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

// ─── META ─────────────────────────────────────────────────────────────────────
app.get('/:key/meta/:type/:id.json', async (req, res) => {
  const config = getConfig(req.params.key)
  if (!config) return res.json({ meta: null })

  try {
    const { type, id } = req.params

    // ── Movie ──
    if (type === 'movie') {

      if (id.startsWith('synclio_vod_')) {
        const parts  = id.replace('synclio_vod_', '').split('_')
        const streamId = parts[0]
        const info   = await xtreamGet(config.server, config.username, config.password, 'get_vod_info', `&vod_id=${streamId}`)
        const m      = info.info || {}
        return res.json({
          meta: {
            id,
            type: 'movie',
            name: m.name || id,
            poster: m.movie_image || '',
            background: m.backdrop_path || m.movie_image || '',
            description: m.plot || '',
            year: m.releasedate?.slice(0, 4) || '',
            genres: [m.genre || 'Movies']
          }
        })
      }

      if (id.startsWith('tt')) {
        // Real IMDB id — find matching VOD via TMDB reverse lookup
        const allMovies = await xtreamGet(config.server, config.username, config.password, 'get_vod_streams')
        if (!Array.isArray(allMovies)) return res.json({ meta: null })

        // Try to find a movie whose TMDB id maps to this IMDB id
        let match = null
        for (const m of allMovies) {
          if (!m.tmdb) continue
          const imdbId = await tmdbToImdb(m.tmdb)
          if (imdbId === id) { match = m; break }
        }

        if (match) {
          return res.json({
            meta: {
              id,
              type: 'movie',
              name: match.name,
              poster: match.stream_icon || '',
              background: match.stream_icon || '',
              genres: [match.category_name || 'Movies']
            }
          })
        }
        return res.json({ meta: null })
      }
    }

    // ── Series ──
    if (type === 'series') {
      const seriesId = id.replace('synclio_series_', '')
      const info     = await xtreamGet(config.server, config.username, config.password, 'get_series_info', `&series_id=${seriesId}`)
      const s        = info.info || {}

      const videos = []
      if (info.episodes) {
        for (const season of Object.keys(info.episodes)) {
          for (const ep of info.episodes[season]) {
            videos.push({
              id: `synclio_ep_${ep.id}_${ep.container_extension || 'mkv'}`,
              title: ep.title || `Episode ${ep.episode_num}`,
              season: Number(season),
              episode: ep.episode_num,
              released: ep.added ? new Date(ep.added * 1000).toISOString() : ''
            })
          }
        }
      }

      return res.json({
        meta: {
          id,
          type: 'series',
          name: s.name || id,
          poster: s.cover || '',
          background: s.backdrop_path?.[0] || s.cover || '',
          description: s.plot || '',
          year: s.releaseDate?.slice(0, 4) || '',
          genres: [s.genre || 'Series'],
          videos
        }
      })
    }

    // ── Live TV ──
    const streamId = id.replace('synclio_live_', '')
    const channels = await xtreamGet(config.server, config.username, config.password, 'get_live_streams')
    const ch = Array.isArray(channels)
      ? channels.find(c => String(c.stream_id) === String(streamId))
      : null

    return res.json({
      meta: {
        id,
        type: 'tv',
        name: ch?.name || id,
        poster: ch?.stream_icon || '',
        background: ch?.stream_icon || ''
      }
    })

  } catch (e) {
    console.error('Meta error:', e.message)
    res.json({ meta: null })
  }
})

// ─── STREAM ───────────────────────────────────────────────────────────────────
app.get('/:key/stream/:type/:id.json', async (req, res) => {
  const config = getConfig(req.params.key)
  if (!config) return res.json({ streams: [] })

  try {
    const { type, id } = req.params
    let url

    if (type === 'movie') {

      if (id.startsWith('synclio_vod_')) {
        const parts    = id.replace('synclio_vod_', '').split('_')
        const streamId = parts[0]
        const ext      = parts[1] || 'mkv'
        url = `${config.server}/movie/${config.username}/${config.password}/${streamId}.${ext}`

      } else if (id.startsWith('tt')) {
        // Real IMDB id — resolve to VOD via TMDB
        const allMovies = await xtreamGet(config.server, config.username, config.password, 'get_vod_streams')
        if (!Array.isArray(allMovies)) return res.json({ streams: [] })

        let match = null
        for (const m of allMovies) {
          if (!m.tmdb) continue
          const imdbId = await tmdbToImdb(m.tmdb)
          if (imdbId === id) { match = m; break }
        }

        if (!match) {
          console.log('No VOD match for IMDB id:', id)
          return res.json({ streams: [] })
        }
        const ext = match.container_extension || 'mkv'
        url = `${config.server}/movie/${config.username}/${config.password}/${match.stream_id}.${ext}`
      }

    } else if (type === 'series') {
      const parts = id.replace('synclio_ep_', '').split('_')
      const epId  = parts[0]
      const ext   = parts[1] || 'mkv'
      url = `${config.server}/series/${config.username}/${config.password}/${epId}.${ext}`

    } else {
      const streamId = id.replace('synclio_live_', '')
      url = `${config.server}/live/${config.username}/${config.password}/${streamId}.m3u8`
    }

    console.log('Stream URL:', url)
    res.json({
      streams: [{
        url,
        title: 'Synclio Stream',
        behaviorHints: { notWebReady: false }
      }]
    })

  } catch (e) {
    console.error('Stream error:', e.message)
    res.json({ streams: [] })
  }
})

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001
app.listen(PORT, () => console.log(`Synclio backend running on port ${PORT}`))
