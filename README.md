# protobytes-2.0-team-prophecy (Strata)

Strata is an all-in-one workspace reduces cognitive overhead by ensuring that all tasks occur within a single, context-aware environment. Ultimately, this streamlined approach allows teams to reclaim lost hours and align their technical output with their creative intent.

## Features

- Animated landing page experience with video background
- `/ide` route that loads the browser IDE experience
- Express server to serve the built frontend (`client/dist`) with compression
- Docker + docker-compose setup to run OpenVSCode Server in the browser
- Strata Agent extension (prototype) that supports chat + tool actions (and uses `GEMINI_API_KEY`)

## Tech Stack

### Frontend

- React 18
- Vite
- Tailwind CSS
- Framer Motion

### Backend (static hosting)

- Node.js
- Express
- compression

### Browser IDE

- Docker
- OpenVSCode Server (base image `gitpod/openvscode-server`)

### AI/Agent

- VS Code extension (`strata-vscode-extension`)
- `@google/genai` (Gemini)

## Repository Structure

```text
client/                  React + Vite frontend
server/                  Express server for built frontend
strata-vscode-extension/ Strata Agent VS Code extension source
docker-compose.yml       OpenVSCode Server container config
Dockerfile               OpenVSCode Server base + runtimes
.env.example             Environment variables template
```

## Prerequisites

- Node.js + npm
- Docker Desktop (for the browser IDE)

## Environment Variables

Copy `.env.example` to `.env` and set values:

- `OPENVSCODE_SERVER_CONNECTION_TOKEN` (required for OpenVSCode browser IDE auth)
- `GEMINI_API_KEY` (required for the Strata Agent extension)
- `TZ` (optional)
- `USER_ID` (optional; used to separate docker volumes per user)

## Setup: Background Video (Landing Page)

The landing page expects the hero video at:

`client/public/media/strata-hero.mp4`

If you have a different file name/path, update the `src` in `client/src/App.jsx`.

## Run the Frontend (Development)

```bash
cd client
npm install
npm run dev
```

Vite will print a URL (commonly `http://localhost:5173`).

## Build + Serve (Production-like)

Build the frontend:

```bash
cd client
npm install
npm run build
```

Serve it with the Node/Express server:

```bash
cd server
npm install
npm start
```

By default the server runs on `http://localhost:4173` (or `PORT` if set).

## Run the Browser IDE (OpenVSCode Server)

This repo includes a docker-compose setup that starts OpenVSCode Server.

1. Create `.env` from `.env.example` and set `OPENVSCODE_SERVER_CONNECTION_TOKEN`.
2. Start the container:

```bash
docker compose up --build
```

3. Open:

`http://localhost:3100`

If a token is required in the URL, use:

`http://localhost:3100/?tkn=<OPENVSCODE_SERVER_CONNECTION_TOKEN>`

## Using the `/ide` Route

The frontend includes an `/ide` route that loads the in-browser IDE experience.

1. Start OpenVSCode Server (Docker) so it is reachable at `http://localhost:3100`.
2. Start the frontend dev server (`npm run dev` in `client/`).
3. Open the IDE route:

`http://localhost:5173/ide`

The React app embeds the IDE and expects OpenVSCode to be available on `http://localhost:3100`.

## Strata Agent Extension

The extension source is in `strata-vscode-extension/`.

To use Gemini features, ensure `GEMINI_API_KEY` is set in your environment (or in `.env` for the docker-compose flow).

## Team Members

- Aashish Bam
- Samman Thapaliya
