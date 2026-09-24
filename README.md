# Movie-Downloads

A lightweight web app for streaming movies from your own shared library in the browser.

## What it does

- Streams video over HTTP with byte-range support for smoother playback, seeking, and background buffering
- Lets viewers watch online in a dedicated page instead of browsing a cloud-drive file listing
- Automatically lists supported movie files from the local `movies/` folder

## Getting started

1. Put movie files such as `.mp4`, `.m4v`, `.mov`, `.webm`, `.ogg`, or `.mkv` into the project’s `movies/` folder
2. Start the app:

   ```bash
   npm start
   ```

3. Open `http://localhost:3000`
4. Share that URL through your preferred hosting or tunnel so friends and family can watch online

## Commands

- `npm start` — start the streaming web app
- `npm test` — run the focused server tests
