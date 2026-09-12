# Undertone

Explore music as a map. Search for an artist, a song, or a vibe, and Undertone draws a network where similar music sits close together and shares colors.

Artist maps, song maps, and vibe maps built from Last.fm data, plus paths that connect any two of them. Spotify, key and BPM data, and the Camelot wheel come next.

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
- Anything already drawn shows up under **On this map** at the top of the results, with no network call. Picking it jumps to that node instead of starting a new map — handy once a map gets dense, or on touch where there's no hover.
- **Hover** a node to see its neighborhood. **Click** it for details, tags, popular songs, and a ranked list of similar artists (or similar songs, on a song map).
- That similar list is the full ranking, not only what the map drew, so it doubles as a way to read a map on a phone where few labels fit. Rows already on the map take you to them; rows that aren't have a **+** and get added right where you are, which makes "Show more like this" one at a time instead of ten.
- **Double-click** a node (or use "Show more like this") to grow the map outward from it.
- **Show me something different** jumps to the node farthest from the one you selected.
- Click a tag on any artist or song to explore that vibe. Click a song under "Popular songs" to switch to a song map.
- The overview panel lists everything on the map, ranked by how close it is to your starting point. Tap a row to go to that node. With the similar list on each node, that's the whole map readable as text.
- Song search results show the artist under the name and a listener count on the right, so a remaster, an explicit edit, and a stray upload with the same title are easy to tell apart.
- On a phone, the details panel is a bottom sheet. Drag the grip at its top to resize it, or tap the grip to collapse it down to the grip alone and get nearly the whole screen for the map. It rests at three heights: peek, half, and full. Selecting something brings it back up from peek; tapping empty map doesn't.
- Press `/` to jump to search and `Esc` to clear a selection. The browser's back button works, and every map has its own URL you can bookmark.

### Paths

**Find a path from here** draws a route between two points, following the strongest connections all the way. On a song map, that's a running order: a way from one song to another without an abrupt jump.

Once you've started a path, the other end can be anything:

- **A node on the current map.** The route is drawn immediately.
- **Anything else**, found through the search bar. The map is rebuilt by growing outward from both ends until they meet, then keeps the route and the music around it.

Song paths try to connect directly first. When Last.fm's song data is too thin for that (it often is), the route follows the two songs' **artists** instead and picks one song per artist along the way, choosing at each step the track that follows best from the previous pick and leads toward the next stop. The panel says which kind of route you got.

Paths have their own URLs too, so `#path/artist/Bon%20Iver/to/artist/Burial` can be bookmarked or shared. If one end is a song and the other an artist, the artist becomes their most played song (or the song becomes its artist) so both ends match. **Clear path** puts the surrounding map back, and **Show the path again** re-draws it.

## How it works

**Data.** Last.fm's similar-artist and similar-track lists come from what millions of listeners play together. Tags are user-applied, which is why you get moods like "melancholic" as well as genres.

**Building a map.** Undertone fetches the seed's similar list, then fetches similar lists for the strongest dozen neighbors and links them to each other. That second pass turns a star around the seed into a real network. Each hub contributes only its 10 strongest links, so maps stay readable. Vibe maps score artists by how high they rank across all your tags, then connect them the same way.

**Color.** Colors come from the layout itself. The seed sits near-white at the center, and color gets more vivid with distance, with the direction setting the hue. Since the force layout pulls similar music together, neighbors share hues and distant corners of the map land on opposite sides of the color wheel. Colors use OKLCH so every hue has the same perceived brightness.

**Paths between two ends.** When the two points aren't on the same map, Undertone grows outward from both at once, strongest links first, checking after each round whether the two sides have met. Every fetch also links back to what's already been found, so by the time they touch there's a real weighted graph to search, and the route returned is the smoothest one through it rather than the first one that closed the gap. The map then shows the route plus the closest music around each step.

The budget counts fetches (one artist or song asked for its similar list), not results: 32 by default, up to 96, each returning up to 50 neighbors. If the search runs out of budget you can widen it; if it runs out of places to look, or hits the ceiling, it says so rather than pretending more searching would help.

**Why songs route through artists.** Artist space is small and dense — every artist has 50+ links, so two artist neighborhoods nearly always overlap within a couple of hops each. Song space is enormous and sparse, and `track.getSimilar` clusters tightly inside one artist or scene, so two song neighborhoods often never touch. So a song path gets a short direct attempt (20 fetches), then falls back to the artist path and fills in one song per artist. That song-picking step is the seed of the playlist engine: it scores each candidate on how well it follows the previous pick and leads toward the next stop, and key and tempo will join that score once Spotify and ReccoBeats land.

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
    build.js       Builds artist, song, vibe, and path maps; grows maps from a node
    analysis.js    Scenes, bridges, paths, farthest node
    color.js       Spectral coloring
  ui/
    graphView.js   D3 rendering, force layout, zoom, hover, labels
    search.js      Search box with artist, song, and vibe results
    panel.js       Details panel
    sheet.js       Bottom-sheet behavior for the panel on small screens
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

- **Next:** Turn a path into a playlist. A finished route is already an ordered list of songs, so it wants a "Create playlist" button (saved to Spotify via the Create Playlist endpoint) and an "Add to queue" for listening right away. Needs v2's Spotify login first.
- **v2:** Spotify login (PKCE, with `http://127.0.0.1:5173` as the redirect URI), album art, key and BPM from ReccoBeats, and the Camelot wheel track view.
- **v3:** Playlist builder with smooth transitions, saved to Spotify. Key and tempo join the song-picking score, which today runs on co-listening and tags alone.
- **Stretch:** Run two searches on one canvas at once, to see whether — and how — they connect. Bigger lift: today's layout and coloring both assume a single seed per map.
- **Later:** An LLM or local embeddings to turn free-text vibes like "forest green focus" into Last.fm tags.
