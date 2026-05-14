# Build From Scratch: NYC 911 Live Dashboard Prototype

Use these commands if you want to recreate the project from an empty folder.

## 1. Create the Project Folder

```bash
mkdir nyc-911-live-dashboard
cd nyc-911-live-dashboard
```

## 2. Create the Folder Structure

```bash
mkdir public
mkdir public/css
mkdir public/js
```

## 3. Create the Node Project

```bash
npm init -y
```

## 4. Install Dependencies

```bash
npm install express socket.io
```

## 5. Create These Files

```text
server.js
public/index.html
public/dashboard.html
public/css/style.css
public/js/caller.js
public/js/dashboard.js
README.md
```

The files in this workspace already contain the complete code.

## 6. Start the Server

```bash
npm start
```

If you want auto-restart while editing:

```bash
npm run dev
```

## 7. Open the App

Caller page:

```text
http://localhost:3000
```

Responder dashboard:

```text
http://localhost:3000/dashboard
```

## 8. Test the Live Location Flow

1. Open `http://localhost:3000/dashboard` in one browser tab.
2. Open `http://localhost:3000` in another browser tab.
3. Fill out the emergency form.
4. Click `Send Help Request`.
5. Allow location permission when the browser asks.
6. Watch the dashboard update with the caller's live GPS coordinates.
7. Click `Start Voice Transcript` on the caller page.
8. Allow microphone permission.
9. Speak a sample emergency sentence and watch the dashboard transcript and guidance update.
10. Click a dispatch button on the dashboard to simulate sending EMS, fire, or police.
11. Watch the responder marker and ETA update on the map.
12. Use the dashboard message box to send a spoken/text message back to the victim.
13. Change responder status as the simulated unit moves through the workflow.
14. Check `data/emergency-dashboard.sqlite` to confirm call data is being saved.

## 9. Important Project Note

Describe this as an emergency response simulation or 911 dashboard prototype. It is not connected to NYC 911 services and should not be used for real emergencies.

This prototype cannot track a real caller from a phone number. It uses browser permission-based location and microphone access.

The dashboard login is a prototype-only client-side access gate. It is useful for a college demo, but it is not production security.

## 10. Recommended Hosting

Use a Node.js hosting service because this project has a backend server and WebSockets:

- Render
- Railway
- Fly.io

Set the production start command to:

```bash
npm start
```

The server automatically uses `process.env.PORT`, which most hosts provide.
