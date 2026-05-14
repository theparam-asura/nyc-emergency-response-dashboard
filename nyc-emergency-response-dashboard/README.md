# NYC 911 Live Dashboard Prototype

This is a college-project prototype for an emergency response dashboard. It is not a real 911 system.

## What It Does

- Caller page collects emergency details.
- Browser asks for live GPS permission.
- Caller coordinates are sent to the backend with Socket.IO.
- Responder dashboard receives live incident updates.
- Leaflet displays the caller location on an OpenStreetMap map.
- Operators can mark an incident as resolved.

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
