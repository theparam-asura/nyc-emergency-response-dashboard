const { useEffect, useMemo, useRef, useState } = React;

const emergencyTypes = ["Medical", "Fire", "Police", "Traffic accident", "Other"];
const emptyForm = {
  emergencyType: "Medical",
  callerName: "",
  callerPhone: "",
  notes: "",
  landmark: ""
};

function CallerApp() {
  const socket = useMemo(() => io(), []);
  const mapRef = useRef(null);
  const callerMarkerRef = useRef(null);
  const accuracyRef = useRef(null);
  const dispatchMarkerRef = useRef(null);
  const routeRef = useRef(null);
  const recognitionRef = useRef(null);
  const localStreamRef = useRef(null);
  const peerRef = useRef(null);
  const audioRef = useRef(null);
  const watchRef = useRef(null);

  const [form, setForm] = useState(emptyForm);
  const [incidentId, setIncidentId] = useState(null);
  const [incident, setIncident] = useState(null);
  const [connection, setConnection] = useState("Connecting");
  const [locationStatus, setLocationStatus] = useState("Waiting");
  const [voiceStatus, setVoiceStatus] = useState("Voice + Call ready");
  const [audioStatus, setAudioStatus] = useState("Not connected");
  const [requestStatus, setRequestStatus] = useState("Draft");
  const [transcript, setTranscript] = useState("");
  const [messageText, setMessageText] = useState("");
  const [callerMessages, setCallerMessages] = useState([]);
  const [autoVoice, setAutoVoice] = useState(true);
  const [silentMode, setSilentMode] = useState(false);
  const [battery, setBattery] = useState(null);

  useEffect(() => {
    const map = L.map("callerMap", { zoomControl: false }).setView([23.2599, 77.4126], 12);
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
    socket.on("connect", () => setConnection("Connected"));
    socket.on("disconnect", () => setConnection("Disconnected"));
    socket.on("incident:updated", (nextIncident) => {
      if (nextIncident.id !== incidentId) return;
      setIncident(nextIncident);
      if (nextIncident.status === "accepted") setRequestStatus("Dispatcher accepted");
      if (nextIncident.status === "resolved") setRequestStatus("Closed by dispatcher");
      if (nextIncident.status === "connection lost") setRequestStatus("Reconnecting");
      drawIncident(nextIncident);
      setCallerMessages((nextIncident.messages || []).filter((item) => item.sender === "dispatcher").slice(-8));
    });
    socket.on("dispatcher:message", (message) => {
      setCallerMessages((items) => [...items, message].slice(-8));
      if (message.speak) speak(message.text);
    });
    socket.on("call:peer-ready", async (payload) => {
      if (payload.id === incidentId && payload.role === "dispatcher" && localStreamRef.current) await createOffer();
    });
    socket.on("call:request-offer", async (payload) => {
      if (payload.id === incidentId && localStreamRef.current) await createOffer();
    });
    socket.on("call:signal", async (payload) => {
      if (payload.id !== incidentId || !payload.signal) return;
      await handleSignal(payload.signal);
    });
    socket.on("call:ended", (payload) => {
      if (payload.id === incidentId) setAudioStatus("Dispatcher left the bridge");
    });

    return () => socket.removeAllListeners();
  }, [socket, incidentId]);

  useEffect(() => {
    let batteryRef = null;
    if (navigator.getBattery) {
      navigator.getBattery().then((batteryInfo) => {
        batteryRef = batteryInfo;
        const updateBattery = () => setBattery({
          level: Math.round(batteryInfo.level * 100),
          charging: batteryInfo.charging
        });
        updateBattery();
        batteryInfo.addEventListener("levelchange", updateBattery);
        batteryInfo.addEventListener("chargingchange", updateBattery);
      });
    }
    return () => {
      if (!batteryRef) return;
      batteryRef.onlevelchange = null;
      batteryRef.onchargingchange = null;
    };
  }, []);

  useEffect(() => () => {
    if (watchRef.current !== null) navigator.geolocation?.clearWatch(watchRef.current);
    closeAudio();
  }, []);

  function updateForm(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function submitRequest(event) {
    event.preventDefault();
    await openRequest(autoVoice);
  }

  async function openRequest(connectImmediately = false) {
    if (incidentId) {
      if (connectImmediately && !localStreamRef.current) await startVoiceAndCall(incidentId);
      return;
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    setIncidentId(id);
    setRequestStatus("Request sent");
    setIncident({
      id,
      status: "active",
      priority: "Pending",
      emergencyType: form.emergencyType,
      callerName: form.callerName || "Unknown caller",
      callerPhone: form.callerPhone || "Not provided",
      notes: form.notes,
      createdAt: now,
      updatedAt: now,
      messages: [],
      transcript: []
    });

    socket.emit("caller:start", { id, ...form });
    startLocationWatch(id);
    if (connectImmediately) {
      setTimeout(() => startVoiceAndCall(id), 250);
    }
  }

  function startLocationWatch(id) {
    if (!navigator.geolocation) {
      setLocationStatus("Location unavailable");
      return;
    }
    if (watchRef.current !== null) {
      navigator.geolocation.clearWatch(watchRef.current);
      watchRef.current = null;
    }
    setLocationStatus("Requesting permission");
    watchRef.current = navigator.geolocation.watchPosition((position) => {
      const { latitude, longitude, accuracy, speed, heading } = position.coords;
      const location = { lat: latitude, lng: longitude, accuracy };
      setLocationStatus(`Live within ${Math.round(accuracy)}m`);
      drawLocation(location);
      socket.emit("caller:location", {
        id,
        lat: latitude,
        lng: longitude,
        accuracy,
        speed,
        heading,
        timestamp: new Date(position.timestamp).toISOString()
      });
    }, (error) => {
      const messages = { 1: "Permission denied", 2: "Position unavailable", 3: "Location timeout" };
      setLocationStatus(messages[error.code] || "Location error");
      setTimeout(() => {
        if (incidentId || id) startLocationWatch(id);
      }, 5000);
    }, { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 });
  }

  async function startVoiceAndCall(id = incidentId) {
    if (!id) return;
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    try {
      await startAudioBridge(id);
    } catch {
      setAudioStatus("Microphone permission needed");
      return;
    }
    if (!SpeechRecognition) {
      setVoiceStatus("Speech recognition unsupported");
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";
    recognition.onstart = () => setVoiceStatus("Listening and streaming");
    recognition.onresult = (event) => {
      let finalText = "";
      let interimText = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const text = result[0].transcript.trim();
        if (result.isFinal) finalText = `${finalText} ${text}`.trim();
        else interimText = `${interimText} ${text}`.trim();
      }
      if (finalText) {
        setTranscript((current) => `${current} ${finalText}`.trim());
        socket.emit("caller:transcript", { id, text: finalText, isFinal: true });
      }
      if (interimText) setVoiceStatus(`Listening: ${interimText}`);
    };
    recognition.onerror = (event) => setVoiceStatus(`Voice error: ${event.error}`);
    recognition.onend = () => {
      if (recognitionRef.current) recognition.start();
    };
    recognitionRef.current = recognition;
    recognition.start();
  }

  function stopVoiceAndCall() {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    closeAudio();
    setVoiceStatus("Voice + Call stopped");
  }

  async function startAudioBridge(id) {
    localStreamRef.current = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    setupPeer(id);
    socket.emit("call:join", { id, role: "caller" });
    setAudioStatus("Calling dashboard");
    setRequestStatus("Calling dashboard");
  }

  function setupPeer(id) {
    peerRef.current?.close();
    const peer = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    localStreamRef.current.getTracks().forEach((track) => peer.addTrack(track, localStreamRef.current));
    peer.ontrack = (event) => {
      audioRef.current.srcObject = event.streams[0];
      setAudioStatus("Two-way audio connected");
      setRequestStatus("Connected");
    };
    peer.onicecandidate = (event) => {
      if (event.candidate) socket.emit("call:signal", { id, signal: { type: "ice", candidate: event.candidate } });
    };
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === "connected") setAudioStatus("Two-way audio connected");
      if (["failed", "disconnected"].includes(peer.connectionState)) setAudioStatus("Audio reconnecting");
    };
    peerRef.current = peer;
  }

  async function createOffer() {
    if (!peerRef.current || !incidentId) return;
    const offer = await peerRef.current.createOffer();
    await peerRef.current.setLocalDescription(offer);
    socket.emit("call:signal", { id: incidentId, signal: { type: "offer", description: peerRef.current.localDescription } });
    setAudioStatus("Ringing dispatcher");
    setRequestStatus("Waiting for dispatcher");
  }

  async function handleSignal(signal) {
    if (!peerRef.current) return;
    if (signal.type === "answer") {
      await peerRef.current.setRemoteDescription(signal.description);
      setAudioStatus("Dispatcher answered");
      setRequestStatus("Dispatcher accepted");
    }
    if (signal.type === "ice" && signal.candidate) await peerRef.current.addIceCandidate(signal.candidate);
  }

  function closeAudio() {
    if (incidentId) socket.emit("call:end", { id: incidentId, role: "caller" });
    peerRef.current?.close();
    peerRef.current = null;
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    if (audioRef.current) audioRef.current.srcObject = null;
    setAudioStatus("Not connected");
    setRequestStatus(incidentId ? "Request sent" : "Draft");
  }

  function drawLocation(location) {
    const map = mapRef.current;
    if (!map) return;
    const latLng = [location.lat, location.lng];
    if (callerMarkerRef.current) callerMarkerRef.current.setLatLng(latLng);
    else callerMarkerRef.current = L.marker(latLng).addTo(map).bindPopup("Your shared location");
    accuracyRef.current?.remove();
    accuracyRef.current = L.circle(latLng, {
      radius: Math.max(location.accuracy || 25, 25),
      color: "#2563eb",
      fillColor: "#60a5fa",
      fillOpacity: 0.12,
      weight: 2
    }).addTo(map);
    map.setView(latLng, 15);
  }

  function drawIncident(nextIncident) {
    if (nextIncident.location) drawLocation(nextIncident.location);
    const activeDispatch = nextIncident.dispatch || nextIncident.dispatches?.[0];
    if (!activeDispatch?.location || !activeDispatch?.destination || !mapRef.current) return;
    const unit = [activeDispatch.location.lat, activeDispatch.location.lng];
    const destination = [activeDispatch.destination.lat, activeDispatch.destination.lng];
    if (dispatchMarkerRef.current) dispatchMarkerRef.current.setLatLng(unit);
    else dispatchMarkerRef.current = L.circleMarker(unit, { radius: 10, color: "#10b981", fillColor: "#10b981", fillOpacity: 0.9 }).addTo(mapRef.current);
    if (routeRef.current) routeRef.current.setLatLngs([unit, destination]);
    else routeRef.current = L.polyline([unit, destination], { color: "#10b981", weight: 5, dashArray: "8 8" }).addTo(mapRef.current);
  }

  function sendMessage(event) {
    event.preventDefault();
    if (!incidentId || !messageText.trim()) return;
    socket.emit("caller:message", { id: incidentId, text: messageText.trim() });
    setMessageText("");
  }

  function shareLandmark(event) {
    event.preventDefault();
    if (!incidentId || !form.landmark.trim()) return;
    socket.emit("caller:landmark", { id: incidentId, landmark: form.landmark.trim() });
  }

  const hasActiveRequest = Boolean(incidentId);

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_20%_10%,rgba(45,212,191,.32),transparent_28%),linear-gradient(135deg,#e0f2fe_0%,#f8fafc_45%,#dbeafe_100%)] p-4 lg:p-6">
      <div className="grid min-h-[calc(100vh-2rem)] gap-5 lg:grid-cols-[430px_minmax(0,1fr)]">
        <section className="order-1 rounded-[34px] border border-white/70 bg-white/72 p-5 shadow-glass backdrop-blur-2xl">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-black uppercase tracking-wide text-blue-600">Emergency caller</p>
              <h1 className="mt-1 text-3xl font-black leading-tight text-slate-950">Voice + Call first, help request next.</h1>
            </div>
            <StatusPill label={connection} color={connection === "Connected" ? "green" : "amber"} />
          </div>

          <button
            type="button"
            onClick={() => hasActiveRequest ? (recognitionRef.current ? stopVoiceAndCall() : startVoiceAndCall()) : openRequest(!silentMode)}
            className="mb-4 flex w-full items-center justify-center gap-3 rounded-3xl bg-gradient-to-r from-blue-600 via-cyan-500 to-emerald-500 px-5 py-4 text-lg font-black text-white shadow-glow transition hover:scale-[1.01]"
          >
            <span className="grid h-10 w-10 place-items-center rounded-2xl bg-white/20 text-xs">CALL</span>
            {callButtonLabel({ hasActiveRequest, recognition: recognitionRef.current, audioStatus, requestStatus })}
          </button>

          {!hasActiveRequest && (
            <form onSubmit={submitRequest} className="grid gap-4">
              <label className="ios-label">
                <span>Emergency type</span>
                <select value={form.emergencyType} onChange={(event) => updateForm("emergencyType", event.target.value)} className="ios-input">
                  {emergencyTypes.map((type) => <option key={type}>{type}</option>)}
                </select>
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="ios-label">
                  <span>Caller name</span>
                  <input value={form.callerName} onChange={(event) => updateForm("callerName", event.target.value)} className="ios-input" placeholder="PARAM RAJPUT" autoComplete="name" />
                </label>
                <label className="ios-label">
                  <span>Phone number</span>
                  <input value={form.callerPhone} onChange={(event) => updateForm("callerPhone", event.target.value)} className="ios-input" placeholder="+91 9302927686" autoComplete="tel" />
                </label>
              </div>
              <label className="ios-label">
                <span>Situation notes</span>
                <textarea value={form.notes} onChange={(event) => updateForm("notes", event.target.value)} className="ios-input min-h-28" placeholder="Describe what happened and nearby landmarks." />
              </label>
              <label className="ios-label">
                <span>Nearest landmark</span>
                <input value={form.landmark} onChange={(event) => updateForm("landmark", event.target.value)} className="ios-input" placeholder="Building, road, shop, gate, or floor" />
              </label>
              <label className="flex items-center gap-3 rounded-2xl bg-white/70 p-3 text-sm font-bold text-slate-700">
                <input type="checkbox" checked={silentMode} onChange={(event) => setSilentMode(event.target.checked)} className="h-5 w-5 accent-blue-600" />
                Silent mode: send text/location first without microphone
              </label>
              <label className="flex items-center gap-3 rounded-2xl bg-white/70 p-3 text-sm font-bold text-slate-700">
                <input type="checkbox" checked={autoVoice} onChange={(event) => setAutoVoice(event.target.checked)} className="h-5 w-5 accent-blue-600" />
                Start Voice + Call automatically after submit
              </label>
              <button className="rounded-3xl bg-slate-950 px-5 py-4 text-lg font-black text-white shadow-xl transition hover:bg-blue-950" type="submit">
                Send Request Details
              </button>
            </form>
          )}

          {hasActiveRequest && (
            <section className="grid gap-4">
              <div className="grid grid-cols-2 gap-3">
                <Metric label="Location" value={locationStatus} />
                <Metric label="Call" value={requestStatus} />
                <Metric label="Audio" value={audioStatus} />
                <Metric label="Dispatch" value={incident?.dispatch?.status || "Waiting"} />
                <Metric label="ETA" value={incident?.dispatch?.etaMinutes ? `${incident.dispatch.etaMinutes} min` : "--"} />
              </div>
              <div className="grid gap-2 rounded-3xl border border-white/70 bg-white/65 p-4">
                <h2 className="font-black text-slate-950">Caller status</h2>
                <div className="grid grid-cols-2 gap-2 text-sm font-black text-slate-700">
                  {["Request Sent", "Accepted", "Dispatcher Joined", "Unit Assigned", "Help Arriving"].map((step) => (
                    <span key={step} className={`rounded-2xl px-3 py-2 ${callerStepComplete(step, incident, requestStatus, audioStatus) ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>{step}</span>
                  ))}
                </div>
                <p className="text-sm font-bold text-slate-500">{battery ? `Battery ${battery.level}%${battery.charging ? " charging" : ""}` : "Battery status unavailable"} - connection {connection}</p>
              </div>

              <div className="rounded-3xl border border-white/70 bg-white/65 p-4">
                <h2 className="font-black text-slate-950">Dispatcher messages</h2>
                <div className="mt-3 grid max-h-48 gap-2 overflow-auto">
                  {callerMessages.length ? callerMessages.map((message, index) => (
                    <article key={`${message.timestamp}-${index}`} className="rounded-2xl bg-blue-50 p-3 text-sm text-slate-800">
                      <p className="text-xs font-black uppercase text-blue-500">{formatTime(message.timestamp)}</p>
                      <p className="font-bold">{message.text}</p>
                    </article>
                  )) : <p className="text-sm font-bold text-slate-500">No dispatcher messages yet.</p>}
                </div>
                <form onSubmit={sendMessage} className="mt-3 grid grid-cols-[1fr_auto] gap-2">
                  <input value={messageText} onChange={(event) => setMessageText(event.target.value)} className="ios-input" placeholder="Reply by text" />
                  <button className="rounded-2xl bg-blue-600 px-5 font-black text-white">Send</button>
                </form>
                <form onSubmit={shareLandmark} className="mt-3 grid grid-cols-[1fr_auto] gap-2">
                  <input value={form.landmark} onChange={(event) => updateForm("landmark", event.target.value)} className="ios-input" placeholder="Update nearest landmark" />
                  <button className="rounded-2xl bg-emerald-600 px-5 font-black text-white">Share</button>
                </form>
              </div>

              <div className="rounded-3xl border border-white/70 bg-white/65 p-4">
                <h2 className="font-black text-slate-950">Transcript</h2>
                <p className="mt-1 text-sm font-bold text-slate-500">{voiceStatus}</p>
                <div className="mt-3 min-h-28 rounded-2xl bg-slate-950/90 p-3 text-sm font-semibold leading-relaxed text-white">
                  {transcript || "No speech captured yet."}
                </div>
              </div>
            </section>
          )}
        </section>

        <section className="order-2 overflow-hidden rounded-[34px] border border-white/70 bg-white/55 shadow-glass backdrop-blur-2xl">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/70 p-4">
            <div>
              <p className="text-xs font-black uppercase text-slate-500">Live shared map</p>
              <h2 className="text-2xl font-black text-slate-950">{incident?.emergencyType || "Waiting for request"}</h2>
            </div>
            <div className="flex gap-2">
              <StatusPill label={incident?.priority || "Ready"} color={priorityColor(incident?.priority)} />
              <StatusPill label={incident?.status || "Draft"} color="blue" />
            </div>
          </div>
          <div id="callerMap" className="h-[calc(100vh-8rem)] min-h-[560px] w-full"></div>
        </section>
      </div>
      <audio ref={audioRef} autoPlay></audio>
    </main>
  );
}

function Metric({ label, value }) {
  return (
    <article className="rounded-3xl border border-white/70 bg-white/70 p-4">
      <span className="text-xs font-black uppercase text-slate-500">{label}</span>
      <strong className="mt-1 block break-words text-slate-950">{value}</strong>
    </article>
  );
}

function StatusPill({ label, color }) {
  const colors = {
    green: "bg-emerald-100 text-emerald-700",
    amber: "bg-amber-100 text-amber-700",
    red: "bg-red-100 text-red-700",
    blue: "bg-blue-100 text-blue-700"
  };
  return <span className={`rounded-full px-3 py-2 text-xs font-black uppercase ${colors[color] || colors.blue}`}>{label}</span>;
}

function priorityColor(priority = "") {
  if (priority === "Critical" || priority === "High") return "red";
  if (priority === "Medium") return "amber";
  if (priority === "Low") return "green";
  return "blue";
}

function callButtonLabel({ hasActiveRequest, recognition, audioStatus, requestStatus }) {
  if (!hasActiveRequest) return "Start Voice + Call";
  if (recognition) return "End Voice + Call";
  if (audioStatus === "Two-way audio connected") return "Connected";
  if (requestStatus === "Dispatcher accepted") return "Join Audio";
  if (requestStatus === "Waiting for dispatcher") return "Waiting for Dispatcher";
  if (requestStatus === "Calling dashboard") return "Calling Dashboard";
  return "Connect Voice + Call";
}

function callerStepComplete(step, incident, requestStatus, audioStatus) {
  if (step === "Request Sent") return Boolean(incident) || requestStatus !== "Draft";
  if (step === "Accepted") return ["accepted", "dispatched", "resolved"].includes(incident?.status) || requestStatus === "Dispatcher accepted";
  if (step === "Dispatcher Joined") return ["Dispatcher accepted", "Connected"].includes(requestStatus) || audioStatus.includes("connected");
  if (step === "Unit Assigned") return Boolean(incident?.dispatch || incident?.dispatches?.length);
  if (step === "Help Arriving") return Boolean((incident?.dispatches || [incident?.dispatch]).filter(Boolean).some((dispatch) => ["En route", "Arrived"].includes(dispatch.status)));
  return false;
}

function speak(text) {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 0.95;
  window.speechSynthesis.speak(utterance);
}

function formatTime(value) {
  return new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value));
}

ReactDOM.createRoot(document.getElementById("callerRoot")).render(<CallerApp />);
