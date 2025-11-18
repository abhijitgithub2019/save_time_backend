import express from "express";
import crypto from "crypto";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Store successful payment emails
const paidEmails = new Set();

// Parse normal JSON requests
app.use(express.json());
app.use(cors());

// Root check
app.get("/", (req, res) => {
  res.send("Backend is running ✔️");
});

// ------------------------------------------------------
// RAW BODY PARSER FOR WEBHOOKS (REQUIRED FOR SIGNATURE)
// ------------------------------------------------------
app.post(
  "/api/razorpay/webhook",
  express.raw({ type: "application/json" }),
  (req, res) => {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const receivedSignature = req.headers["x-razorpay-signature"];
    const eventName = req.headers["x-razorpay-event"];

    console.log("🔔 Webhook Received:", eventName);

    // Validate signature
    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(req.body)
      .digest("hex");

    if (receivedSignature !== expectedSignature) {
      console.log("❌ Signature mismatch");
      return res.status(400).json({ error: "Invalid signature" });
    }

    console.log("✔️ Signature Verified");

    // Parse raw body into JSON
    let body = {};
    try {
      body = JSON.parse(req.body);
    } catch (e) {
      console.log("❌ Failed to parse webhook JSON");
      return res.status(400).json({ error: "Invalid JSON" });
    }

    console.log("📩 FULL WEBHOOK BODY:", JSON.stringify(body, null, 2));

    // ----------------------------------------------------
    // Payment Link SUCCESS
    // ----------------------------------------------------
    if (body.event === "payment_link.paid") {
      console.log("🎉 Event: payment_link.paid");

      const customer =
        body.payload.payment_link?.entity?.customer || null;

      const email = customer?.email || customer?.contact || null;

      if (email) {
        const cleaned = email.toLowerCase().trim();
        paidEmails.add(cleaned);
        console.log("✔️ Payment recorded for:", cleaned);
      } else {
        console.log("⚠️ No email found in payment_link.paid");
      }
    }

    // ----------------------------------------------------
    // Payment Link PARTIALLY PAID (optional)
    // ----------------------------------------------------
    if (body.event === "payment_link.partially_paid") {
      console.log("🎉 Event: payment_link.partially_paid");

      const customer =
        body.payload.payment_link?.entity?.customer || null;

      const email = customer?.email || customer?.contact || null;

      if (email) {
        const cleaned = email.toLowerCase().trim();
        paidEmails.add(cleaned);
        console.log("✔️ Partial payment recorded for:", cleaned);
      } else {
        console.log("⚠️ No email found in payment_link.partially_paid");
      }
    }

    return res.json({ status: "ok" });
  }
);

// ------------------------------------------------------
// CHECK PAYMENT STATUS
// ------------------------------------------------------
app.get("/api/check-payment-status", (req, res) => {
  const email = req.query.email?.toLowerCase().trim();

  if (!email) return res.json({ status: "missing_email" });

  if (paidEmails.has(email)) {
    return res.json({ status: "paid" });
  }

  return res.json({ status: "pending" });
});

// ------------------------------------------------------
app.listen(PORT, () => {
  console.log(`🚀 Backend running on http://localhost:${PORT}`);
});
