# ScrinDeck

A real-time digital signage control panel and display player. Upload image/video assets, build repeatable playlists and layouts, and keep the display device playing cached media when connectivity drops.

## Features

- Media library for image and video uploads
- Playlist playback with per-item durations
- Display-side browser caching for repeat/offline playback
- Text slide and schedule modes for notices
- Multiple display themes and live font sizing
- Real-time sync via WebSockets

## Tech Stack

- Node.js + Express
- Socket.io for real-time communication
- Multer for media uploads
- Vanilla JavaScript and browser Cache Storage

## Quick Start

```bash
npm install
npm start
```

Open:

- Control Panel: `http://localhost:3000/control.html`
- Display Player: `http://localhost:3000/display.html`
- About Page: `http://localhost:3000/about.html`

Local development uses admin password `screen` unless you set `ADMIN_PASSWORD`.

## Authentication

The display player is public so a signage device can open `/display.html` and receive live updates. The control panel, media uploads, media deletion, Bible/text/schedule controls, and all Socket.io write actions require admin authentication.

Production requires:

- `ADMIN_PASSWORD`: the password used to sign in at `/login.html`
- `AUTH_SECRET`: a long random string used to sign the admin cookie

Example local run:

```bash
ADMIN_PASSWORD="choose-a-strong-password" AUTH_SECRET="$(openssl rand -base64 32)" npm start
```

## Persistent Storage

By default, saved settings live in `data/` and uploaded media lives in `uploads/media/`.
In production, set `PERSISTENT_ROOT` to a durable disk path. The app will store:

- `${PERSISTENT_ROOT}/data`
- `${PERSISTENT_ROOT}/uploads/media`

## Media Caching

When a media playlist is sent to the display player, the player downloads each image/video into browser cache. If the network disconnects, the currently loaded player keeps cycling the cached playlist. The service worker also helps reload the display page and media assets from cache after the display has been opened once online.

## Project Structure

```text
├── server.js             # Express + Socket.io server
├── data/
│   ├── display-state.json # Saved display/ticker/layout settings
│   ├── media.json        # Uploaded media asset metadata
│   ├── songs.json        # Saved text slide sets
├── uploads/
│   └── media/            # Uploaded image/video files
├── public/
│   ├── index.html        # Landing page
│   ├── about.html        # App overview and usage guide
│   ├── control.html      # ScrinDeck control interface
│   ├── display.html      # Display player
│   └── sw.js             # Offline cache service worker
└── package.json
```

## Deployment

The app can run anywhere that supports persistent Node.js WebSocket connections and durable disk storage for `uploads/media` and `data/media.json`.

### Railway

Railway can deploy this repo directly from GitHub. Attach a Railway Volume to the web service so uploaded media and saved settings persist across deploys. The app automatically uses Railway's `RAILWAY_VOLUME_MOUNT_PATH` when a volume is attached.

Recommended Railway settings:

- Source repo: `Raphdon832/OnScreenDisplay`
- Start command: `npm start`
- Volume mount path: `/data`
- Environment variables:
  - `NODE_ENV=production`
  - `ADMIN_PASSWORD=<your control panel password>`
  - `AUTH_SECRET=<long random string>`

The Railway Free plan includes a small persistent volume, so keep video uploads light.

### Render

This repo includes `render.yaml` for Render:

- Web service runtime: Node
- Build command: `npm install`
- Start command: `npm start`
- Health check: `/api/health`
- Persistent disk mounted at `/var/data`
- `PERSISTENT_ROOT=/var/data`
- `ADMIN_PASSWORD` is entered during Blueprint setup
- `AUTH_SECRET` is generated automatically by Render

After deploy:

- Control Panel: `https://your-app.onrender.com/control.html`
- Display Player: `https://your-app.onrender.com/display.html`
