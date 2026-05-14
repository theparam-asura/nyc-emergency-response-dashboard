# NYC 911 Live Dashboard Prototype

This is a college-project prototype for an emergency response dashboard. It is not a real 911 system.

## What It Does

- Caller page collects emergency details.
- Browser asks for live GPS permission.
- Caller coordinates are sent to the backend with Socket.IO.
- Responder dashboard receives live incident updates.
- Leaflet displays the caller location on an OpenStreetMap map.
- Operators can mark an incident as resolved.
- Caller speech can be converted into a live transcript in Chrome-based browsers.
- The dashboard shows dispatch guidance from OpenAI when `OPENAI_API_KEY` is set, otherwise it uses a local rule-based fallback.
- Nearby police stations, fire stations, and hospitals are searched from the caller's GPS location.
- The dashboard can simulate dispatching EMS, fire, or police units and track their movement toward the caller.
- SQLite stores incident records, timeline events, transcripts, dispatcher messages, and dispatch updates.
- The caller page includes a two-way call room where dispatcher messages appear as text and can be spoken aloud by the browser.
- The dashboard includes a prototype login gate, priority scoring, timeline, call log, map layer toggles, and responder status controls.

## Project Structure

```text
nyc-911-live-dashboard/
  server.js
  package.json
  README.md
  public/
    index.html
    dashboard.html
    css/
      style.css
    js/
      caller.js
      dashboard.js
```

## Run Locally

1. Install Node.js from `https://nodejs.org/`.
2. Open a terminal in this folder.
3. Install dependencies:

```bash
npm install
```

4. Start the app:

```bash
npm start
```

5. Open the caller page:

```text
http://localhost:3000
```

6. Open the responder dashboard in another tab:

```text
http://localhost:3000/dashboard
```

Dashboard access code:

```text
dispatcher
```

SQLite data is saved here:

```text
data/emergency-dashboard.sqlite
```

## Optional OpenAI Setup

The app works without an OpenAI key, but AI guidance becomes rule-based. To enable OpenAI-backed dispatch guidance, set an environment variable before starting:

```powershell
$env:OPENAI_API_KEY="your_api_key_here"
npm start
```

You can also choose a model:

```powershell
$env:OPENAI_MODEL="gpt-4.1-mini"
npm start
```

Do not commit API keys to GitHub.

## Test Voice And Dispatch Guidance

1. Open `http://localhost:3000/dashboard`.
2. Open `http://localhost:3000`.
3. Submit the emergency form.
4. Allow location permission.
5. Click `Start Voice Transcript`.
6. Allow microphone permission.
7. Speak a sample emergency description.
8. Confirm the dashboard updates with transcript, guidance, location, and nearby facilities.
9. On the dashboard, click `Dispatch EMS`, `Dispatch Fire`, or `Dispatch Police`.
10. Watch the simulated unit marker and route move toward the caller.
11. Send a dispatcher message from the dashboard.
12. Confirm the caller page displays the message and speaks it aloud when `Speak` is checked.
13. Change responder status to `Arrived`, `Transporting`, or `Cleared`.
14. Confirm the timeline and SQLite database retain the call data.

## Testing Location

Location sharing works best on:

- `localhost`
- a deployed HTTPS site

Most browsers block geolocation on plain `http://` public websites.

## Deployment Notes

This app needs a Node.js host because Socket.IO runs on the backend. Good beginner options:

- Render
- Railway
- Fly.io

Set the start command to:

```bash
npm start
```

The app reads the hosting platform's `PORT` environment variable automatically.
