let currentMultiplier = 1.0;
let crashPoint = null;
let gameInterval = null;
let roundActive = false;

// WebSocket clients
let clients = [];

function setClients(wsClients) {
  clients = wsClients;
}

function broadcast(message) {
  clients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(JSON.stringify(message));
    }
  });
}

function generateCrashPoint() {
  return Math.max(1.01, Number((Math.random() * 10).toFixed(2)));
}

function startRound() {
  currentMultiplier = 1.0;
  crashPoint = generateCrashPoint();
  roundActive = true;

  console.log("🟢 New round started");
  console.log("💥 Crash point:", crashPoint);

  broadcast({
    type: "ROUND_START",
    multiplier: currentMultiplier
  });

  gameInterval = setInterval(() => {
    currentMultiplier += 0.01;

    if (currentMultiplier >= crashPoint) {
      crash();
    } else {
      broadcast({
        type: "MULTIPLIER_UPDATE",
        multiplier: Number(currentMultiplier.toFixed(2))
      });
    }
  }, 100);
}

function crash() {
  clearInterval(gameInterval);
  roundActive = false;

  console.log("🔴 CRASHED at", currentMultiplier.toFixed(2));

  broadcast({
    type: "CRASH",
    multiplier: Number(currentMultiplier.toFixed(2))
  });

  setTimeout(startRound, 3000);
}

module.exports = {
  startRound,
  setClients
};