// import express from "express";
// import crypto from "crypto";
// import cors from "cors";
// import dotenv from "dotenv";

// dotenv.config();

// const app = express();
// const PORT = process.env.PORT || 5000;

// // Store successful payment emails
// const paidEmails = new Set();

// // Parse normal JSON requests
// app.use(express.json());
// app.use(cors());

// // Root check
// app.get("/", (req, res) => {
//   res.send("Backend is running ✔️");
// });

// // ------------------------------------------------------
// // RAW BODY PARSER FOR WEBHOOKS (REQUIRED FOR SIGNATURE)
// // ------------------------------------------------------
// app.post(
//   "/api/razorpay/webhook",
//   express.raw({ type: "application/json" }),
//   (req, res) => {
//     const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
//     const receivedSignature = req.headers["x-razorpay-signature"];
//     const eventName = req.headers["x-razorpay-event"];

//     console.log("🔔 Webhook Received:", eventName);

//     // Validate signature
//     const expectedSignature = crypto
//       .createHmac("sha256", secret)
//       .update(req.body)
//       .digest("hex");

//     if (receivedSignature !== expectedSignature) {
//       console.log("❌ Signature mismatch");
//       return res.status(400).json({ error: "Invalid signature" });
//     }

//     console.log("✔️ Signature Verified");

//     // Parse raw body into JSON
//     let body = {};
//     try {
//       body = JSON.parse(req.body);
//     } catch (e) {
//       console.log("❌ Failed to parse webhook JSON");
//       return res.status(400).json({ error: "Invalid JSON" });
//     }

//     console.log("📩 FULL WEBHOOK BODY:", JSON.stringify(body, null, 2));

//     // ----------------------------------------------------
//     // Payment Link SUCCESS
//     // ----------------------------------------------------
//     if (body.event === "payment_link.paid") {
//       console.log("🎉 Event: payment_link.paid");

//       const customer =
//         body.payload.payment_link?.entity?.customer || null;

//       const email = customer?.email || customer?.contact || null;

//       if (email) {
//         const cleaned = email.toLowerCase().trim();
//         paidEmails.add(cleaned);
//         console.log("✔️ Payment recorded for:", cleaned);
//       } else {
//         console.log("⚠️ No email found in payment_link.paid");
//       }
//     }

//     // ----------------------------------------------------
//     // Payment Link PARTIALLY PAID (optional)
//     // ----------------------------------------------------
//     if (body.event === "payment_link.partially_paid") {
//       console.log("🎉 Event: payment_link.partially_paid");

//       const customer =
//         body.payload.payment_link?.entity?.customer || null;

//       const email = customer?.email || customer?.contact || null;

//       if (email) {
//         const cleaned = email.toLowerCase().trim();
//         paidEmails.add(cleaned);
//         console.log("✔️ Partial payment recorded for:", cleaned);
//       } else {
//         console.log("⚠️ No email found in payment_link.partially_paid");
//       }
//     }

//     return res.json({ status: "ok" });
//   }
// );

// // ------------------------------------------------------
// // CHECK PAYMENT STATUS
// // ------------------------------------------------------
// app.get("/api/check-payment-status", (req, res) => {
//   const email = req.query.email?.toLowerCase().trim();

//   if (!email) return res.json({ status: "missing_email" });

//   if (paidEmails.has(email)) {
//     return res.json({ status: "paid" });
//   }

//   return res.json({ status: "pending" });
// });

// // ------------------------------------------------------
// app.listen(PORT, () => {
//   console.log(`🚀 Backend running on http://localhost:${PORT}`);
// });

import express from "express";
import crypto from "crypto";
import cors from "cors";
import dotenv from "dotenv";
import mongoose from "mongoose"; // <-- NEW

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI; // Must be set on Render

// ------------------------------------------------------
// MongoDB Setup (Persistence Layer)
// ------------------------------------------------------
mongoose
  .connect(MONGO_URI)
  .then(() => console.log("💾 MongoDB Connected"))
  .catch((err) => console.error("❌ MongoDB connection error:", err));

// Schema to store paid users
const PaidUserSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, index: true },
  paidAt: { type: Date, default: Date.now },
});
const PaidUser = mongoose.model("PaidUser", PaidUserSchema);
// ------------------------------------------------------

// Parse normal JSON requests
app.use(express.json());
app.use(cors());

app.get("/", (req, res) => {
  res.send("Backend is running ✔️");
});

// ------------------------------------------------------
// WEBHOOK HANDLER: SAVES TO DATABASE
// ------------------------------------------------------
app.post(
  "/api/razorpay/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    // ADD ASYNC
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const receivedSignature = req.headers["x-razorpay-signature"];
    console.log(secret, receivedSignature);

    // Signature Validation (remains the same)
    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(req.body)
      .digest("hex");

    if (receivedSignature !== expectedSignature) {
      console.log("❌ Signature mismatch");
      return res.status(400).json({ error: "Invalid signature" });
    }

    let body = {};
    try {
      body = JSON.parse(req.body);
    } catch (e) {
      console.error("❌ Failed to parse webhook JSON:", e);
      return res.status(400).json({ error: "Invalid JSON" });
    }

    console.log("✔️ Signature Verified. Event:", body.event);

    // Update DB on payment success
    if (body.event === "payment_link.paid") {
      const email = body.payload.payment_link?.entity?.customer?.email || null;

      if (email) {
        const cleanedEmail = email.toLowerCase().trim();

        try {
          // *** PERSISTENT SAVE TO DATABASE ***
          await PaidUser.findOneAndUpdate(
            { email: cleanedEmail },
            { $set: { paidAt: Date.now() } },
            { upsert: true, new: true }
          );
          console.log("✔️ Payment recorded in DB for:", cleanedEmail);
        } catch (dbError) {
          console.error("❌ DB Save Error:", dbError);
          return res.status(500).json({ error: "DB Error" });
        }
      }
    }

    return res.json({ status: "ok" });
  }
);

// ------------------------------------------------------
// STATUS CHECK: READS FROM DATABASE
// ------------------------------------------------------
app.get("/api/check-payment-status", async (req, res) => {
  // ADD ASYNC
  const email = req.query.email?.toLowerCase().trim();

  if (!email) return res.json({ status: "missing_email" });

  // *** QUERY DATABASE ***
  const user = await PaidUser.findOne({ email: email });

  if (user) {
    return res.json({ status: "paid" }); // Success! This is what your frontend polls for
  }

  return res.json({ status: "pending" });
});

// ------------------------------------------------------
app.listen(PORT, () => {
  console.log(`🚀 Backend running on http://localhost:${PORT}`);
});
