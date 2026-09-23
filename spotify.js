// Spotify control through the official Web API (needs Spotify Premium).
// Sign-in uses PKCE, so only a client ID is needed, no secret. The ID comes
// from SPOTIFY_CLIENT_ID in .env; the token is kept in the app's data folder.

import { app, shell } from "electron";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import crypto from "node:crypto";

// Must match the redirect URI registered in the Spotify developer dashboard.
const PORT = 8888;
const REDIRECT = `http://127.0.0.1:${PORT}/callback`;
const SCOPES = "user-read-playback-state user-modify-playback-state user-read-currently-playing";
const tokenFile = () => path.join(app.getPath("userData"), "spotify-token.json");

const clientId = () => process.env.SPOTIFY_CLIENT_ID?.trim();
const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function loadToken() {
  try {
    return JSON.parse(fs.readFileSync(tokenFile(), "utf8"));
  } catch {
    return null;
  }
}
function saveToken(t) {
  fs.mkdirSync(path.dirname(tokenFile()), { recursive: true });
  fs.writeFileSync(tokenFile(), JSON.stringify(t));
}

async function tokenRequest(params) {
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId(), ...params }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.error || `token ${res.status}`);
  const old = loadToken() || {};
  const token = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || old.refresh_token,
    expires_at: Date.now() + (data.expires_in - 60) * 1000,
  };
  saveToken(token);
  return token;
}

async function accessToken() {
  let t = loadToken();
  if (!t?.refresh_token) return null;
  if (Date.now() > t.expires_at) t = await tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh_token });
  return t.access_token;
}

export const spotifyReady = () => !!clientId() && !!loadToken()?.refresh_token;

export function connectSpotify() {
  if (!clientId()) {
    return Promise.resolve("Spotify isn't set up yet: SPOTIFY_CLIENT_ID is missing from .env. The user needs to do the Spotify setup steps in the README first.");
  }
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const state = b64url(crypto.randomBytes(12));
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, REDIRECT);
      if (url.pathname !== "/callback") return res.end();
      const code = url.searchParams.get("code");
      if (!code || url.searchParams.get("state") !== state) {
        res.end("Spotify sign-in was cancelled. You can close this tab.");
        server.close();
        return resolve("Spotify sign-in was cancelled.");
      }
      try {
        await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verifier });
        res.end("Spotify connected! You can close this tab and go back to your companion.");
        resolve("Spotify is connected.");
      } catch (err) {
        res.end("Spotify sign-in failed. You can close this tab.");
        resolve(`Spotify sign-in failed: ${err.message}`);
      }
      server.close();
    });
    server.on("error", (err) => resolve(`Couldn't start the sign-in listener on port ${PORT}: ${err.message}`));
    server.listen(PORT, "127.0.0.1", () => {
      const q = new URLSearchParams({
        client_id: clientId(),
        response_type: "code",
        redirect_uri: REDIRECT,
        code_challenge_method: "S256",
        code_challenge: challenge,
        scope: SCOPES,
        state,
      });
      shell.openExternal(`https://accounts.spotify.com/authorize?${q}`);
    });
    setTimeout(() => {
      server.close();
      resolve("Spotify sign-in timed out after 3 minutes. Try again when ready.");
    }, 180000);
  });
}

async function api(method, route, body) {
  const token = await accessToken();
  if (!token) throw new Error("not connected");
  const res = await fetch(`https://api.spotify.com/v1${route}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body && { "Content-Type": "application/json" }) },
    body: body && JSON.stringify(body),
  });
  if (res.status === 204) return null;
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const reason = data?.error?.reason || data?.error?.message || res.status;
    const err = new Error(String(reason));
    err.status = res.status;
    throw err;
  }
  return data;
}

// Playback needs a running Spotify app ("device"). If none is awake, open the
// desktop app and wait for it to show up.
async function findDevice(openApp) {
  const pick = (list) => list.find((d) => d.is_active) || list.find((d) => d.type === "Computer") || list[0];
  let { devices } = await api("GET", "/me/player/devices");
  if (devices.length) return pick(devices);
  await openApp("Spotify");
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    ({ devices } = await api("GET", "/me/player/devices"));
    if (devices.length) return pick(devices);
  }
  return null;
}

const describe = (item) => {
  if (!item) return "";
  const who = item.artists?.map((a) => a.name).join(", ") || item.owner?.display_name || "";
  return who ? `${item.name} by ${who}` : item.name;
};

// Is something playing right now? Used to switch dance mode on and off.
export async function playbackState() {
  if (!spotifyReady()) return { playing: false };
  const now = await api("GET", "/me/player/currently-playing");
  return { playing: !!now?.is_playing, title: describe(now?.item) };
}

export const SPOTIFY_TOOLS = [
  {
    name: "connect_spotify",
    description: "Start the Spotify sign-in so music can be played and controlled. Opens a browser tab for the user.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "spotify_play",
    description: "Find something on Spotify and start playing it right away (opens the Spotify app if needed). Use kind 'track' for a song, 'playlist' for a mood or genre (e.g. 'lo-fi beats'), 'album', or 'artist'.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for, e.g. 'Blinding Lights The Weeknd' or 'chill lofi'." },
        kind: { type: "string", enum: ["track", "playlist", "album", "artist"] },
      },
      required: ["query", "kind"],
    },
  },
  {
    name: "spotify_control",
    description: "Control Spotify playback: pause, resume, next, previous, or set volume (0-100).",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["pause", "resume", "next", "previous", "volume"] },
        volume: { type: "number" },
      },
      required: ["action"],
    },
  },
  {
    name: "spotify_now_playing",
    description: "Say what's playing on Spotify right now.",
    input_schema: { type: "object", properties: {} },
  },
];

export const SPOTIFY_STATUS = {
  connect_spotify: "Waiting for Spotify sign-in…",
  spotify_play: "Putting on music…",
  spotify_control: "Controlling Spotify…",
  spotify_now_playing: "Checking Spotify…",
};

const NOT_CONNECTED = "Spotify isn't connected yet. Offer to connect it (connect_spotify).";

function friendly(err) {
  if (err.status === 403) return "Spotify refused: playback control needs Spotify Premium on this account.";
  if (err.status === 404) return "Spotify has no active player. Ask the user to open Spotify and play anything once, then try again.";
  if (err.message === "not connected") return NOT_CONNECTED;
  return `Spotify error: ${err.message}`;
}

export async function runSpotifyTool(name, input, { openApp }) {
  if (name === "connect_spotify") return spotifyReady() ? "Spotify is already connected." : connectSpotify();
  if (!spotifyReady()) return NOT_CONNECTED;
  try {
    if (name === "spotify_play") {
      const kind = ["track", "playlist", "album", "artist"].includes(input.kind) ? input.kind : "track";
      if (typeof input.query !== "string" || !input.query.trim() || input.query.length > 200) return "Need something to search for.";
      const q = new URLSearchParams({ q: input.query.trim(), type: kind, limit: "5" });
      const found = await api("GET", `/search?${q}`);
      const item = found?.[`${kind}s`]?.items?.find(Boolean);
      if (!item) return `Nothing on Spotify matched "${input.query}".`;
      const device = await findDevice(openApp);
      if (!device) return "Opened Spotify, but it didn't come online in time. Try again in a moment.";
      const body = kind === "track" ? { uris: [item.uri] } : { context_uri: item.uri };
      await api("PUT", `/me/player/play?device_id=${encodeURIComponent(device.id)}`, body);
      return `Now playing ${describe(item)} on ${device.name}.`;
    }
    if (name === "spotify_control") {
      const route = { pause: "/me/player/pause", resume: "/me/player/play", next: "/me/player/next", previous: "/me/player/previous" }[input.action];
      if (input.action === "volume") {
        const v = Number(input.volume);
        if (!Number.isFinite(v)) return "Need a volume from 0 to 100.";
        await api("PUT", `/me/player/volume?volume_percent=${Math.round(Math.min(Math.max(v, 0), 100))}`);
        return `Volume set to ${Math.round(Math.min(Math.max(v, 0), 100))}%.`;
      }
      if (!route) return "Unknown action.";
      await api(input.action === "next" || input.action === "previous" ? "POST" : "PUT", route);
      return "Done.";
    }
    if (name === "spotify_now_playing") {
      const now = await api("GET", "/me/player/currently-playing");
      if (!now?.item) return "Nothing is playing on Spotify.";
      return `${now.is_playing ? "Playing" : "Paused on"} ${describe(now.item)}.`;
    }
  } catch (err) {
    return friendly(err);
  }
  return `Unknown tool: ${name}`;
}
