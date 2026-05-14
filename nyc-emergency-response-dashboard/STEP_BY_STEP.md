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

## 9. Important Project Note

Describe this as an emergency response simulation or 911 dashboard prototype. It is not connected to NYC 911 services and should not be used for real emergencies.

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
