const socket = io();

const form = document.querySelector("#emergencyForm");
const connectionStatus = document.querySelector("#connectionStatus");
const locationStatus = document.querySelector("#locationStatus");
const coordinates = document.querySelector("#coordinates");

let incidentId = null;
let watchId = null;

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
  locationStatus.textContent = "Requesting permission";

  watchId = navigator.geolocation.watchPosition(sendPosition, handleLocationError, {
    enableHighAccuracy: true,
    maximumAge: 1000,
    timeout: 10000
  });
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
