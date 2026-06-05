const express = require('express')
const cors    = require('cors')
const axios   = require('axios')
const fs      = require('fs')

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

// ─── Config ───────────────────────────────────────────────────────────────────
const TMDB_API_KEY = process.env.TMDB_API_KEY || ''
const PAGE_SIZE    = 100          // items sent per Stremio page request
const CACHE_TTL    = 15 * 60 * 1000  // 15 min for full lists (they're large)
const META_TTL     =  5 * 60 * 1000  // 5 min for individual item info

// ─── Caches ───────────────────────────────────────────────────────────────────
// xtreamCache  : raw Xtream API responses        { data, time }
// tmdbCache    : tmdbId → imdbId (or null)
// imdbIndex    : key → Map<imdbId, vodItem>      built once, reused
// streamIndex  : key → Map<streamId, item>       for live/series lookups
const xtreamCache = {}
const tmdbCache   = {}
const imdbIndex   = {}   // per-key reverse index  imdbId → vod item
const streamIndex = {}   // per-key stream_id → item  (for meta lookups)

// ─── Xtream fetch (with smart TTL) ───────────────────────────────────────────
async function xtreamGet(server, username, password, action, extra = '', ttl = CACHE_TTL) {
  const cacheKey = `${server}|${action}|${extra}`
  const cached   = xtreamCache[cacheKey]
  if (cached && Date.now() - cached.time < ttl) return cached.data

  const url  = `${server}/player_api.php?username=${username}&password=${password}&action=${action}${extra}`
  const resp = await axios.get(url, { timeout: 20000, headers: { 'User-Agent': 'Mozilla/5.0' } })
  xtreamCache[cacheKey] = { data: resp.data, time: Date.now() }
  return resp.data
}

// ─── Key helpers ─────────────────────────────────────────────────────────────
function generateKey() {
  return Math.random().toString(36).substring(2, 10).toUpperCase()
}
function getConfig(key) {
  const c = keys[key]
  if (!c) return null
  if (new Date() > new Date(c.expiresAt)) return null
  return c
}

// ─── TMDB → IMDB (cached, single request per tmdbId) ─────────────────────────
async function tmdbToImdb(tmdbId) {
  if (!TMDB_API_KEY || !tmdbId) return null
  if (tmdbId in tmdbCache) return tmdbCache[tmdbId]   // null is a valid cached value
  try {
    const { data } = await axios.get(
      `https://api.themoviedb.org/3/movie/${tmdbId}/external_ids`,
      { params: { api_key: TMDB_API_KEY }, timeout: 5000 }
    )
    tmdbCache[tmdbId] = data.imdb_id || null
  } catch {
    tmdbCache[tmdbId] = null
  }
  return tmdbCache[tmdbId]
}

// ─── Slim meta mapper (only fields Stremio needs for catalog rows) ────────────
// We intentionally skip description/plot in catalog — it's huge and unused there.
function vodToMeta(m, id) {
  return {
    id,
    type:       'movie',
    name:       m.name,
    poster:     m.stream_icon || '',
    background: m.stream_icon || '',
    year:       m.year        || '',
    genres:     [m.category_name || 'Movies']
  }
}

// ─── Build per-key IMDB index (lazy, only when TMDB_API_KEY is set) ───────────
// We build the index for the whole list once, then all catalog pages use it.
// Without TMDB_API_KEY we skip this and just use synclio_vod_ ids.
async function ensureImdbIndex(key, allMovies) {
  if (!TMDB_API_KEY) return
  if (imdbIndex[key] && imdbIndex[key].built) return   // already done

  // mark as in-progress to avoid duplicate builds on concurrent requests
  if (!imdbIndex[key]) imdbIndex[key] = { map: new Map(), built: false, building: false }
  if (imdbIndex[key].building) return
  imdbIndex[key].building = true

  // Fire TMDB lookups in small batches to avoid hammering the API
  const BATCH = 20
  for (let i = 0; i < allMovies.length; i += BATCH) {
    const batch = allMovies.slice(i, i + BATCH)
    await Promise.all(batch.map(async m => {
      if (!m.tmdb) return
      const imdbId = await tmdbToImdb(m.tmdb)
      if (imdbId) imdbIndex[key].map.set(imdbId, m)
    }))
  }
  imdbIndex[key].built    = true
  imdbIndex[key].building = false
}

// Invalidate index when cache refreshes (call this if you ever bust the cache)
function invalidateIndex(key) {
  delete imdbIndex[key]
}

// ─── Key generation ───────────────────────────────────────────────────────────
app.post('/api/generate-key', (req, res) => {
  const { server, username, password } = req.body
  if (!server || !username || !password)
    return res.status(400).json({ error: 'server, username and password are required' })

  const key       = generateKey()
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000)
  keys[key]       = { server, username, password, expiresAt }
  saveKeys()
  console.log('Key created:', key)
  res.json({ key, expiresAt })
})

// ─── Manifest ─────────────────────────────────────────────────────────────────
app.get('/:key/manifest.json', async (req, res) => {
  const config = getConfig(req.params.key)
  if (!config) return res.status(404).json({ error: 'Invalid or expired key' })

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
  } catch { /* genres are optional, don't crash */ }

  res.json({
    id:          'com.synclio.' + req.params.key,
    version:     '1.0.0',
    name:        'Synclio IPTV',
    description: 'Your personal IPTV in Stremio',
    resources:   ['catalog', 'meta', 'stream'],
    types:       ['tv', 'movie', 'series'],
    catalogs: [
      {
        type: 'movie', id: 'synclio-movies', name: '🎬 Movies',
        genres: movieGenres,
        extra: [
          { name: 'genre',  isRequired: false },
          { name: 'search', isRequired: false },
          { name: 'skip',   isRequired: false }
        ]
      },
      {
        type: 'series', id: 'synclio-series', name: '📺 Series',
        genres: seriesGenres,
        extra: [
          { name: 'genre',  isRequired: false },
          { name: 'search', isRequired: false },
          { name: 'skip',   isRequired: false }
        ]
      },
      {
        type: 'tv', id: 'synclio-live', name: '📡 Live TV',
        genres: liveGenres,
        extra: [
          { name: 'genre',  isRequired: false },
          { name: 'search', isRequired: false },
          { name: 'skip',   isRequired: false }
        ]
      }
    ],
    behaviorHints: { configurable: false }
  })
})

// ─── MOVIES CATALOG ───────────────────────────────────────────────────────────
// Strategy:
//   1. Fetch ALL movies from Xtream (cached 15 min) — one network call
//   2. Filter by genre/search in-memory
//   3. Paginate with skip + PAGE_SIZE — Stremio will keep asking until empty
//   4. Map to slim meta objects (no plot/description in catalog rows)
//   5. IDs: real IMDB tt-ids when TMDB key present, otherwise synclio_vod_
app.get('/:key/catalog/movie/synclio-movies.json', async (req, res) => {
  const config = getConfig(req.params.key)
  if (!config) return res.json({ metas: [] })

  try {
    const { genre, search, skip } = req.query
    const skipN = Number(skip) || 0

    // --- 1. Fetch all movies (cached) ---
    let movies = await xtreamGet(config.server, config.username, config.password, 'get_vod_streams')
    if (!Array.isArray(movies)) return res.json({ metas: [] })

    // --- 2. Filter ---
    if (genre) {
      const categories = await xtreamGet(config.server, config.username, config.password, 'get_vod_categories')
      const cat = Array.isArray(categories) ? categories.find(c => c.category_name === genre) : null
      if (cat) movies = movies.filter(m => String(m.category_id) === String(cat.category_id))
    }
    if (search) {
      const q = search.toLowerCase()
      movies = movies.filter(m => m.name.toLowerCase().includes(q))
    }

    // --- 3. Paginate ---
    const page = movies.slice(skipN, skipN + PAGE_SIZE)
    if (page.length === 0) return res.json({ metas: [] })

    // --- 4. Build IDs ---
    // When TMDB key is available, start index build in background (non-blocking)
    // For the current page, check if the index already has an entry, otherwise fallback id
    if (TMDB_API_KEY && !imdbIndex[req.params.key]?.built) {
      // kick off index build without awaiting — subsequent pages will benefit
      ensureImdbIndex(req.params.key, movies).catch(() => {})
    }

    const idx = imdbIndex[req.params.key]?.map

    const metas = page.map(m => {
      let id
      if (idx && m.tmdb) {
        // check if we already resolved this item
        const imdbId = tmdbCache[m.tmdb]
        id = (imdbId && imdbId !== null) ? imdbId : `synclio_vod_${m.stream_id}_${m.container_extension || 'mkv'}`
      } else {
        id = `synclio_vod_${m.stream_id}_${m.container_extension || 'mkv'}`
      }
      return vodToMeta(m, id)
    })

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
    const skipN = Number(skip) || 0

    let series = await xtreamGet(config.server, config.username, config.password, 'get_series')
    if (!Array.isArray(series)) return res.json({ metas: [] })

    if (genre) {
      const categories = await xtreamGet(config.server, config.username, config.password, 'get_series_categories')
      const cat = Array.isArray(categories) ? categories.find(c => c.category_name === genre) : null
      if (cat) series = series.filter(s => String(s.category_id) === String(cat.category_id))
    }
    if (search) {
      const q = search.toLowerCase()
      series = series.filter(s => s.name.toLowerCase().includes(q))
    }

    const page = series.slice(skipN, skipN + PAGE_SIZE)
    if (page.length === 0) return res.json({ metas: [] })

    res.json({
      metas: page.map(s => ({
        id:         'synclio_series_' + s.series_id,
        type:       'series',
        name:       s.name,
        poster:     s.cover                   || '',
        background: s.backdrop_path?.[0] || s.cover || '',
        year:       s.year                    || '',
        genres:     [s.genre || 'Series']
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
    const skipN = Number(skip) || 0

    let channels

    if (genre) {
      // Fetch only that category — fast
      const categories = await xtreamGet(config.server, config.username, config.password, 'get_live_categories')
      const cat = Array.isArray(categories) ? categories.find(c => c.category_name === genre) : null
      channels = cat
        ? await xtreamGet(config.server, config.username, config.password, 'get_live_streams', `&category_id=${cat.category_id}`)
        : await xtreamGet(config.server, config.username, config.password, 'get_live_streams')
    } else {
      // No genre filter — fetch everything (cached), needed for search + full browse
      channels = await xtreamGet(config.server, config.username, config.password, 'get_live_streams')
    }

    if (!Array.isArray(channels)) return res.json({ metas: [] })

    if (search) {
      const q = search.toLowerCase()
      channels = channels.filter(c => c.name.toLowerCase().includes(q))
    }

    const page = channels.slice(skipN, skipN + PAGE_SIZE)
    if (page.length === 0) return res.json({ metas: [] })

    res.json({
      metas: page.map(c => ({
        id:         'synclio_live_' + c.stream_id,
        type:       'tv',
        name:       c.name,
        poster:     c.stream_icon || '',
        background: c.stream_icon || '',
        genres:     [c.category_name || 'Live TV']
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

    // ── Movie ──────────────────────────────────────────────────────────────────
    if (type === 'movie') {

      if (id.startsWith('synclio_vod_')) {
        const streamId = id.replace('synclio_vod_', '').split('_')[0]
        const info     = await xtreamGet(config.server, config.username, config.password, 'get_vod_info', `&vod_id=${streamId}`, META_TTL)
        const m        = info.info || {}
        return res.json({
          meta: {
            id,
            type:        'movie',
            name:        m.name            || id,
            poster:      m.movie_image     || '',
            background:  m.backdrop_path   || m.movie_image || '',
            description: m.plot            || '',
            year:        m.releasedate?.slice(0, 4) || '',
            genres:      [m.genre || 'Movies']
          }
        })
      }

      if (id.startsWith('tt')) {
        // Use the index if it's ready; otherwise scan (this is a fallback)
        const idx = imdbIndex[req.params.key]?.map
        let match = idx?.get(id) || null

        if (!match) {
          // index not ready — scan (slow path, rare after warmup)
          const allMovies = await xtreamGet(config.server, config.username, config.password, 'get_vod_streams')
          if (Array.isArray(allMovies)) {
            for (const m of allMovies) {
              if (!m.tmdb) continue
              const imdbId = await tmdbToImdb(m.tmdb)
              if (imdbId === id) { match = m; break }
            }
          }
        }

        if (!match) return res.json({ meta: null })
        return res.json({
          meta: {
            id,
            type:       'movie',
            name:       match.name,
            poster:     match.stream_icon || '',
            background: match.stream_icon || '',
            genres:     [match.category_name || 'Movies']
          }
        })
      }
    }

    // ── Series ─────────────────────────────────────────────────────────────────
    if (type === 'series') {
      const seriesId = id.replace('synclio_series_', '')
      const info     = await xtreamGet(config.server, config.username, config.password, 'get_series_info', `&series_id=${seriesId}`, META_TTL)
      const s        = info.info || {}

      const videos = []
      if (info.episodes) {
        for (const season of Object.keys(info.episodes).sort((a, b) => Number(a) - Number(b))) {
          for (const ep of info.episodes[season]) {
            videos.push({
              id:       `synclio_ep_${ep.id}_${ep.container_extension || 'mkv'}`,
              title:    ep.title || `Episode ${ep.episode_num}`,
              season:   Number(season),
              episode:  ep.episode_num,
              released: ep.added ? new Date(ep.added * 1000).toISOString() : ''
            })
          }
        }
      }

      return res.json({
        meta: {
          id,
          type:        'series',
          name:        s.name  || id,
          poster:      s.cover || '',
          background:  s.backdrop_path?.[0] || s.cover || '',
          description: s.plot  || '',
          year:        s.releaseDate?.slice(0, 4) || '',
          genres:      [s.genre || 'Series'],
          videos
        }
      })
    }

    // ── Live TV ────────────────────────────────────────────────────────────────
    const streamId = id.replace('synclio_live_', '')

    // Use per-key stream index for O(1) lookup instead of scanning full list
    if (!streamIndex[req.params.key]) {
      const all = await xtreamGet(config.server, config.username, config.password, 'get_live_streams')
      if (Array.isArray(all)) {
        streamIndex[req.params.key] = new Map(all.map(c => [String(c.stream_id), c]))
      }
    }
    const ch = streamIndex[req.params.key]?.get(String(streamId))

    return res.json({
      meta: {
        id,
        type:       'tv',
        name:       ch?.name         || id,
        poster:     ch?.stream_icon  || '',
        background: ch?.stream_icon  || ''
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
        const idx   = imdbIndex[req.params.key]?.map
        let   match = idx?.get(id) || null

        if (!match) {
          const allMovies = await xtreamGet(config.server, config.username, config.password, 'get_vod_streams')
          if (Array.isArray(allMovies)) {
            for (const m of allMovies) {
              if (!m.tmdb) continue
              const imdbId = await tmdbToImdb(m.tmdb)
              if (imdbId === id) { match = m; break }
            }
          }
        }

        if (!match) {
          console.log('No VOD match for IMDB id:', id)
          return res.json({ streams: [] })
        }
        url = `${config.server}/movie/${config.username}/${config.password}/${match.stream_id}.${match.container_extension || 'mkv'}`
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
