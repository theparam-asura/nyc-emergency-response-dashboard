const { useEffect, useMemo, useRef, useState } = React;

const priorityRank = { Critical: 4, High: 3, Medium: 2, Low: 1, Pending: 0 };
const unitTypes = [
  { id: "ems", label: "EMS", className: "bg-emerald-100 text-emerald-800" },
  { id: "police", label: "Police", className: "bg-blue-100 text-blue-800" },
  { id: "fire", label: "Fire", className: "bg-rose-100 text-rose-800" }
];

function DashboardApp() {
  const socket = useMemo(() => io(), []);
  const mapRef = useRef(null);
  const markersRef = useRef(new Map());
  const facilityMarkersRef = useRef([]);
  const dispatchLayerRef = useRef([]);
  const localStreamRef = useRef(null);
  const peerRef = useRef(null);
  const audioRef = useRef(null);

  const [unlocked, setUnlocked] = useState(localStorage.getItem("dispatcherAccess") === "true");
  const [accessCode, setAccessCode] = useState("");
  const [incidents, setIncidents] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [tab, setTab] = useState("call");
  const [notification, setNotification] = useState(null);
  const [callStatus, setCallStatus] = useState("Select a caller to join audio");
  const [message, setMessage] = useState("");
  const [speakMessage, setSpeakMessage] = useState(true);
  const [operatorNote, setOperatorNote] = useState("");
  const [details, setDetails] = useState(null);
  const [stats, setStats] = useState(null);
  const [records, setRecords] = useState([]);
  const [showRecords, setShowRecords] = useState(false);
  const [dispatchFilter, setDispatchFilter] = useState("general");
  const [dispatchNotice, setDispatchNotice] = useState("");
  const [operatorName, setOperatorName] = useState(localStorage.getItem("operatorName") || "Dashboard operator");
  const [clock, setClock] = useState(new Date());

  const selected = incidents.find((incident) => incident.id === selectedId) || null;

  useEffect(() => {
    const map = L.map("dashboardMap", { zoomControl: false }).setView([23.2599, 77.4126], 12);
    L.control.zoom({ position: "bottomright" }).addTo(map);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors"
    }).addTo(map);
    mapRef.current = map;
    setTimeout(() => map.invalidateSize(), 250);
    return () => map.remove();
  }, []);

  useEffect(() => {
    socket.on("incidents:snapshot", (snapshot) => {
      setIncidents(sortIncidents(snapshot));
      snapshot.forEach(drawIncident);
    });
    socket.on("incident:created", (incident) => {
      setIncidents((current) => sortIncidents(upsert(current, incident)));
      drawIncident(incident);
      setNotification(incident);
      setSelectedId(incident.id);
      setDetails(buildDetails(incident));
      playAlertTone();
      loadReview();
    });
    socket.on("incident:updated", (incident) => {
      setIncidents((current) => sortIncidents(upsert(current, incident)));
      drawIncident(incident);
      if (incident.id === selectedId) {
        setDetails(buildDetails(incident));
        drawFacilities(incident);
        drawDispatch(incident);
      }
      loadReview();
    });
    socket.on("incident:removed", (id) => {
      setIncidents((current) => current.filter((incident) => incident.id !== id));
      markersRef.current.get(id)?.remove();
      markersRef.current.delete(id);
      if (selectedId === id) setSelectedId(null);
      loadReview();
    });
    socket.on("call:peer-ready", (payload) => {
      if (payload.id === selectedId && payload.role === "caller") setCallStatus("Caller audio is ready. Join to answer.");
    });
    socket.on("call:signal", async (payload) => {
      if (payload.id !== selectedId || !payload.signal) return;
      await handleCallSignal(payload.signal);
    });
    socket.on("call:ended", (payload) => {
      if (payload.id === selectedId) {
        setCallStatus("Caller left the audio bridge");
        closePeer();
      }
    });
    socket.on("dispatch:error", (payload) => {
      if (payload.id === selectedId) setDispatchNotice(payload.message);
    });
    return () => socket.removeAllListeners();
  }, [socket, selectedId]);

  useEffect(() => {
    const timer = setInterval(() => setClock(new Date()), 1000);
    loadReview();
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!selected) return;
    socket.emit("dispatcher:join", selected.id);
    setDetails(buildDetails(selected));
    if (selected.location && mapRef.current) {
      mapRef.current.setView([selected.location.lat, selected.location.lng], 15, { animate: true });
    }
    drawFacilities(selected);
    drawDispatch(selected);
  }, [selectedId]);

  async function loadReview() {
    try {
      const [statsResponse, recordsResponse] = await Promise.all([
        fetch("/api/operations/stats"),
        fetch("/api/incidents/history?limit=100")
      ]);
      if (statsResponse.ok) setStats(await statsResponse.json());
      if (recordsResponse.ok) setRecords(await recordsResponse.json());
    } catch {
      /* Review data is optional for the live console. */
    }
  }

  function unlock(event) {
    event.preventDefault();
    if (accessCode.trim().toLowerCase() === "dispatcher") {
      localStorage.setItem("dispatcherAccess", "true");
      setUnlocked(true);
      setTimeout(() => mapRef.current?.invalidateSize(), 150);
    } else {
      setAccessCode("");
    }
  }

  function selectIncident(id) {
    setSelectedId(id);
    setTab("call");
    setCallStatus("Ready to join caller audio");
  }

  function acceptIncident(incident) {
    socket.emit("incident:accept", { id: incident.id, operator: operatorName || "Dashboard operator" });
    selectIncident(incident.id);
    setNotification(null);
    setTab("details");
    setCallStatus("Request accepted. Join audio when ready.");
  }

  function saveDetails(event) {
    event.preventDefault();
    if (!selected || !details) return;
    socket.emit("incident:update-details", { id: selected.id, ...details });
  }

  function sendMessage(event) {
    event.preventDefault();
    if (!selected || !message.trim()) return;
    socket.emit("dispatcher:message", { id: selected.id, text: message.trim(), speak: speakMessage });
    setMessage("");
  }

  function quickPrompt(text) {
    if (!selected) return;
    socket.emit("dispatcher:message", { id: selected.id, text, speak: true });
  }

  function addOperatorNote(event) {
    event.preventDefault();
    if (!selected || !operatorNote.trim()) return;
    socket.emit("operator:log", { id: selected.id, message: `Operator note: ${operatorNote.trim()}` });
    setOperatorNote("");
  }

  function resolveSelected() {
    if (selected) socket.emit("incident:resolve", selected.id);
  }

  async function joinAudio() {
    if (!selected) {
      setCallStatus("Select an active caller first");
      return;
    }
    try {
      localStreamRef.current = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      setupPeer();
      socket.emit("call:join", { id: selected.id, role: "dispatcher" });
      socket.emit("call:request-offer", { id: selected.id, role: "dispatcher" });
      setCallStatus("Joining audio bridge");
    } catch {
      setCallStatus("Microphone permission is needed");
    }
  }

  function setupPeer() {
    closePeer();
    const peer = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    localStreamRef.current.getTracks().forEach((track) => peer.addTrack(track, localStreamRef.current));
    peer.ontrack = (event) => {
      audioRef.current.srcObject = event.streams[0];
      setCallStatus("Live two-way audio connected");
    };
    peer.onicecandidate = (event) => {
      if (event.candidate && selected) socket.emit("call:signal", { id: selected.id, signal: { type: "ice", candidate: event.candidate } });
    };
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === "connected") setCallStatus("Live two-way audio connected");
      if (["failed", "disconnected"].includes(peer.connectionState)) setCallStatus("Audio bridge reconnecting");
    };
    peerRef.current = peer;
  }

  async function handleCallSignal(signal) {
    if (!localStreamRef.current || !selected) return;
    if (!peerRef.current) setupPeer();
    if (signal.type === "offer") {
      await peerRef.current.setRemoteDescription(signal.description);
      const answer = await peerRef.current.createAnswer();
      await peerRef.current.setLocalDescription(answer);
      socket.emit("call:signal", { id: selected.id, signal: { type: "answer", description: peerRef.current.localDescription } });
      setCallStatus("Audio answer sent");
    }
    if (signal.type === "ice" && signal.candidate) await peerRef.current.addIceCandidate(signal.candidate);
  }

  function leaveAudio() {
    if (selected) socket.emit("call:end", { id: selected.id, role: "dispatcher" });
    closePeer();
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    if (audioRef.current) audioRef.current.srcObject = null;
    setCallStatus("Audio bridge closed");
  }

  function closePeer() {
    peerRef.current?.close();
    peerRef.current = null;
  }

  function drawIncident(incident) {
    if (!incident.location || !mapRef.current) return;
    const markerHtml = `<div class="react-cad-marker ${priorityClass(incident.priority)}">!</div>`;
    const icon = L.divIcon({ className: "react-cad-marker-shell", html: markerHtml, iconSize: [38, 38], iconAnchor: [19, 19] });
    const latLng = [incident.location.lat, incident.location.lng];
    if (markersRef.current.has(incident.id)) {
      markersRef.current.get(incident.id).setLatLng(latLng).setIcon(icon);
    } else {
      const marker = L.marker(latLng, { icon }).addTo(mapRef.current).bindPopup(`${incident.emergencyType} - ${incident.callerPhone}`);
      marker.on("click", () => selectIncident(incident.id));
      markersRef.current.set(incident.id, marker);
    }
  }

  function drawFacilities(incident) {
    facilityMarkersRef.current.forEach((layer) => layer.remove());
    facilityMarkersRef.current = [];
    if (!mapRef.current) return;
    (incident?.facilities || []).forEach((facility) => {
      const layer = L.circleMarker([facility.lat, facility.lng], {
        radius: 7,
        color: facilityColor(facility.type),
        fillColor: facilityColor(facility.type),
        fillOpacity: 0.82,
        weight: 2
      }).addTo(mapRef.current).bindPopup(`${facility.name} (${formatFacilityType(facility.type)})`);
      facilityMarkersRef.current.push(layer);
    });
  }

  function drawDispatch(incident) {
    dispatchLayerRef.current.forEach((layer) => layer.remove());
    dispatchLayerRef.current = [];
    if (!mapRef.current) return;
    (incident?.dispatches?.length ? incident.dispatches : [incident?.dispatch]).filter(Boolean).forEach((dispatch) => {
      if (!dispatch.location || !dispatch.destination) return;
      const unit = [dispatch.location.lat, dispatch.location.lng];
      const destination = [dispatch.destination.lat, dispatch.destination.lng];
      const color = dispatchColor(dispatch.unitType);
      dispatchLayerRef.current.push(L.circleMarker(unit, {
        radius: 11,
        color,
        fillColor: color,
        fillOpacity: 0.92,
        weight: 3
      }).addTo(mapRef.current).bindPopup(`${dispatch.unitName}: ${dispatch.status}`));
      dispatchLayerRef.current.push(L.polyline([unit, destination], {
        color,
        weight: 5,
        opacity: 0.9,
        dashArray: "8 8"
      }).addTo(mapRef.current));
    });
  }

  function dispatchUnit(unitType, facility = null) {
    if (!selected) return;
    if (facility && facility.available === false) {
      setDispatchNotice(`${facility.name} is already assigned.`);
      return;
    }
    setDispatchNotice(`Dispatch request sent to ${facility?.name || getUnitName(unitType)}.`);
    socket.emit("dispatch:start", {
      id: selected.id,
      unitType,
      origin: facility ? { facilityId: facility.id, name: facility.name, lat: facility.lat, lng: facility.lng } : null
    });
  }

  async function resetDemo() {
    await fetch("/api/demo/reset", { method: "POST" });
    setIncidents([]);
    setSelectedId(null);
    setRecords([]);
    setStats(null);
    loadReview();
  }

  async function seedDemo() {
    await fetch("/api/demo/seed", { method: "POST" });
    loadReview();
  }

  async function reopenIncident(id) {
    await fetch(`/api/incidents/${encodeURIComponent(id)}/reopen`, { method: "POST" });
    setShowRecords(false);
    selectIncident(id);
    loadReview();
  }

  const filteredIncidents = incidents.filter((incident) => {
    const haystack = `${incident.callerPhone} ${incident.callerName} ${incident.emergencyType} ${incident.notes}`.toLowerCase();
    const matchesFilter =
      filter === "all" ||
      incident.status === filter ||
      (filter === "dispatched" && Boolean(incident.dispatch || incident.dispatches?.length)) ||
      (filter === "closed" && incident.status === "resolved") ||
      (filter === "high priority" && ["High", "Critical"].includes(incident.priority));
    return matchesFilter && (!query || haystack.includes(query.toLowerCase()));
  });
  const highestPriority = incidents.reduce((best, incident) => (priorityRank[incident.priority] > priorityRank[best] ? incident.priority : best), "None");

  if (!unlocked) {
    return (
      <main className="grid min-h-screen place-items-center bg-[linear-gradient(135deg,#0f172a,#1d4ed8,#14b8a6)] p-6">
        <form onSubmit={unlock} className="w-full max-w-md rounded-[34px] border border-white/35 bg-white/72 p-7 shadow-glass backdrop-blur-2xl">
          <p className="text-xs font-black uppercase text-blue-700">Dispatcher access</p>
          <h1 className="mt-2 text-4xl font-black text-slate-950">Operations Console</h1>
          <input value={accessCode} onChange={(event) => setAccessCode(event.target.value)} type="password" className="ios-input mt-6" placeholder="dispatcher" />
          <button className="mt-4 w-full rounded-3xl bg-slate-950 px-5 py-4 font-black text-white">Enter Dashboard</button>
          <p className="mt-3 text-sm font-bold text-slate-500">Prototype code: dispatcher</p>
        </form>
      </main>
    );
  }

  return (
    <main className="min-h-screen overflow-auto bg-[radial-gradient(circle_at_18%_12%,rgba(14,165,233,.28),transparent_28%),radial-gradient(circle_at_82%_18%,rgba(20,184,166,.22),transparent_26%),linear-gradient(135deg,#eef2ff,#f8fafc_45%,#dbeafe)] p-3 text-slate-950">
      {notification && (
        <div className="fixed right-5 top-5 z-[2000] w-[360px] rounded-[28px] border border-white/70 bg-white/85 p-4 shadow-glow backdrop-blur-2xl">
          <p className="text-xs font-black uppercase text-blue-600">New emergency request</p>
          <h2 className="mt-1 text-xl font-black">{notification.emergencyType} - {notification.callerPhone}</h2>
          <p className="mt-1 text-sm font-bold text-slate-600">{notification.notes || "Waiting for caller transcript."}</p>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <button onClick={() => acceptIncident(notification)} className="rounded-2xl bg-blue-600 py-3 font-black text-white">Accept New Request</button>
            <button onClick={() => setNotification(null)} className="rounded-2xl bg-slate-200 py-3 font-black text-slate-700">Later</button>
          </div>
        </div>
      )}

      <div className="grid min-h-[calc(100vh-1.5rem)] gap-3 xl:grid-cols-[minmax(0,1fr)_430px]">
        <header className="flex flex-wrap items-center justify-between gap-3 rounded-[30px] border border-white/70 bg-white/70 px-5 py-3 shadow-glass backdrop-blur-2xl xl:col-span-2">
          <div className="flex items-center gap-3">
            <div className="grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-br from-blue-600 to-cyan-400 font-black text-white shadow-lg">P</div>
            <div>
              <p className="text-xs font-black uppercase text-blue-600">Metro CAD simulation</p>
              <h1 className="text-2xl font-black">Prepared Dispatch</h1>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={operatorName}
              onChange={(event) => {
                setOperatorName(event.target.value);
                localStorage.setItem("operatorName", event.target.value);
              }}
              className="ios-input w-48"
              placeholder="Operator name"
            />
            <button onClick={() => socket.emit("scenario:create")} className="ios-action bg-blue-600 text-white">Simulate Call</button>
            <button onClick={() => setShowRecords(true)} className="ios-action bg-amber-400 text-slate-950">Incident Records</button>
            <strong className="rounded-2xl bg-slate-950 px-4 py-3 font-mono text-amber-300">{formatClock(clock)}</strong>
          </div>
        </header>

        <section className="grid min-h-[720px] gap-3 lg:grid-rows-[minmax(520px,1fr)_auto]">
        <section className="relative min-h-[520px] overflow-hidden rounded-[30px] border border-white/70 bg-white/50 shadow-glass backdrop-blur-2xl">
          <div id="dashboardMap" className="h-full min-h-[520px] w-full"></div>
          <div className="absolute left-4 right-4 top-4 z-[600] rounded-[26px] border border-white/60 bg-slate-950/70 p-4 text-white shadow-xl backdrop-blur-xl">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs font-black uppercase text-cyan-300">Focused map</p>
                <h2 className="text-xl font-black">{selected ? `${selected.emergencyType} - ${selected.callerPhone}` : "Waiting for an accepted request"}</h2>
              </div>
              <div className="flex gap-2">
                <StatusPill label="25 km stations" color="green" />
                <StatusPill label="Live route" color="blue" />
                <StatusPill label={selected?.dispatch?.status || "No unit"} color="amber" />
              </div>
            </div>
          </div>
          <IncidentCard incident={selected} onAccept={acceptIncident} onClose={resolveSelected} />
        </section>

        <aside className="max-h-[42vh] min-h-[260px] overflow-auto rounded-[30px] border border-white/70 bg-white/72 p-4 shadow-glass backdrop-blur-2xl">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-black">Call Queue</h2>
            <span className="text-xs font-black uppercase text-slate-500">Scroll here for all requests</span>
          </div>
          <div className="grid grid-cols-3 gap-2 xl:grid-cols-6">
            {["all", "active", "accepted", "dispatched", "closed", "high priority"].map((item) => (
              <button key={item} onClick={() => setFilter(item)} className={`rounded-2xl py-3 text-sm font-black capitalize ${filter === item ? "bg-blue-600 text-white" : "bg-white/70 text-slate-600"}`}>{item}</button>
            ))}
          </div>
          <input value={query} onChange={(event) => setQuery(event.target.value)} className="ios-input mt-3" placeholder="Search queue" />
          <div className="mt-3 grid grid-cols-3 gap-2">
            <Metric label="Active" value={incidents.filter((item) => item.status !== "resolved").length} />
            <Metric label="Priority" value={highestPriority} />
            <Metric label="SQL" value={stats?.total || 0} />
          </div>
          <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {filteredIncidents.length ? filteredIncidents.map((incident) => (
              <button key={incident.id} onClick={() => selectIncident(incident.id)} className={`rounded-[26px] border p-4 text-left transition ${selectedId === incident.id ? "border-blue-500 bg-blue-50 shadow-lg" : "border-white/70 bg-white/65 hover:bg-white"}`}>
                <div className="flex items-center justify-between gap-2">
                  <StatusPill label={incident.priority} color={priorityColor(incident.priority)} />
                  <span className="font-mono text-xs font-black text-slate-500">{elapsed(incident.createdAt, incident.resolvedAt)}</span>
                </div>
                <strong className="mt-2 block break-words text-lg">{incident.callerPhone || "Unknown phone"}</strong>
                <span className="mt-1 block text-sm font-bold text-slate-600">{incident.emergencyType} - {incident.callerName || "Unknown"}</span>
                {incident.status === "active" && <span className="mt-3 inline-flex rounded-full bg-amber-100 px-3 py-1 text-xs font-black uppercase text-amber-700">Needs acceptance</span>}
                {isDuplicateIncident(incident, incidents) && <span className="mt-2 inline-flex rounded-full bg-rose-100 px-3 py-1 text-xs font-black uppercase text-rose-700">Possible duplicate</span>}
                {isAgedIncident(incident) && <span className="mt-2 inline-flex rounded-full bg-orange-100 px-3 py-1 text-xs font-black uppercase text-orange-700">Waiting too long</span>}
              </button>
            )) : <p className="rounded-3xl bg-white/60 p-4 text-sm font-bold text-slate-500">No matching calls.</p>}
          </div>
        </aside>
        </section>

        <aside className="min-h-[720px] overflow-auto rounded-[30px] border border-white/70 bg-white/76 p-4 shadow-glass backdrop-blur-2xl">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-black uppercase text-blue-600">Focused workspace</p>
              <h2 className="text-xl font-black">{selected ? selected.callerPhone : "No request selected"}</h2>
            </div>
            {selected && selected.status === "active" && <button onClick={() => acceptIncident(selected)} className="rounded-2xl bg-blue-600 px-4 py-3 font-black text-white">Accept</button>}
          </div>

          <div className="mt-4 grid grid-cols-5 gap-2">
            {["call", "details", "dispatch", "intel", "record"].map((item) => (
              <button key={item} onClick={() => setTab(item)} className={`rounded-2xl px-2 py-3 text-xs font-black capitalize ${tab === item ? "bg-slate-950 text-white" : "bg-white/70 text-slate-600"}`}>{item}</button>
            ))}
          </div>

          {!selected && <p className="mt-4 rounded-3xl bg-white/60 p-5 font-bold text-slate-500">Accept a new request or select an incident from the queue.</p>}
          {selected && tab === "call" && (
            <Panel>
              <h3 className="panel-title">Voice + Call Status</h3>
              <div className="rounded-3xl bg-gradient-to-br from-blue-600 to-cyan-500 p-4 text-white">
                <p className="text-xs font-black uppercase text-blue-100">Audio bridge</p>
                <strong className="mt-1 block text-lg">{callStatus}</strong>
                <div className="mt-4 grid grid-cols-2 gap-2">
                  <button onClick={joinAudio} className="rounded-2xl bg-white py-3 font-black text-blue-700">{joinAudioLabel(callStatus)}</button>
                  <button onClick={leaveAudio} className="rounded-2xl bg-slate-950/35 py-3 font-black text-white">Leave</button>
                </div>
              </div>
              <h3 className="panel-title">Two-way Text</h3>
              <Feed items={selected.messages || []} empty="No messages yet." />
              <form onSubmit={sendMessage} className="mt-3 grid grid-cols-[1fr_auto] gap-2">
                <input value={message} onChange={(event) => setMessage(event.target.value)} className="ios-input" placeholder="Message to caller" />
                <button className="rounded-2xl bg-blue-600 px-4 font-black text-white">Send</button>
              </form>
              <label className="mt-2 flex items-center gap-2 text-sm font-black text-slate-600">
                <input type="checkbox" checked={speakMessage} onChange={(event) => setSpeakMessage(event.target.checked)} className="h-5 w-5 accent-blue-600" />
                Speak message aloud on caller page
              </label>
              <div className="mt-3 grid grid-cols-2 gap-2">
                {[
                  ["Ask Location", "Please confirm your exact location and nearest landmark."],
                  ["Ask Injuries", "How many people are injured and what injuries can you see?"],
                  ["Ask Safety", "Are you in immediate danger right now?"],
                  ["Safety Prompt", "Move to a safe area if you can and stay on the line."]
                ].map(([label, text]) => (
                  <button key={label} onClick={() => quickPrompt(text)} className="rounded-2xl bg-emerald-100 p-3 text-left text-sm font-black text-emerald-800">{label}</button>
                ))}
              </div>
            </Panel>
          )}

          {selected && tab === "details" && details && (
            <Panel>
              <h3 className="panel-title">Accepted Request Details</h3>
              <Checklist incident={selected} details={details} />
              <form onSubmit={saveDetails} className="grid gap-3">
                <input className="ios-input" value={details.callerName} onChange={(event) => setDetails({ ...details, callerName: event.target.value })} placeholder="Caller name" />
                <input className="ios-input" value={details.callerPhone} onChange={(event) => setDetails({ ...details, callerPhone: event.target.value })} placeholder="Callback number" />
                <div className="grid grid-cols-2 gap-2">
                  <select className="ios-input" value={details.emergencyType} onChange={(event) => setDetails({ ...details, emergencyType: event.target.value })}>
                    {["Medical", "Fire", "Police", "Traffic accident", "Other"].map((type) => <option key={type}>{type}</option>)}
                  </select>
                  <select className="ios-input" value={details.priority} onChange={(event) => setDetails({ ...details, priority: event.target.value })}>
                    {["Low", "Medium", "High", "Critical"].map((priority) => <option key={priority}>{priority}</option>)}
                  </select>
                </div>
                <input className="ios-input" value={details.verifiedLocation} onChange={(event) => setDetails({ ...details, verifiedLocation: event.target.value })} placeholder="Verified address / landmark" />
                <textarea className="ios-input min-h-24" value={details.notes} onChange={(event) => setDetails({ ...details, notes: event.target.value })} placeholder="Incident details" />
                <textarea className="ios-input min-h-24" value={details.operatorNotes} onChange={(event) => setDetails({ ...details, operatorNotes: event.target.value })} placeholder="Operator notes" />
                <button className="rounded-2xl bg-slate-950 py-3 font-black text-white">Save Details</button>
              </form>
              <div className="rounded-3xl bg-blue-50 p-4">
                <h3 className="text-sm font-black uppercase text-blue-700">Handoff Summary</h3>
                <p className="mt-2 text-sm font-bold text-slate-700">{buildHandoffSummary(selected, details)}</p>
              </div>
            </Panel>
          )}

          {selected && tab === "dispatch" && (
            <Panel>
              <h3 className="panel-title">Dispatch Type</h3>
              <div className="grid grid-cols-2 gap-2">
                <button onClick={() => setDispatchFilter("general")} className={`rounded-3xl p-4 font-black ${dispatchFilter === "general" ? "bg-slate-950 text-white" : "bg-white/70 text-slate-700"}`}>General Dispatch</button>
                {unitTypes.map((unit) => (
                  <button key={unit.id} onClick={() => setDispatchFilter(unit.id)} className={`rounded-3xl p-4 font-black ${dispatchFilter === unit.id ? unit.className : "bg-white/70 text-slate-700"}`}>{unit.label}</button>
                ))}
              </div>
              {dispatchNotice && <p className="rounded-3xl bg-blue-50 p-3 text-sm font-black text-blue-700">{dispatchNotice}</p>}
              <h3 className="panel-title">Available Stations Within 25 km</h3>
              <div className="grid gap-2">
                {getVisibleFacilities(selected, dispatchFilter).map((facility) => (
                  <button key={facility.id} disabled={facility.available === false} onClick={() => dispatchUnit(unitFromFacility(facility.type), facility)} className={`rounded-3xl border border-white/70 p-3 text-left ${facility.available === false ? "bg-slate-200 text-slate-400" : "bg-white/70 hover:bg-white"}`}>
                    <strong className="block">{facility.name}</strong>
                    <span className="text-sm font-bold text-slate-500">{formatFacilityType(facility.type)} - {formatDistance(facility.distanceMeters)} - ETA {facility.etaMinutes || estimateEtaMinutes(facility.distanceMeters)} min</span>
                    <em className="mt-1 block text-xs font-black uppercase not-italic">{facility.available === false ? "Busy" : "Free - click to dispatch"}</em>
                  </button>
                ))}
                {!getVisibleFacilities(selected, dispatchFilter).length && <p className="rounded-3xl bg-white/60 p-4 text-sm font-bold text-slate-500">Searching real police, fire, and hospital places within 25 km.</p>}
              </div>
              <h3 className="panel-title">Active Response</h3>
              <div className="rounded-3xl bg-slate-950 p-4 text-white">
                {getDispatches(selected).length ? getDispatches(selected).map((dispatch) => (
                  <article key={dispatch.id} className="mb-3 rounded-2xl bg-white/10 p-3 last:mb-0">
                    <strong>{dispatch.unitName} - {dispatch.status}</strong>
                    <p className="mt-1 text-sm font-bold text-slate-300">ETA {dispatch.etaMinutes} min, {formatDistance(dispatch.remainingMeters)} remaining</p>
                    <div className="mt-2 grid grid-cols-3 gap-2">
                      {["Assigned", "En route", "Arrived", "Cleared"].map((status) => (
                        <button key={status} onClick={() => socket.emit("dispatch:status", { id: selected.id, dispatchId: dispatch.id, status })} className="rounded-xl bg-white/15 px-2 py-2 text-xs font-black text-white">{status}</button>
                      ))}
                    </div>
                  </article>
                )) : "No unit assigned yet."}
              </div>
            </Panel>
          )}

          {selected && tab === "intel" && (
            <Panel>
              <h3 className="panel-title">Priority Triage</h3>
              <KeywordAlerts incident={selected} />
              <Guidance incident={selected} />
              <h3 className="panel-title">Live Transcript</h3>
              <Feed items={(selected.transcript || []).map((item) => ({ ...item, sender: item.speaker }))} empty="No caller transcript yet." />
            </Panel>
          )}

          {selected && tab === "record" && (
            <Panel>
              <h3 className="panel-title">Incident Timeline</h3>
              <Feed items={(selected.timeline || []).map((item) => ({ sender: item.type, text: item.message, timestamp: item.timestamp }))} empty="No timeline events yet." />
              <h3 className="panel-title">Operator Notes</h3>
              <form onSubmit={addOperatorNote} className="grid gap-2">
                <textarea value={operatorNote} onChange={(event) => setOperatorNote(event.target.value)} className="ios-input min-h-24" placeholder="Add private operator note" />
                <button className="rounded-2xl bg-blue-600 py-3 font-black text-white">Save Note</button>
              </form>
            </Panel>
          )}
        </aside>
      </div>

      {showRecords && (
        <RecordsModal
          records={records}
          onClose={() => setShowRecords(false)}
          onOpen={(id) => { setShowRecords(false); selectIncident(id); }}
          onReset={resetDemo}
          onSeed={seedDemo}
          onReopen={reopenIncident}
        />
      )}
      <audio ref={audioRef} autoPlay></audio>
    </main>
  );
}

function IncidentCard({ incident, onAccept, onClose }) {
  if (!incident) {
    return (
      <article className="absolute bottom-4 left-4 z-[600] w-[420px] max-w-[calc(100%-2rem)] rounded-[30px] border border-white/60 bg-white/80 p-5 shadow-glass backdrop-blur-2xl">
        <p className="text-xs font-black uppercase text-blue-600">Selected incident</p>
        <h2 className="mt-1 text-2xl font-black">No active caller selected</h2>
        <p className="mt-2 font-bold text-slate-500">New accepted requests open here with caller details, location, and dispatch status.</p>
      </article>
    );
  }
  return (
    <article className="absolute bottom-4 left-4 z-[600] w-[460px] max-w-[calc(100%-2rem)] rounded-[30px] border border-white/60 bg-white/86 p-5 shadow-glass backdrop-blur-2xl">
      <p className="text-xs font-black uppercase text-blue-600">Selected incident</p>
      <h2 className="mt-1 break-words text-3xl font-black">{incident.callerPhone}</h2>
      <div className="mt-3 flex flex-wrap gap-2">
        <StatusPill label={incident.priority} color={priorityColor(incident.priority)} />
        <StatusPill label={incident.status} color="blue" />
        <StatusPill label={elapsed(incident.createdAt, incident.resolvedAt)} color="amber" />
      </div>
      <p className="mt-4 font-black">{incident.callerName || "Unknown caller"}</p>
      <p className="font-bold text-slate-600">{incident.location ? `${incident.location.lat.toFixed(5)}, ${incident.location.lng.toFixed(5)} (${Math.round(incident.location.accuracy || 0)}m)` : "Location pending"}</p>
      <p className="mt-3 font-semibold leading-relaxed text-slate-700">{incident.notes || incident.guidance?.summary || "Waiting for caller transcript."}</p>
      <div className="mt-4 grid grid-cols-2 gap-2">
        {incident.status === "active" && <button onClick={() => onAccept(incident)} className="rounded-2xl bg-blue-600 py-3 font-black text-white">Accept Request</button>}
        <button onClick={onClose} className="rounded-2xl bg-emerald-600 py-3 font-black text-white">Close Incident</button>
      </div>
    </article>
  );
}

function Guidance({ incident }) {
  const guidance = incident.guidance;
  if (!guidance) return <p className="rounded-3xl bg-white/60 p-4 font-bold text-slate-500">Waiting for incident details.</p>;
  return (
    <div className="rounded-3xl bg-white/70 p-4">
      <div className="flex items-center justify-between gap-3">
        <StatusPill label={guidance.priority || incident.priority} color={priorityColor(guidance.priority || incident.priority)} />
        <strong>{guidance.recommendedUnit}</strong>
      </div>
      <p className="mt-3 font-semibold text-slate-700">{guidance.summary}</p>
      {["questions", "actions", "risks"].map((key) => (
        <div key={key} className="mt-3">
          <h4 className="text-xs font-black uppercase text-blue-600">{key}</h4>
          <ul className="mt-1 grid gap-1 text-sm font-bold text-slate-600">
            {(guidance[key] || []).slice(0, 4).map((item) => <li key={item}>- {item}</li>)}
          </ul>
        </div>
      ))}
    </div>
  );
}

function Checklist({ incident, details }) {
  const items = [
    ["Caller verified", Boolean(details.callerName && details.callerPhone)],
    ["Location verified", Boolean(details.verifiedLocation || incident.location)],
    ["Incident classified", Boolean(details.emergencyType)],
    ["Priority set", Boolean(details.priority)],
    ["Notes captured", Boolean(details.notes || incident.transcript?.length)],
    ["Unit dispatched", Boolean(incident.dispatch || incident.dispatches?.length)]
  ];
  return (
    <div className="grid gap-2 rounded-3xl bg-white/70 p-4">
      <h3 className="text-sm font-black uppercase text-slate-600">Missing Info Checklist</h3>
      <div className="grid grid-cols-2 gap-2">
        {items.map(([label, done]) => (
          <span key={label} className={`rounded-2xl px-3 py-2 text-xs font-black uppercase ${done ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>
            {done ? "Done" : "Needed"} - {label}
          </span>
        ))}
      </div>
    </div>
  );
}

function KeywordAlerts({ incident }) {
  const text = `${incident.notes || ""} ${(incident.transcript || []).map((item) => item.text).join(" ")}`.toLowerCase();
  const keywords = ["trapped", "bleeding", "weapon", "fire", "unconscious", "not breathing", "smoke", "chest pain"];
  const hits = keywords.filter((word) => text.includes(word));
  if (!hits.length) return <p className="rounded-3xl bg-white/60 p-4 text-sm font-bold text-slate-500">No critical transcript keywords detected yet.</p>;
  return (
    <div className="rounded-3xl bg-rose-50 p-4">
      <h3 className="text-sm font-black uppercase text-rose-700">Keyword Alerts</h3>
      <div className="mt-2 flex flex-wrap gap-2">
        {hits.map((hit) => <span key={hit} className="rounded-full bg-rose-100 px-3 py-1 text-xs font-black uppercase text-rose-700">{hit}</span>)}
      </div>
    </div>
  );
}

function RecordsModal({ records, onClose, onOpen, onReset, onSeed, onReopen }) {
  const [recordQuery, setRecordQuery] = useState("");
  const [recordStatus, setRecordStatus] = useState("all");
  const filteredRecords = records.filter((record) => {
    const haystack = `${record.callerName} ${record.callerPhone} ${record.emergencyType} ${record.priority} ${record.status}`.toLowerCase();
    return (!recordQuery || haystack.includes(recordQuery.toLowerCase())) && (recordStatus === "all" || record.status === recordStatus);
  });
  return (
    <div className="fixed inset-0 z-[2500] grid place-items-center bg-slate-950/50 p-4 backdrop-blur-md">
      <section className="max-h-[86vh] w-full max-w-6xl overflow-auto rounded-[34px] border border-white/60 bg-white/90 p-5 shadow-glass">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-black uppercase text-blue-600">SQLite incident archive</p>
            <h2 className="text-3xl font-black">Recorded Incidents</h2>
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={onSeed} className="rounded-2xl bg-blue-600 px-4 py-3 font-black text-white">Seed Demo</button>
            <button onClick={onReset} className="rounded-2xl bg-rose-600 px-4 py-3 font-black text-white">Reset Demo Data</button>
            <button onClick={() => exportJson(filteredRecords)} className="rounded-2xl bg-emerald-600 px-4 py-3 font-black text-white">Export JSON</button>
            <button onClick={() => exportCsv(filteredRecords)} className="rounded-2xl bg-amber-400 px-4 py-3 font-black text-slate-950">Export CSV</button>
            <button onClick={onClose} className="rounded-2xl bg-slate-950 px-4 py-3 font-black text-white">Close</button>
          </div>
        </div>
        <div className="mt-4 grid gap-2 md:grid-cols-[1fr_220px]">
          <input value={recordQuery} onChange={(event) => setRecordQuery(event.target.value)} className="ios-input" placeholder="Search by phone, caller, type, priority, date" />
          <select value={recordStatus} onChange={(event) => setRecordStatus(event.target.value)} className="ios-input">
            <option value="all">All statuses</option>
            <option value="active">Active</option>
            <option value="accepted">Accepted</option>
            <option value="resolved">Closed</option>
            <option value="connection lost">Connection lost</option>
          </select>
        </div>
        <div className="mt-4 overflow-auto rounded-3xl border border-white/70">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead className="bg-slate-950 text-white">
              <tr>{["Type", "Priority", "Status", "Caller", "Phone", "Updated", "Dispatch", "Audit", ""].map((head) => <th key={head} className="p-3">{head}</th>)}</tr>
            </thead>
            <tbody>
              {filteredRecords.map((record) => (
                <tr key={record.id} className="border-t border-slate-200 bg-white/70">
                  <td className="p-3 font-bold">{record.emergencyType}</td>
                  <td className="p-3"><StatusPill label={record.priority} color={priorityColor(record.priority)} /></td>
                  <td className="p-3 font-bold">{record.status}</td>
                  <td className="p-3">{record.callerName || "Unknown"}</td>
                  <td className="p-3 font-mono">{record.callerPhone}</td>
                  <td className="p-3">{formatDate(record.updatedAt)}</td>
                  <td className="p-3">{record.dispatch?.unitName || "Unassigned"}</td>
                  <td className="p-3 text-xs font-bold text-slate-500">Timeline, transcript, dispatch, notes saved</td>
                  <td className="p-3">
                    <div className="flex gap-2">
                      <button onClick={() => onOpen(record.id)} className="rounded-xl bg-blue-600 px-3 py-2 font-black text-white">Open</button>
                      {record.status === "resolved" && <button onClick={() => onReopen(record.id)} className="rounded-xl bg-amber-400 px-3 py-2 font-black text-slate-950">Reopen</button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Panel({ children }) {
  return <section className="mt-4 grid gap-3">{children}</section>;
}

function Metric({ label, value }) {
  return (
    <article className="rounded-2xl bg-white/70 p-3">
      <span className="text-[10px] font-black uppercase text-slate-500">{label}</span>
      <strong className="mt-1 block break-words text-sm">{value}</strong>
    </article>
  );
}

function Feed({ items, empty }) {
  if (!items?.length) return <p className="rounded-3xl bg-white/60 p-4 text-sm font-bold text-slate-500">{empty}</p>;
  return (
    <div className="grid max-h-72 gap-2 overflow-auto">
      {items.slice(-10).reverse().map((item, index) => (
        <article key={`${item.timestamp}-${index}`} className="rounded-3xl bg-white/70 p-3">
          <p className="text-xs font-black uppercase text-blue-600">{item.sender || "caller"} - {formatTime(item.timestamp)}</p>
          <p className="mt-1 font-semibold text-slate-700">{item.text}</p>
        </article>
      ))}
    </div>
  );
}

function StatusPill({ label, color }) {
  const colors = {
    green: "bg-emerald-100 text-emerald-700",
    amber: "bg-amber-100 text-amber-700",
    red: "bg-rose-100 text-rose-700",
    blue: "bg-blue-100 text-blue-700"
  };
  return <span className={`inline-flex rounded-full px-3 py-1 text-xs font-black uppercase ${colors[color] || colors.blue}`}>{label || "None"}</span>;
}

function buildDetails(incident) {
  return {
    callerName: incident.callerName || "",
    callerPhone: incident.callerPhone || "",
    emergencyType: incident.emergencyType || "Medical",
    priority: incident.priority === "Pending" ? "Low" : incident.priority || "Low",
    notes: incident.notes || "",
    verifiedLocation: incident.verifiedLocation || "",
    operatorNotes: incident.operatorNotes || ""
  };
}

function upsert(items, incident) {
  return items.some((item) => item.id === incident.id)
    ? items.map((item) => item.id === incident.id ? incident : item)
    : [incident, ...items];
}

function sortIncidents(items) {
  return [...items].sort((a, b) => {
    const priorityDelta = (priorityRank[b.priority] || 0) - (priorityRank[a.priority] || 0);
    if (priorityDelta) return priorityDelta;
    return new Date(b.updatedAt) - new Date(a.updatedAt);
  });
}

function priorityColor(priority = "") {
  if (priority === "Critical" || priority === "High") return "red";
  if (priority === "Medium") return "amber";
  if (priority === "Low") return "green";
  return "blue";
}

function priorityClass(priority = "") {
  return `priority-${String(priority).toLowerCase().replaceAll(" ", "-")}`;
}

function unitFromFacility(type) {
  return { hospital: "ems", police: "police", fire_station: "fire" }[type] || "ems";
}

function getVisibleFacilities(incident, filter) {
  const facilities = incident?.facilities || [];
  if (filter === "general") return facilities.slice(0, 30);
  const wantedType = { ems: "hospital", police: "police", fire: "fire_station" }[filter];
  return facilities.filter((facility) => facility.type === wantedType).slice(0, 30);
}

function getDispatches(incident) {
  return incident?.dispatches?.length ? incident.dispatches : [incident?.dispatch].filter(Boolean);
}

function getUnitName(unitType) {
  return { ems: "EMS Unit", fire: "Fire Unit", police: "Police Unit" }[unitType] || "Response Unit";
}

function joinAudioLabel(status = "") {
  if (status.includes("connected")) return "Connected";
  if (status.includes("Joining")) return "Joining";
  if (status.includes("ready") || status.includes("accepted")) return "Join Audio";
  return "Join Audio";
}

function buildHandoffSummary(incident, details) {
  const location = details.verifiedLocation || (incident.location ? `${incident.location.lat.toFixed(5)}, ${incident.location.lng.toFixed(5)}` : "location pending");
  const dispatchText = getDispatches(incident).map((dispatch) => `${dispatch.unitName} ${dispatch.status}`).join(", ") || "no unit dispatched";
  return `${details.priority} ${details.emergencyType} incident for ${details.callerName || "unknown caller"} at ${location}. Notes: ${details.notes || incident.guidance?.summary || "no details yet"}. Dispatch: ${dispatchText}.`;
}

function isDuplicateIncident(incident, incidents) {
  return incidents.some((item) => item.id !== incident.id && item.status !== "resolved" && (
    (incident.callerPhone && item.callerPhone === incident.callerPhone) ||
    (incident.location && item.location && getApproxDistance(incident.location, item.location) < 120)
  ));
}

function isAgedIncident(incident) {
  if (incident.status === "resolved") return false;
  return Date.now() - Date.parse(incident.createdAt) > 5 * 60 * 1000;
}

function playAlertTone() {
  try {
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.frequency.value = 880;
    gain.gain.value = 0.05;
    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    oscillator.start();
    setTimeout(() => {
      oscillator.stop();
      audioContext.close();
    }, 160);
  } catch {
    /* Browser may block sound until user interaction. */
  }
}

function getApproxDistance(a, b) {
  const dLat = (a.lat - b.lat) * 111000;
  const dLng = (a.lng - b.lng) * 111000 * Math.cos((a.lat * Math.PI) / 180);
  return Math.sqrt((dLat ** 2) + (dLng ** 2));
}

function facilityColor(type) {
  return { hospital: "#10b981", police: "#2563eb", fire_station: "#ef4444" }[type] || "#64748b";
}

function dispatchColor(unitType) {
  return { ems: "#10b981", police: "#2563eb", fire: "#ef4444" }[unitType] || "#64748b";
}

function exportJson(records) {
  saveTextFile("incident-records.json", JSON.stringify(records, null, 2), "application/json");
}

function exportCsv(records) {
  const rows = [["id", "type", "priority", "status", "caller", "phone", "updated", "dispatch"]];
  records.forEach((record) => rows.push([
    record.id,
    record.emergencyType,
    record.priority,
    record.status,
    record.callerName || "",
    record.callerPhone || "",
    record.updatedAt,
    record.dispatch?.unitName || ""
  ]));
  saveTextFile("incident-records.csv", rows.map((row) => row.map(csvCell).join(",")).join("\n"), "text/csv");
}

function saveTextFile(filename, contents, type) {
  const blob = new Blob([contents], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function csvCell(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function formatFacilityType(type = "") {
  return type.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatDistance(meters = 0) {
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
}

function estimateEtaMinutes(meters = 0) {
  return Math.max(2, Math.ceil((meters || 0) / 430));
}

function elapsed(start, end = null) {
  if (!start) return "--";
  const seconds = Math.max(0, Math.floor(((end ? Date.parse(end) : Date.now()) - Date.parse(start)) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function formatTime(value) {
  if (!value) return "--";
  return new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value));
}

function formatDate(value) {
  return new Intl.DateTimeFormat([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function formatClock(value) {
  return new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(value);
}

ReactDOM.createRoot(document.getElementById("dashboardRoot")).render(<DashboardApp />);
