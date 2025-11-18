import express from "express";
import crypto from "crypto";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Store successful payment emails in memory
// (works for Render, stays alive as long as instance is active)
const paidEmails = new Set();

// Parse normal JSON requests
app.use(express.json());
app.use(cors());

// Root check
app.get("/", (req, res) => {
  res.send("Backend is running");
});

// -----------------------------
// RAW BODY PARSER FOR WEBHOOKS
// -----------------------------
app.post(
  "/api/razorpay/webhook",
  express.raw({ type: "application/json" }),
  (req, res) => {
    const razorpaySecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const receivedSignature = req.headers["x-razorpay-signature"];

    const expectedSignature = crypto
      .createHmac("sha256", razorpaySecret)
      .update(req.body) // raw body
      .digest("hex");

    console.log("Webhook Received...");
    console.log("Event:", req.headers["x-razorpay-event"]);

    if (receivedSignature !== expectedSignature) {
      console.log("❌ Signature mismatch");
      return res.status(400).json({ error: "Invalid signature" });
    }

    console.log("✔️ Signature Verified");

    const body = JSON.parse(req.body); // now safely parse

    // Only capture successful payments
    if (body.event === "payment.captured") {
      const payment = body.payload.payment.entity;

      const email = payment.email || payment.contact;

      if (email) {
        const cleanedEmail = email.toLowerCase().trim();
        paidEmails.add(cleanedEmail);
        console.log("✔️ Payment recorded for:", cleanedEmail);
      } else {
        console.log("⚠️ No email found in payment");
      }
    }

    return res.json({ status: "ok" });
  }
);

// -----------------------------
// CHECK PAYMENT STATUS
// -----------------------------
app.get("/api/check-payment-status", (req, res) => {
  const email = req.query.email?.toLowerCase().trim();

  if (!email) {
    return res.json({ status: "missing_email" });
  }

  if (paidEmails.has(email)) {
    return res.json({ status: "paid" });
  }

  return res.json({ status: "pending" });
});

// -----------------------------
app.listen(PORT, () => {
  console.log(`🚀 Backend running on http://localhost:${PORT}`);
});
