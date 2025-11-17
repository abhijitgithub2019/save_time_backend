// ==============================
// Simple Razorpay backend for Chrome Extension Premium Unlock
// ==============================

import express from "express";
import crypto from "crypto";
import fs from "fs";
import cors from "cors";

const app = express();
app.use(express.json());
app.use(cors());

// ==============================
// FILE DATABASE (db.json)
// ==============================
const DB_PATH = "./db.json";

function loadDB() {
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify({ paidUsers: [] }, null, 2));
  }
  return JSON.parse(fs.readFileSync(DB_PATH));
}

function saveDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// ==============================
// RAZORPAY WEBHOOK ENDPOINT
// ==============================

// IMPORTANT: set this in Razorpay Dashboard → Webhooks
// URL: https://your-server.com/api/razorpay/webhook
// SECRET: set your own secret here
const RAZORPAY_SECRET = "your_webhook_secret_here"; // CHANGE THIS!

app.post("/api/razorpay/webhook", (req, res) => {
  const receivedSignature = req.headers["x-razorpay-signature"];
  const generatedSignature = crypto
    .createHmac("sha256", RAZORPAY_SECRET)
    .update(JSON.stringify(req.body))
    .digest("hex");

  if (receivedSignature !== generatedSignature) {
    console.log("❌ Invalid webhook signature");
    return res.status(400).send("Invalid signature");
  }

  console.log("✅ Valid webhook received");

  const event = req.body.event;

  if (event === "payment.captured") {
    const email = req.body.payload.payment.entity.email;

    if (email) {
      const db = loadDB();

      if (!db.paidUsers.includes(email)) {
        db.paidUsers.push(email);
        saveDB(db);
        console.log("🎉 Payment recorded for:", email);
      }
    }
  }

  res.status(200).send("OK");
});

// ==============================
// ENDPOINT FOR EXTENSION POLLING
// ==============================

app.get("/api/check-payment-status", (req, res) => {
  const email = req.query.email;

  if (!email) {
    return res.json({ status: "error", message: "email missing" });
  }

  const db = loadDB();

  if (db.paidUsers.includes(email)) {
    return res.json({ status: "paid" });
  }

  return res.json({ status: "pending" });
});

// ==============================
// START SERVER
// ==============================
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Backend server running on http://localhost:${PORT}`);
});
