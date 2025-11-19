// import express from "express";
// import crypto from "crypto";
// import cors from "cors";
// import dotenv from "dotenv";
// import mongoose from "mongoose";

// dotenv.config();

// const app = express();
// const PORT = process.env.PORT || 5000;
// const MONGO_URI = process.env.MONGO_URI; 
// // const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET; // This is accessed later

// // ------------------------------------------------------
// // MongoDB Setup (Persistence Layer)
// // ------------------------------------------------------
// mongoose
//   .connect(MONGO_URI)
//   .then(() => console.log("💾 MongoDB Connected"))
//   .catch((err) => console.error("❌ MongoDB connection error:", err));

// // Schema to store paid users
// const PaidUserSchema = new mongoose.Schema({
//   email: { type: String, required: true, unique: true, index: true },
//   paidAt: { type: Date, default: Date.now },
// });
// const PaidUser = mongoose.model("PaidUser", PaidUserSchema);
// // ------------------------------------------------------

// // ⚠️ ONLY Global Middleware: CORS
// app.use(cors());

// // Root check
// app.get("/", (req, res) => {
//   res.send("Backend is running ✔️");
// });

// // ------------------------------------------------------
// // 🚨 WEBHOOK HANDLER: RAW BODY PARSER & SIGNATURE FIX
// // ------------------------------------------------------
// // NOTE: We MUST NOT use app.use(express.json()) globally or before this route,
// // as it would break signature validation. We use express.raw() only here.
// app.post(
//   "/api/razorpay/webhook",
//   express.raw({ type: "application/json" }), // <--- Uses raw body for validation
//   async (req, res) => {
//     const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
//     const receivedSignature = req.headers["x-razorpay-signature"];

//     // 1. Signature Validation: Must use the raw body (Buffer)
//     const expectedSignature = crypto
//       .createHmac("sha256", secret)
//       .update(req.body) // req.body is the raw Buffer here
//       .digest("hex");

//     if (receivedSignature !== expectedSignature) {
//       console.log("❌ Signature mismatch");
//       return res.status(400).json({ error: "Invalid signature" });
//     }

//     console.log("✔️ Signature Verified.");

//     // 2. Parse raw body into JSON ONLY AFTER validation
//     let body = {};
//     try {
//       body = JSON.parse(req.body); // Parses the raw Buffer content into an object
//     } catch (e) {
//       console.error("❌ Failed to parse webhook JSON:", e);
//       return res.status(400).json({ error: "Invalid JSON" });
//     }

//     console.log("📩 Event:", body.event);

//     // 3. Update DB on payment success
//     if (body.event === "payment_link.paid") {
//       const email = body.payload.payment_link?.entity?.customer?.email || null;

//       if (email) {
//         const cleanedEmail = email.toLowerCase().trim();

//         try {
//           // *** PERSISTENT SAVE TO DATABASE ***
//           await PaidUser.findOneAndUpdate(
//             { email: cleanedEmail },
//             { $set: { paidAt: Date.now() } },
//             { upsert: true, new: true } // Find & update, or insert if not found
//           );
//           console.log("✔️ Payment recorded in DB for:", cleanedEmail);
//         } catch (dbError) {
//           console.error("❌ DB Save Error:", dbError);
//           // Return 500 but still send status: "ok" to Razorpay? No, error out to debug
//           return res.status(500).json({ error: "DB Error" });
//         }
//       }
//     }

//     // Acknowledge the webhook successfully
//     return res.json({ status: "ok" });
//   }
// );

// // ------------------------------------------------------
// // STATUS CHECK: READS FROM DATABASE
// // ------------------------------------------------------
// // NOTE: We don't need express.json() for this GET request.
// app.get("/api/check-payment-status", async (req, res) => {
//   const email = req.query.email?.toLowerCase().trim();

//   if (!email) return res.json({ status: "missing_email" });

//   // *** QUERY DATABASE ***
//   const user = await PaidUser.findOne({ email: email });

//   if (user) {
//     return res.json({ status: "paid" }); // Success!
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
import mongoose from "mongoose";
import Razorpay from "razorpay"; // <--- NEW: Import Razorpay Library

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI; 

// ------------------------------------------------------
// Razorpay Client Setup
// ------------------------------------------------------
// Ensure RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are set in environment variables
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

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

// ⚠️ ONLY Global Middleware: CORS
app.use(cors());

// Root check
app.get("/", (req, res) => {
  res.send("Backend is running ✔️");
});

// ------------------------------------------------------
// 🚨 WEBHOOK HANDLER: RAW BODY PARSER & SIGNATURE FIX
// ------------------------------------------------------
app.post(
  "/api/razorpay/webhook",
  express.raw({ type: "application/json" }), 
  async (req, res) => {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const receivedSignature = req.headers["x-razorpay-signature"];

    // 1. Signature Validation
    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(req.body)
      .digest("hex");

    if (receivedSignature !== expectedSignature) {
      console.log("❌ Signature mismatch");
      return res.status(400).json({ error: "Invalid signature" });
    }

    console.log("✔️ Signature Verified.");
    
    // 2. Parse raw body into JSON ONLY AFTER validation
    let body = {};
    try {
      body = JSON.parse(req.body.toString()); 
    } catch (e) {
      console.error("❌ Failed to parse webhook JSON:", e);
      return res.status(400).json({ error: "Invalid JSON" });
    }

    console.log("📩 Event:", body.event);

    // 3. Update DB on payment success
    if (body.event === "payment_link.paid") {
      
      let email = 
        // Path A: From the embedded Payment Entity (The only one that sometimes worked)
        body.payload.payment?.entity?.email || 
        // Path B: From the Payment Link's Customer Entity (Was consistently empty)
        body.payload.payment_link?.entity?.customer?.email || 
        // Path C: Directly from the Payment Link Entity 
        body.payload.payment_link?.entity?.email ||
        null;
      
      const linkId = body.payload.payment_link?.entity?.id;

      // 4. API FALLBACK: Fetch full link details if email is missing/null in the payload
      if ((!email || email.includes('razorpay.com')) && linkId) {
        console.log(`🔍 Email missing or invalid in webhook payload. Falling back to Razorpay API fetch for link ${linkId}...`);
        try {
          // Fetch the Payment Link entity to get the definitive customer data
          const linkDetails = await razorpay.paymentLink.fetch(linkId);
          
          // The definitive email will be in the top-level customer object of the fetched link
          email = linkDetails.customer?.email || null;
          
          if (email) {
            console.log("✔️ Email successfully fetched via Razorpay API:", email);
          } else {
            console.warn("⚠️ Email still not found after fetching link details from API.");
          }

        } catch (apiError) {
          console.error("❌ Razorpay API Fetch Error:", apiError);
          // Don't fail the webhook, just log the error and continue without saving the user
        }
      }
      
      // 5. Final Save Attempt
      if (email && !email.includes('razorpay.com')) {
        const cleanedEmail = email.toLowerCase().trim();

        try {
          // *** PERSISTENT SAVE TO DATABASE ***
          await PaidUser.findOneAndUpdate(
            { email: cleanedEmail },
            { $set: { paidAt: Date.now() } },
            { upsert: true, new: true } // Find & update, or insert if not found
          );
          console.log("✔️ Payment recorded in DB for:", cleanedEmail);
        } catch (dbError) {
          console.error("❌ DB Save Error:", dbError);
          return res.status(500).json({ error: "DB Error" });
        }
      } else {
        console.warn("⚠️ Webhook processing skipped. Customer email was still null/placeholder after all checks.");
      }
    }

    // Acknowledge the webhook successfully
    return res.json({ status: "ok" });
  }
);

// ------------------------------------------------------
// STATUS CHECK: READS FROM DATABASE
// ------------------------------------------------------
app.get("/api/check-payment-status", async (req, res) => {
  const email = req.query.email?.toLowerCase().trim();

  if (!email) return res.json({ status: "missing_email" });

  // *** QUERY DATABASE ***
  const user = await PaidUser.findOne({ email: email });

  if (user) {
    return res.json({ status: "paid" }); // Success!
  }

  return res.json({ status: "pending" });
});

// ------------------------------------------------------
app.listen(PORT, () => {
  console.log(`🚀 Backend running on http://localhost:${PORT}`);
});