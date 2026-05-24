const express = require('express')
const cors = require('cors')
const axios = require('axios')
const PlaylistParser = require('iptv-playlist-parser')

const app = express()
app.use(cors())
app.use(express.json())

const keys = {}

function generateKey() {
  return Math.random().toString(36).substring(2, 10).toUpperCase()
}

app.post('/api/generate-key', (req, res) => {
  const { m3uUrl } = req.body
  if (!m3uUrl) return res.status(400).json({ error: 'M3U URL required' })
  const key = generateKey()
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000)
  keys[key] = { m3uUrl, expiresAt, plan: 'trial' }
  console.log('Key created: ' + key)
  res.json({ key, expiresAt })
})

async function getChannels(m3uUrl) {
  const { data } = await axios.get(m3uUrl, {
    timeout: 15000,
    headers: { 'User-Agent': 'Mozilla/5.0' }
  })
  const result = PlaylistParser.parse(data)
  return result.items.map((ch, i) => {
    const name = ch.name || 'Channel ' + i
    const group = ch.group?.title || 'General'
    const groupLower = group.toLowerCase()
    const nameLower = name.toLowerCase()
    let type = 'tv'
    if (groupLower.includes('movie') || groupLower.includes('film') || groupLower.includes('cinema') || groupLower.includes('vod')) {
      type = 'movie'
    } else if (groupLower.includes('series') || groupLower.includes('show') || groupLower.includes('episode') || nameLower.includes('s0') || nameLower.includes('s1') || nameLower.includes('s2')) {
      type = 'series'
    }
    return {
      id: 'synclio_' + Buffer.from(name + i).toString('base64').slice(0, 16),
      name,
      logo: ch.tvg?.logo || '',
      group,
      url: ch.url,
      type
    }
  })
}

app.get('/:key/manifest.json', (req, res) => {
  const config = keys[req.params.key]
  if (!config) return res.status(404).json({ error: 'Invalid key' })
  if (new Date() > new Date(config.expiresAt)) {
    return res.status(403).json({ error: 'Key expired' })
  }
  res.json({
    id: 'com.synclio.' + req.params.key,
    version: '1.0.0',
    name: 'Synclio IPTV',
    description: 'Your personal IPTV playlist in Stremio',
    resources: ['catalog', 'meta', 'stream'],
    types: ['tv', 'movie', 'series'],
    catalogs: [
      { type: 'tv', id: 'synclio-live', name: 'Live TV', extra: [{ name: 'genre', isRequired: false }, { name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] },
      { type: 'movie', id: 'synclio-movies', name: 'Movies', extra: [{ name: 'genre', isRequired: false
