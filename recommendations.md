# ScrinDeck Recommendations

These are the highest-impact improvements for turning ScrinDeck from a single-instance signage tool into a stronger product for real customers and multiple displays.

## 1. Multi-user Accounts and Tenant Isolation

- Add organizations/workspaces so each customer has separate displays, media, playlists, schedules, and settings.
- Add roles such as Owner, Admin, Editor, and Viewer.
- Prevent one customer from seeing or modifying another customer's data.

## 2. Move Media Storage out of the App Volume

- Store uploaded media in object storage instead of only using the Railway service volume.
- Good options include Railway Storage Buckets, Cloudflare R2, Backblaze B2, or S3-compatible storage.
- Add per-user folders and storage quotas.
- Keep the app volume for app/runtime data only, not large customer media libraries.

## 3. Display Pairing System

- Make each display show a pairing code on first launch.
- Let an admin enter the code in the control panel to bind that display to their workspace.
- Store display identity, friendly name, location, orientation, and assigned playlist/campaign.

## 4. Display Health Dashboard

- Show whether each display is online or offline.
- Show current playlist/layout, last sync time, cache status, and storage usage.
- Add quick actions such as force sync, restart playlist, clear cache, and identify display.

## 5. Better Scheduling

- Add campaigns as grouped playlists/layouts.
- Support dayparting, such as morning, afternoon, evening, weekday, and weekend schedules.
- Add priority or emergency overrides for urgent messages.

## 6. Better Offline and Cache Visibility

- Show cache progress, such as "8/10 media files cached".
- Warn if an image or video failed to cache.
- Add "force cache refresh" and "clear display cache" actions.
- Keep an obvious offline indicator on the display/player.

## 7. Drag-and-drop Layout Editor

- Let users visually place media into layout zones instead of only selecting from dropdowns.
- Add a live preview before publishing.
- Support both landscape and portrait templates.

## 8. Media Processing

- Generate thumbnails for uploaded videos and images.
- Validate supported formats.
- Show file size, duration, dimensions, and storage usage.
- Add optional compression or optimization for large videos.

## 9. Security Hardening

- Replace the single shared admin password with real user accounts.
- Add password reset, invite links, rate limits, audit logs, and better session management.
- Track important actions such as media deletion, schedule changes, and display pairing.

## 10. Billing and Plan Limits

- Add plan limits for displays, storage, users, and workspaces.
- Example plans:
  - Free: 1 display and limited storage.
  - Basic: a few displays and more media storage.
  - Pro: more displays, larger storage, teams, and advanced scheduling.
- Enforce quotas at upload time and display clear usage meters.

## Recommended Build Order

1. Multi-user/workspace data model.
2. Display pairing.
3. Object storage for media.
4. Display health dashboard.
5. Drag-and-drop layout editor.
6. Billing and plan limits.

The main architectural shift is that ScrinDeck should move from one global playlist/state to many workspaces, each with its own displays, media, layouts, schedules, and cache status.
