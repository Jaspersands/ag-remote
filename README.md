# AG-Remote

A secure web interface for remotely controlling the [Antigravity](https://antigravity.dev) desktop app from any browser — on your phone, tablet, or another computer.

AG-Remote connects directly to your running Antigravity desktop instance via Chrome DevTools Protocol (CDP) and mirrors the full experience: project list, conversation history, messages, and tool approvals — all in real time over WebSocket.

---

## Features

- 🔒 **Google OAuth authentication** — Only your authorized accounts can connect
- 🪐 **Full workspace mirroring** — Projects, conversations, and messages synced live from the desktop app
- 🛡️ **Tool approval interface** — Approve or deny tool executions remotely with the same options as the desktop
- 📎 **File attachments** — Attach files to messages from your mobile device
- ⚙️ **Per-account settings** — Theme, collapsed projects, and preferences are stored per Google account
- 🌐 **Usage stats** — Live project/conversation counts, weekly reset countdown, and 5-hour rolling window tracking

---

## How It Works

```
Your Browser  ──WebSocket──▶  AG-Remote Server  ──CDP──▶  Antigravity Desktop App
```

The AG-Remote server (`server.py`) runs locally on your machine alongside the Antigravity desktop app. It:
1. Discovers the Antigravity app's Chrome DevTools port automatically
2. Injects JavaScript into the Antigravity page to scrape state (projects, conversations, messages, pending tools)
3. Broadcasts that state to connected browsers over WebSocket
4. Forwards your actions (send message, approve tool, new conversation) back to the desktop app

---

## Setup

### 1. Prerequisites

- [Antigravity desktop app](https://antigravity.dev) installed and running
- Python 3.10+
- A Google Cloud project with OAuth 2.0 credentials (Web Application type)

### 2. Install dependencies

```bash
pip install -r requirements.txt
```

### 3. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
# Your Google OAuth Client ID (from Google Cloud Console → APIs & Services → Credentials)
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com

# Only these Google accounts can log in (comma-separated). Leave blank to allow any.
ALLOWED_EMAILS=you@gmail.com,teammate@gmail.com

# Secure session cookie secret (auto-generated if left empty)
SESSION_SECRET=
```

### 4. Configure Google OAuth

In [Google Cloud Console](https://console.cloud.google.com/):

1. Go to **APIs & Services → Credentials**
2. Create or edit an **OAuth 2.0 Client ID** (Web Application type)
3. Add your server's origin to **Authorized JavaScript Origins**:
   - `http://localhost:8020` (for local access)
   - `https://your-domain.com` (if exposing publicly, e.g. via Tailscale or ngrok)
4. No redirect URIs needed — authentication uses Google Identity Services (token flow)

### 5. Run the server

```bash
python server.py
```

The server starts on **port 8020** by default. Open `http://localhost:8020` in your browser.

---

## Accessing Remotely

AG-Remote is designed for **local network or tunneled access**. Options:

- **[Tailscale](https://tailscale.com)** — Zero-config VPN, recommended. Access via your Tailscale IP from any device.
- **ngrok** — `ngrok http 8020` for a public HTTPS URL (add the ngrok domain to your Google OAuth authorized origins)
- **Local network** — Access via your machine's local IP (`http://192.168.x.x:8020`) on the same WiFi

> ⚠️ Do not expose port 8020 directly to the public internet without authentication and HTTPS.

---

## Architecture

| File | Purpose |
|------|---------|
| `server.py` | FastAPI backend — auth, WebSocket hub, CDP bridge, REST API |
| `agent.py` | WebSocket client bridge for the Antigravity agent protocol |
| `public/index.html` | Single-page app shell |
| `public/app.js` | All frontend logic — WebSocket client, rendering, auth |
| `public/app.css` | Styles |

### Key endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | Serves the web app |
| `GET /api/auth/status` | Check session + get Google Client ID |
| `POST /api/auth/google/token` | Exchange Google access token for session |
| `POST /api/auth/logout` | Clear session cookie |
| `WS /ws` | Main WebSocket — state sync and action forwarding |

---

## Development

The server serves static files from `public/` directly — **no build step needed**. Edit `app.js` or `app.css` and refresh.

```bash
# Run with auto-reload
uvicorn server:app --port 8020 --reload
```

---

## Security Notes

- Session tokens are signed JWTs (HS256) stored as `HttpOnly` cookies
- All WebSocket connections require a valid session
- CDP access is restricted to `localhost` only
- `ALLOWED_EMAILS` is enforced server-side — the client cannot bypass it

---

## License

MIT
