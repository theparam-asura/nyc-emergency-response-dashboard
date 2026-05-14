const socket = io();

const form = document.querySelector("#emergencyForm");
const connectionStatus = document.querySelector("#connectionStatus");
const locationStatus = document.querySelector("#locationStatus");
const coordinates = document.querySelector("#coordinates");
const voicePanel = document.querySelector("#voicePanel");
const voiceButton = document.querySelector("#voiceButton");
const voiceStatus = document.querySelector("#voiceStatus");
const voiceSummary = document.querySelector("#voiceSummary");
const transcriptPreview = document.querySelector("#transcriptPreview");

let incidentId = null;
let watchId = null;
let recognition = null;
let transcriptText = "";

socket.on("connect", () => {
  connectionStatus.textContent = "Connected";
});

socket.on("disconnect", () => {
  connectionStatus.textContent = "Disconnected";
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
  form.querySelector("button").textContent = "Sharing Live Location";
  voicePanel.hidden = false;
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

function sendPosition(position) {
  const { latitude, longitude, accuracy, speed, heading } = position.coords;

  locationStatus.textContent = `Live within ${Math.round(accuracy)}m`;
  coordinates.textContent = `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;

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
