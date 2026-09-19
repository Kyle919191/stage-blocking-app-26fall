[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

# Stage Blocking App

A web-based system for recording stage blocking in theater productions. Directors and stage managers can mark actor positions during rehearsals, edit dialogue, add notes, and optionally sync across multiple users via Firebase.

## Features

- **Real-time Blocking Marks** — Click on the stage layout to mark actor positions; supports drag, curved paths, and multi-select
- **Dialogue Editing** — Double-click to edit lines; add/delete lines with real-time sync
- **Notes System** — Add director's notes at precise positions within dialogue (movement cues, performance notes, etc.)
- **Multi-user Sync** — Firebase Realtime Database for automatic multi-user synchronization (optional)
- **Scene/Character Management** — Manage blocking by scene; switch between dialogue view and character view
- **Version Management** — Save version snapshots and restore to any previous version
- **PDF Export** — Export blocking notes as PDF with stage layouts and dialogue side by side
- **Stage Image Management** — Upload and manage multiple stage layouts per scene
- **Undo** — Ctrl+Z support for undoing blocking operations

## Quick Start (No Firebase)

The app works **without Firebase** in read-only mode — useful for trying it out or reviewing exported blocking notes.

```bash
# Clone the repo
git clone https://github.com/Rice-Chinese-Theater-Club/stage-blocking-app.git
cd stage-blocking-app

# Serve with any static file server
python3 -m http.server 8000
# or: npx serve .
```

Open `http://localhost:8000`. The app will load the sample data from `data/` and display it. You can browse scenes, view blocking marks, and export to PDF.

**Limitations without Firebase:** Edits are not saved — any changes to blocking, notes, or lines are lost on page refresh. Multi-user sync is disabled.

## Full Setup (with Firebase)

To enable saving, real-time sync, and collaboration, you need a Firebase project.

### Step 1: Create a Firebase Project

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Click **Add project** and follow the prompts
3. In the project dashboard, click the **web icon** (`</>`) to register a web app
4. Copy the `firebaseConfig` object from the setup screen

### Step 2: Enable Realtime Database

1. In your Firebase project, go to **Build → Realtime Database**
2. Click **Create Database**
3. Choose a location and start in **test mode** (you can lock down rules later)
4. Your database URL will look like `https://your-project-id-default-rtdb.firebaseio.com`

### Step 3: Configure the App

Edit `js/config.js` and fill in your Firebase values:

```javascript
export const firebaseConfig = {
    apiKey: "AIzaSy...",              // Required
    authDomain: "myapp.firebaseapp.com",  // Required
    databaseURL: "https://myapp-default-rtdb.firebaseio.com",  // Required
    projectId: "myapp",              // Required
    storageBucket: "myapp.appspot.com",   // Required
    messagingSenderId: "123456789",  // Required
    appId: "1:123456789:web:abc",    // Required
    measurementId: "G-XXXXXXXXXX"    // Optional (analytics only)
};
```

The other config fields:

| Field | Required | Description |
|-------|----------|-------------|
| `DRIVE_UPLOAD_URL` | No | Google Apps Script URL for uploading images to Google Drive. Leave as placeholder if not needed. |
| `GITHUB_WORKFLOW_TOKEN` | No | GitHub PAT for triggering Actions workflows (data backup). Leave as placeholder if not needed. |
| `GITHUB_REPO` | No | `org/repo` string for GitHub Actions integration. |
| `features.*` | No | Feature flags to toggle search, GitHub sync, versions, and PDF export. |

### GitHub data snapshot on "保存版本"

This repo includes `.github/workflows/sync-firebase.yml` and `scripts/export_firebase_snapshot.py`.
When triggered, it exports dataset data nodes (台词/走位/notes/版本等) from Firebase and commits JSON snapshots under:

```text
snapshots/firebase/dataset-{dataset}/latest/*.json
snapshots/firebase/dataset-{dataset}/by-version/{timestamp}--{version-name}/*.json
```

To enable it:

1. Add GitHub repository secrets:
   - `FIREBASE_DATABASE_URL` (required)
   - `FIREBASE_DB_AUTH_TOKEN` (optional; use if your DB rules require auth)
2. In Vercel Project Settings -> Environment Variables, set:
   - `GITHUB_REPO` (e.g. `owner/repo`)
   - `GITHUB_WORKFLOW_TOKEN` (PAT that can dispatch Actions workflows)
3. (Optional hardening) set `SYNC_API_KEY` in Vercel env, then in browser set:
   - `localStorage.setItem('syncApiKey', 'your-key')`
   so frontend calls include `x-sync-key`.

Notes:
- The app dispatches `POST /api/trigger-sync` and the server dispatches workflow `sync-firebase.yml`.
- Frontend no longer stores GitHub PAT.
- Firebase 版本保存成功不依赖 GitHub 同步；GitHub 失败不影响 Firebase 版本本身。

### Step 4: Run

```bash
python3 -m http.server 8000
```

Open `http://localhost:8000`. Blocking data now saves to Firebase automatically.

## Dataset Switching (Testing Sets)

You can switch between isolated datasets by adding a URL parameter:

```text
http://localhost:8000/?dataset=default
http://localhost:8000/?dataset=test-a
https://your-vercel-app.vercel.app/?dataset=test-b
```

For non-default datasets, data is stored under:

```text
datasets/{datasetId}/blockingData
datasets/{datasetId}/dialogueEdits
datasets/{datasetId}/lineOperations
datasets/{datasetId}/notes
datasets/{datasetId}/versions
datasets/{datasetId}/scenes
datasets/{datasetId}/sceneStageMap
datasets/{datasetId}/stageLibrary
datasets/{datasetId}/commonActions
datasets/{datasetId}/scriptData/{characters|scenes|lines}
```

Notes:
- If `dataset` is missing, the app uses `default`.
- `default` keeps backward compatibility by reading/writing the legacy top-level nodes (`blockingData`, `notes`, etc.).
- Anyone with the link can switch datasets by changing `?dataset=...`.
- If `scriptData/*` is not present in Firebase for a dataset, the app falls back to local `data/*.json`.

### Automation CLI for dataset setup

Use `scripts/dataset_admin.py` to seed and modify dataset-specific script data without manual Firebase editing:

```bash
# Seed one dataset from local data/*.json
python3 scripts/dataset_admin.py seed-script-data --dataset testing1

# Add one character to a dataset
python3 scripts/dataset_admin.py add-character --dataset testing1 --name John

# Check counts
python3 scripts/dataset_admin.py show-dataset --dataset testing1
```

When you ask Cursor something like "add character John for dataset=testing1", it can run this script for you.

## Preparing Your Script Data

Edit the JSON files under `data/` to match your production. Only three files are required:

### `characters.json`

```json
[
  {
    "id": "alice",
    "name": "Alice",
    "fullName": "Alice Chen",
    "color": "#fde2e4"
  }
]
```

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique identifier (used internally) |
| `name` | Yes | Short display name (shown on stage layout markers) |
| `fullName` | Yes | Full name (shown in character lists) |
| `color` | Yes | Hex color for this character's markers and highlights |

### `scenes.json`

```json
[
  {
    "id": "1-1",
    "name": "Act 1 Scene 1",
    "subtitle": "The arrival",
    "stageMap": "act1/stage.png",
    "characters": ["alice", "bob"]
  }
]
```

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique scene identifier (e.g., `"1-1"`, `"2-3"`) |
| `name` | Yes | Display name |
| `subtitle` | No | Optional subtitle |
| `stageMap` | No | Path to a stage layout image relative to `stage-layouts/` |
| `characters` | No | Array of character `id`s in this scene |

### `lines.json`

```json
[
  {
    "sceneId": "1-1",
    "character": "alice",
    "content": "Hello, is anyone there?",
    "isStageDirection": false,
    "lineNumber": 1
  },
  {
    "sceneId": "1-1",
    "character": null,
    "content": "(Alice enters from stage left)",
    "isStageDirection": true,
    "lineNumber": null
  }
]
```

| Field | Required | Description |
|-------|----------|-------------|
| `sceneId` | Yes | Which scene this line belongs to |
| `character` | Yes* | Character `id` who speaks this line. `null` for stage directions. |
| `content` | Yes | The dialogue text or stage direction |
| `isStageDirection` | Yes | `true` for stage directions, `false` for spoken lines |
| `lineNumber` | No | Line number for display. `null` for stage directions. |

The other data files (`blockingData.json`, `dialogueEdits.json`, `lineOperations.json`, `sceneCharacters.json`, `versions.json`) are generated by the app at runtime via Firebase. You can leave them as empty objects `{}` or empty arrays `[]`.

## Adding Stage Layouts

Place your stage layout images in the `stage-layouts/` directory:

```
stage-layouts/
├── default-blank.png      # Fallback blank stage
├── layout_1.png           # Named layouts (selectable in-app)
├── layout_2.png
└── act1/
    └── stage.png          # Per-act default (matched by scenes.json stageMap field)
```

Supported formats: PNG, JPG. Recommended size: 800×600 or similar landscape ratio.

## Tech Stack

- HTML5 / CSS3 / JavaScript (ES Modules)
- Firebase Realtime Database (v8 compat SDK, loaded via CDN)
- jsPDF + html2canvas (PDF export)
- No build step — serve the directory as-is

## License

[MIT](LICENSE)
