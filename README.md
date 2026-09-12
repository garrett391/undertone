# Undertone

Explore music as a map. Search for an artist, a song, or a vibe, and Undertone draws a network where similar music sits close together and shares colors.

This is v1: artist maps, song maps, and vibe maps built from Last.fm data. Spotify, key and BPM data, and the Camelot wheel come next.

## Setup

You need [Node.js](https://nodejs.org) 20 or newer and a free Last.fm API key.

1. **Get a Last.fm API key.** Sign in to Last.fm, then create an app at <https://www.last.fm/api/account/create>. Any name and description work, and you can leave the callback URL blank. Copy the value labeled **API key** (not the shared secret).
2. **Install and run:**

   ```bash
   npm install
   npm run dev
   ```

3. Open <http://127.0.0.1:5173> and paste your key when asked.

If you'd rather not paste the key, copy `.env.example` to `.env.local` and fill in `VITE_LASTFM_API_KEY`. That file is git-ignored.

## Using it

- **Search** for an artist, a song, or a vibe word. Pick a vibe to add it as a chip, and add up to four to combine them, like `rainy day` + `indie folk`.
- **Hover** a node to see its neighborhood. **Click** it for details, tags, and popular songs.
- **Double-click** a node (or use "Show more like this") to grow the map outward from it.
- **Find a path from here** draws the smoothest route between two nodes, following the strongest connections. On a song map, that's the start of a playlist.
- **Show me something different** jumps to the node farthest from the one you selected.
- Click a tag on any artist or song to explore that vibe. Click a song under "Popular songs" to switch to a song map.
- Press `/` to jump to search and `Esc` to clear a selection. The browser's back button works, and every map has its own URL you can bookmark.

## How it works

**Data.** Last.fm's similar-artist and similar-track lists come from what millions of listeners play together. Tags are user-applied, which is why you get moods like "melancholic" as well as genres.

**Building a map.** Undertone fetches the seed's similar list, then fetches similar lists for the strongest dozen neighbors and links them to each other. That second pass turns a star around the seed into a real network. Each hub contributes only its 10 strongest links, so maps stay readable. Vibe maps score artists by how high they rank across all your tags, then connect them the same way.

**Color.** Colors come from the layout itself. The seed sits near-white at the center, and color gets more vivid with distance, with the direction setting the hue. Since the force layout pulls similar music together, neighbors share hues and distant corners of the map land on opposite sides of the color wheel. Colors use OKLCH so every hue has the same perceived brightness.

**Graph algorithms** (in `src/graph/analysis.js`):

- *Scenes* come from Louvain community detection.
- *Bridges* are nodes with high betweenness centrality whose neighbors span more than one scene.
- *Paths* use Dijkstra's algorithm, where a strong similarity counts as a short distance.

**Caching.** Responses are saved in your browser (IndexedDB) for a week, so maps you've seen load instantly. Requests are paced under Last.fm's limit of about five per second. You can clear saved data in settings.

## Project structure

```
src/
  api/
    lastfm.js      Last.fm client: pacing, caching, error messages, clean data shapes
    cache.js       Memory and IndexedDB cache
  graph/
    build.js       Builds artist, song, and vibe maps; grows maps from a node
    analysis.js    Scenes, bridges, paths, farthest node
    color.js       Spectral coloring
  ui/
    graphView.js   D3 rendering, force layout, zoom, hover, labels
    search.js      Search box with artist, song, and vibe results
    panel.js       Details panel
    settings.js    API key dialog
    status.js      Status line
    dom.js         Small DOM helper and icons
  main.js          Routing and app state
  style.css        All styles
```

## Known limits

- Last.fm data skews toward popular music, so very niche artists may have short or missing similar lists.
- Some songs have no song-to-song data. When that happens, Undertone builds the map from similar artists' popular songs and says so in the panel.
- Similar artist and song names can occasionally point to the wrong act when two share a name.

## Next steps

- **v2:** Spotify login (PKCE, with `http://127.0.0.1:5173` as the redirect URI), album art, key and BPM from ReccoBeats, and the Camelot wheel track view.
- **v3:** Playlist builder with smooth transitions, saved to Spotify.
- **Later:** An LLM or local embeddings to turn free-text vibes like "forest green focus" into Last.fm tags.
