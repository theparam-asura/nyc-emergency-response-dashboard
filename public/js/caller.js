const socket = io();

const form = document.querySelector("#emergencyForm");
const connectionStatus = document.querySelector("#connectionStatus");
const locationStatus = document.querySelector("#locationStatus");
const coordinates = document.querySelector("#coordinates");
const callRoom = document.querySelector("#callRoom");
const voiceButton = document.querySelector("#voiceButton");
const voiceStatus = document.querySelector("#voiceStatus");
const voiceSummary = document.querySelector("#voiceSummary");
const transcriptPreview = document.querySelector("#transcriptPreview");
const dispatchStatus = document.querySelector("#dispatchStatus");
const callerDispatchDetails = document.querySelector("#callerDispatchDetails");
const dispatcherMessages = document.querySelector("#dispatcherMessages");
const callerMessageForm = document.querySelector("#callerMessageForm");
const callerMessage = document.querySelector("#callerMessage");

let incidentId = null;
let watchId = null;
let recognition = null;
let transcriptText = "";
let dispatcherMessageItems = [];

socket.on("connect", () => {
  connectionStatus.textContent = "Connected";
});

socket.on("disconnect", () => {
  connectionStatus.textContent = "Disconnected";
});

socket.on("incident:updated", (incident) => {
  if (incident.id !== incidentId) return;
  renderCallerIncident(incident);
});

socket.on("dispatcher:message", (message) => {
  dispatcherMessageItems = [...dispatcherMessageItems, message].slice(-12);
  renderDispatcherMessages();
  if (message.speak) speakMessage(message.text);
});

form.addEventListener("submit", (event) => {
  event.preventDefault();

  if (!navigator.geolocation) {
    locationStatus.textContent = "Geolocation unavailable";
    return;
  }

  incidentId = crypto.randomUUID();

  socket.emit("caller:start", {
    id: incidentId,
    emergencyType: document.querySelector("#emergencyType").value,
    callerName: document.querySelector("#callerName").value.trim(),
    callerPhone: document.querySelector("#callerPhone").value.trim(),
    notes: document.querySelector("#notes").value.trim()
  });

  form.querySelector("button").disabled = true;
  form.querySelector("button").textContent = "Emergency Call Active";
  callRoom.hidden = false;
  locationStatus.textContent = "Requesting permission";

  watchId = navigator.geolocation.watchPosition(sendPosition, handleLocationError, {
    enableHighAccuracy: true,
    maximumAge: 1000,
    timeout: 10000
  });
});

voiceButton.addEventListener("click", () => {
  if (!incidentId) return;

  if (recognition) {
    recognition.stop();
    recognition = null;
    voiceButton.textContent = "Start Voice Transcript";
    voiceStatus.textContent = "Voice transcript stopped";
    voiceSummary.textContent = "Stopped";
    return;
  }

  startVoiceTranscript();
});

callerMessageForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = callerMessage.value.trim();
  if (!incidentId || !text) return;

  socket.emit("caller:message", { id: incidentId, text });
  callerMessage.value = "";
});

function sendPosition(position) {
  const { latitude, longitude, accuracy, speed, heading } = position.coords;

  locationStatus.textContent = `Live within ${Math.round(accuracy)}m`;
  coordinates.textContent = `GPS ${latitude.toFixed(5)}, ${longitude.toFixed(5)} (${Math.round(accuracy)}m accuracy)`;

  socket.emit("caller:location", {
    id: incidentId,
    lat: latitude,
    lng: longitude,
    accuracy,
    speed,
    heading,
    timestamp: new Date(position.timestamp).toISOString()
  });
}

function startVoiceTranscript() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!SpeechRecognition) {
    voiceStatus.textContent = "Speech recognition unsupported in this browser";
    voiceSummary.textContent = "Unsupported";
    return;
  }

  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = "en-US";

  recognition.onstart = () => {
    voiceButton.textContent = "Stop Voice Transcript";
    voiceStatus.textContent = "Listening";
    voiceSummary.textContent = "Listening";
  };

  recognition.onresult = (event) => {
    let interimText = "";

    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      const text = result[0].transcript.trim();

      if (result.isFinal) {
        transcriptText = `${transcriptText} ${text}`.trim();
        socket.emit("caller:transcript", {
          id: incidentId,
          text,
          isFinal: true
        });
      } else {
        interimText = `${interimText} ${text}`.trim();
      }
    }

    transcriptPreview.textContent = [transcriptText, interimText].filter(Boolean).join(" ");
    voiceSummary.textContent = transcriptText ? "Streaming" : "Listening";
  };

  recognition.onerror = (event) => {
    voiceStatus.textContent = `Voice error: ${event.error}`;
    voiceSummary.textContent = "Error";
  };

  recognition.onend = () => {
    if (recognition) {
      voiceStatus.textContent = "Restarting listener";
      recognition.start();
    }
  };

  recognition.start();
}

function renderCallerIncident(incident) {
  if (incident.dispatch) {
    dispatchStatus.textContent = incident.dispatch.status;
    callerDispatchDetails.innerHTML = `
      <strong>${escapeHtml(incident.dispatch.unitName)}</strong>
      <span>${escapeHtml(incident.dispatch.status)} - ETA ${incident.dispatch.etaMinutes} min - ${formatDistance(incident.dispatch.remainingMeters)} away</span>
    `;
  } else {
    dispatchStatus.textContent = "Not assigned";
    callerDispatchDetails.textContent = "A dispatcher has not assigned a unit yet.";
  }

  dispatcherMessageItems = (incident.messages || []).filter((message) => message.sender === "dispatcher").slice(-12);
  renderDispatcherMessages();
}

function renderDispatcherMessages() {
  if (!dispatcherMessageItems.length) {
    dispatcherMessages.textContent = "No dispatcher messages yet.";
    return;
  }

  dispatcherMessages.innerHTML = dispatcherMessageItems
    .map((message) => `
      <article>
        <span>${formatTime(message.timestamp)}</span>
        <p>${escapeHtml(message.text)}</p>
      </article>
    `)
    .join("");
}

function speakMessage(text) {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 0.95;
  utterance.pitch = 1;
  window.speechSynthesis.speak(utterance);
}

function handleLocationError(error) {
  const messages = {
    1: "Permission denied",
    2: "Position unavailable",
    3: "Location timeout"
  };

  locationStatus.textContent = messages[error.code] || "Location error";

  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
}

function formatDistance(meters = 0) {
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
}

function formatTime(value) {
  return new Intl.DateTimeFormat([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
