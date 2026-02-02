import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import dotenv from "dotenv";
import cors from "cors";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;

/* ───────────── SUPABASE ───────────── */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/* ───────────── GUEST SESSIONS (IN-MEMORY DB) ───────────── */
const guestSessions = {};

/* ───────────── GAME STATE ───────────── */
let gameState = "WAITING";
let currentMultiplier = 1.0;
let crashPoint = null;
let currentRoundId = null;

/* ───────────── PROVABLY FAIR ───────────── */
const clientSeed = "demo-client";
let serverSeed = "";

function generateServerSeed() { return crypto.randomBytes(32).toString("hex"); }
function sha256(data) { return crypto.createHash("sha256").update(data).digest("hex"); }
function hmacSha256(key, message) { return crypto.createHmac("sha256", key).update(message).digest("hex"); }

function calculateCrashPoint(serverSeed, clientSeed) {
  const hmac = hmacSha256(serverSeed, clientSeed);
  const hex = hmac.slice(0, 13);
  const intVal = parseInt(hex, 16);
  const max = Math.pow(2, 52);
  return Math.max(1, Math.floor((max / (max - intVal)) * 100) / 100);
}

/* ───────────── WEBSOCKET BROADCAST ───────────── */
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => c.readyState === 1 && c.send(msg));
}

/* ───────────── CONNECTION HANDLER ───────────── */
wss.on("connection", ws => {
  
  // 1. GENERATE UNIQUE GUEST ID
  const userId = "Guest_" + crypto.randomBytes(3).toString("hex").toUpperCase();
  
  // 2. INITIALIZE THEIR SESSION (1000 Coins)
  guestSessions[userId] = {
    balance: 1000,
    activeBet: null, 
    cashedOut: false
  };

  console.log(`✨ New Guest Connected: ${userId}`);

  // 3. SEND WELCOME MESSAGE
  ws.send(JSON.stringify({ 
    type: "WELCOME", 
    userId: userId, 
    balance: 1000,
    gameState: gameState 
  }));

  ws.on("message", async (message) => {
    try {
      const parsed = JSON.parse(message);

      // ─── INSTANT BET LOGIC ───
      if (parsed.type === "PLACE_BET") {
        const { amount } = parsed;
        const session = guestSessions[userId]; 

        if (gameState !== "WAITING") {
          return ws.send(JSON.stringify({ type: "ERROR", message: "Betting closed" }));
        }
        if (session.activeBet !== null) {
          return ws.send(JSON.stringify({ type: "ERROR", message: "Already bet" }));
        }
        if (session.balance < amount) {
          return ws.send(JSON.stringify({ type: "ERROR", message: "Insufficient balance" }));
        }

        // Deduct Balance in RAM
        session.balance -= amount;
        session.activeBet = amount;
        session.cashedOut = false;

        // ✅ DATABASE CODE REMOVED COMPLETELY
        // We do NOT save to Supabase here anymore.

        // Send Success to Client
        ws.send(JSON.stringify({ 
          type: "BET_CONFIRMED", 
          amount, 
          balance: session.balance 
        }));
      }

      // ─── INSTANT CASHOUT LOGIC ───
      if (parsed.type === "CASHOUT") {
        const session = guestSessions[userId]; 

        if (gameState !== "RUNNING" || !session.activeBet || session.cashedOut) {
          return ws.send(JSON.stringify({ type: "ERROR", message: "Cashout failed" }));
        }

        session.cashedOut = true;
        const win = +(session.activeBet * currentMultiplier).toFixed(2);
        
        // Add Winnings in RAM
        session.balance += win;

        // ✅ DATABASE CODE REMOVED COMPLETELY

        // Send Success to Client
        ws.send(JSON.stringify({ 
          type: "CASHOUT_CONFIRMED", 
          multiplier: currentMultiplier, 
          win,
          balance: session.balance 
        }));

        console.log(`💰 ${userId} Cashed out: +${win}`);
      }

    } catch (err) {
      console.error("WS Message Error", err);
    }
  });

  ws.on("close", () => {
    // console.log(`👋 Guest Disconnected: ${userId}`);
  });
});

/* ───────────── GAME LOOP ───────────── */

async function startNewRound() {
  console.log(`🟢 Round started`);

  // RESET BETS FOR ALL GUESTS IN RAM
  for (const id in guestSessions) {
    guestSessions[id].activeBet = null;
    guestSessions[id].cashedOut = false;
  }

  currentMultiplier = 1;
  gameState = "WAITING";

  broadcast({ type: "STATE", state: "WAITING" });

  let waitSeconds = 5; 
  broadcast({ type: "WAITING_TICK", seconds: waitSeconds });

  const waitTimer = setInterval(() => {
    waitSeconds--;
    if (waitSeconds > 0) {
      broadcast({ type: "WAITING_TICK", seconds: waitSeconds });
    } else {
      clearInterval(waitTimer);
    }
  }, 1000);
  
  serverSeed = generateServerSeed();
  crashPoint = calculateCrashPoint(serverSeed, clientSeed);

  console.log("💥 Crash point:", crashPoint);

  // We log the ROUND itself (this is fine, no User ID involved)
  const { data, error } = await supabase
    .from("rounds")
    .insert({
      server_seed: serverSeed,
      server_seed_hash: sha256(serverSeed),
      client_seed: clientSeed,
      crash_point: crashPoint,
      started_at: new Date()
    })
    .select()
    .single();

  if (!error) currentRoundId = data.id;

  broadcast({
    type: "ROUND_START",
    serverSeedHash: sha256(serverSeed),
    clientSeed
  });

  setTimeout(startCrash, 5000);
}

function startCrash() {
  gameState = "RUNNING";
  broadcast({ type: "STATE", state: "RUNNING" });

  const timer = setInterval(() => {
    currentMultiplier = +(currentMultiplier + 0.01).toFixed(2);
    broadcast({ type: "MULTIPLIER", value: currentMultiplier });

    if (currentMultiplier >= crashPoint) {
      clearInterval(timer);
      handleCrash();
    }
  }, 100);
}

async function handleCrash() {
  gameState = "CRASHED";

  broadcast({ type: "STATE", state: "CRASHED" }); 
  broadcast({ type: "CRASH", crashPoint });

  // Close the Round in DB
  if (currentRoundId) {
    await supabase
      .from("rounds")
      .update({ ended_at: new Date() })
      .eq("id", currentRoundId);
  }

  // ✅ DATABASE CODE REMOVED (No longer updating 'lost' bets in DB)

  setTimeout(startNewRound, 3000);
}

/* ───────────── ADMIN DASHBOARD ───────────── */
app.get("/admin/users", (req, res) => {
  res.json({
    active_users: Object.keys(guestSessions).length,
    users: guestSessions
  });
});

/* ───────────── START ───────────── */
server.listen(PORT, () => {
  console.log(`🚀 Backend running on port ${PORT}`);
  startNewRound();
});
