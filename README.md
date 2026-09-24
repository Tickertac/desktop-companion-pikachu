# Desktop Companion

An anime character that sits in the corner of your screen, listens, and talks back.

- **Body:** any `.vrm` model (VRoid Studio exports these), drawn with three.js + three-vrm
- **Ears:** Groq Whisper (`whisper-large-v3-turbo`)
- **Brain:** Claude (Haiku 4.5 by default)
- **Voice:** Kokoro, running locally on your CPU, free

## Setup (Windows)

1. Install [Node.js](https://nodejs.org) (LTS), then in this folder run `npm install`.
2. Copy `.env.example` to `.env` and fill it in:
   - `COMPANION_USER_NAME`: what the companion calls you.
   - `ANTHROPIC_API_KEY`: from console.anthropic.com (pay as you go; Haiku is cheap).
   - `GROQ_API_KEY`: from console.groq.com/keys (free), for hearing your voice.
     If left blank, the key in `~/.config/watch/.env` is used.
3. `npm start`, or double-click the desktop shortcut (see below).
4. To use a different body, drag a `.vrm` file onto the window. It's copied into `models/` and remembered.

The first launch downloads the voice model (about 330 MB) into `~/.desktop-companion`. Later launches take a few seconds.

**Desktop shortcut (Windows):** make a shortcut whose target is
`<this folder>\node_modules\electron\dist\electron.exe "<this folder>"`, with "Start in" set to this folder.
For the Pikachu icon, point the shortcut's icon at `assets\pikachu.ico`.

## Setup (Mac)

1. Install [Node.js](https://nodejs.org) (LTS) and Git (run `git --version` in Terminal; macOS offers to install it).
2. In Terminal:
   ```bash
   git clone https://github.com/Tickertac/desktop-companion-pikachu.git
   cd desktop-companion-pikachu
   npm install
   cp .env.example .env
   open -e .env
   ```
3. Fill in `.env` (same fields as above) and save.
4. `npm start`. To update later: `git pull && npm install`, then `npm start`.
5. The first time, macOS asks to allow the **microphone** (for talking) and, the first time you ask it to
   look at your screen, **Screen Recording** (System Settings > Privacy & Security > Screen Recording,
   allow Electron, then restart the app). The talk shortcut is **Cmd+Shift+Space**.

Spotify and Google are per person: each person signs in with their own account (the Spotify app owner
adds them under **User Management** in the Spotify dashboard; Google test users likewise).

## Using it

- **Talk:** press **Ctrl+Shift+Space** (Mac: **Cmd+Shift+Space**) anywhere (or the 🎤 button), speak, press again to send.
- **Type:** hover the window and press ⌨.
- **Move:** drag the ⠿ handle. **Zoom:** scroll wheel.
- **Forget the conversation:** ↺. **Quit:** ✕.
- **Moves:** ♪ dances, 🎲 does a random move. Or ask: "dance", "spin", "sit", "wave", "stretch",
  "look around", "take a nap", "hop", "go left/right", "come here", "go for a walk".
- On its own it wanders, hops, twirls, waves, sits, stretches or looks around every 25 to 60 seconds,
  and naps if you haven't talked to it for a couple of minutes. Talking wakes it up.
- Excited replies (ending in "!") get both paws up.
- **Dance mode:** whenever music plays on the computer (Spotify, YouTube, games, any app) it dances,
  changing move every 8 counts at the song's tempo. It listens to the computer's sound output only to
  measure level and beat (nothing is recorded or sent), and tells music from people talking by how
  steady the sound is. Spotify playback is also detected directly.
- **Graceful mode:** for soft, slow music (classical, piano, ambient, contemporary) it switches to
  slow, flowing moves with long lines: port de bras, arabesque, plie and rise, side reach, developpe,
  swan arms, lunge reach, and a reverence bow, plus a slow pirouette. It decides from how strong the
  beat is (Windows only; on a Mac, dance mode follows Spotify and stays energetic).
- The speech bubble sits above the head. Empty parts of the window let clicks through.

## What it can help with

Ask in plain words; it picks the right tool.

| Ask | What happens |
|---|---|
| "Remind me in 20 minutes to stretch", "remind me at 3pm to call mum" | Pops up, waves and says it when due. Survives restarts. |
| "What's this error?", "look at my screen" | Takes a screenshot and looks (about $0.002 each on Haiku). |
| "Open YouTube", "open my downloads", "open Spotify" | Websites, folders, files, and Start menu apps. It never runs programs by path. |
| "Fix the spelling in what I copied" | Reads your clipboard and can put the result back. |
| "Weather tomorrow?", "any Pokemon news?" | Web search (about 1 cent per search). |
| "Remember I'm building WHO SIA" | Saved facts go into every chat. "Forget ..." removes them. |
| "Play some lo-fi", "play Blinding Lights", "skip", "pause", "volume 30" | Spotify (Premium). Opens the app if needed. Needs the setup below. |
| "What's on today?", "any unread emails?" | Google Calendar and Gmail, read-only. Needs the setup below. |

Chat history, memory, reminders, sign-ins and the voice model live in `~/.desktop-companion`
(`C:\Users\<you>\.desktop-companion` on Windows), not AppData: Windows can give packaged apps a
private copy of AppData, which split one Pikachu's data in two.

### Google Calendar and Gmail setup (once)

1. Go to https://console.cloud.google.com and create a project (e.g. "Desktop Companion").
2. **APIs & Services > Library**: enable **Google Calendar API** and **Gmail API**.
3. **Google Auth Platform > Branding / Audience**: choose **External**, fill in the app name and your email,
   and under **Test users** add your own Google address.
4. **Clients > Create client**: type **Desktop app**. Download the JSON and save it in this folder as
   `google-credentials.json`.
5. Tell your companion "connect my Google". A browser tab opens; sign in, and on "Google hasn't verified
   this app" click **Continue** (it's your own app). Access is read-only.

While the Google project is in Testing mode, Google makes you sign in again about once a week.

### Spotify setup (once, needs Premium)

1. Go to https://developer.spotify.com/dashboard, log in, and click **Create app**.
2. Any name and description. **Redirect URI**: `http://127.0.0.1:8888/callback` (exactly), then **Add**.
   Tick **Web API**, agree to the terms, **Save**.
3. Open the app's **Settings**, copy the **Client ID**, and put it in `.env` as `SPOTIFY_CLIENT_ID=...`.
4. Restart the companion and say "connect my Spotify". Sign in and click **Agree**.

## Customising

Edit `character.json`:

| Field | What it does |
|---|---|
| `name` | The character's name |
| `userName` | Fallback for what it calls you; `COMPANION_USER_NAME` in `.env` wins. `{user}` in `personality` becomes your name |
| `personality` | The character's personality, in plain English |
| `model` | `claude-haiku-4-5` (cheapest), `claude-sonnet-5` (smarter), `claude-opus-5` |
| `voice` | Kokoro voice, e.g. `af_heart`, `af_bella`, `af_nicole`, `bf_emma`, `bf_lily` |
| `speakingSpeed` | 1.0 is normal |
| `pitch` | 1.0 is natural; 1.3 to 1.5 sounds cartoonish |
| `windowScale` | Size of the window: 1 is 380x620, 0.75 is three quarters |
| `headTilt` | Resting nod in radians (+ is down). Use it if a model always seems to look up or down |

## Debug

`~/.desktop-companion/companion.log` records music detection and errors (fresh each launch).
`~/.desktop-companion/boot.log` records every launch, which data folder it used, and any crash.

`npx electron . --snapshot` renders for 5 seconds, saves `snapshot.png`, and quits.
