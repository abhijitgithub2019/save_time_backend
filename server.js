// import express from "express";
// import crypto from "crypto";
// import cors from "cors";
// import dotenv from "dotenv";
// import mongoose from "mongoose";
// import Razorpay from "razorpay"; // <--- NEW: Import Razorpay Library

// dotenv.config();

// const app = express();
// const PORT = process.env.PORT || 5000;
// const MONGO_URI = process.env.MONGO_URI; 

// // ------------------------------------------------------
// // Razorpay Client Setup
// // ------------------------------------------------------
// // Ensure RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are set in environment variables
// const razorpay = new Razorpay({
//   key_id: process.env.RAZORPAY_KEY_ID,
//   key_secret: process.env.RAZORPAY_KEY_SECRET,
// });

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
// app.post(
//   "/api/razorpay/webhook",
//   express.raw({ type: "application/json" }), 
//   async (req, res) => {
//     const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
//     const receivedSignature = req.headers["x-razorpay-signature"];

//     // 1. Signature Validation
//     const expectedSignature = crypto
//       .createHmac("sha256", secret)
//       .update(req.body)
//       .digest("hex");

//     if (receivedSignature !== expectedSignature) {
//       console.log("❌ Signature mismatch");
//       return res.status(400).json({ error: "Invalid signature" });
//     }

//     console.log("✔️ Signature Verified.");
    
//     // 2. Parse raw body into JSON ONLY AFTER validation
//     let body = {};
//     try {
//       body = JSON.parse(req.body.toString()); 
//     } catch (e) {
//       console.error("❌ Failed to parse webhook JSON:", e);
//       return res.status(400).json({ error: "Invalid JSON" });
//     }

//     console.log("📩 Event:", body.event);

//     // 3. Update DB on payment success
//     if (body.event === "payment_link.paid") {
      
//       let email = 
//         // Path A: From the embedded Payment Entity (The only one that sometimes worked)
//         body.payload.payment?.entity?.email || 
//         // Path B: From the Payment Link's Customer Entity (Was consistently empty)
//         body.payload.payment_link?.entity?.customer?.email || 
//         // Path C: Directly from the Payment Link Entity 
//         body.payload.payment_link?.entity?.email ||
//         null;
      
//       const linkId = body.payload.payment_link?.entity?.id;

//       // 4. API FALLBACK: Fetch full link details if email is missing/null in the payload
//       if ((!email || email.includes('razorpay.com')) && linkId) {
//         console.log(`🔍 Email missing or invalid in webhook payload. Falling back to Razorpay API fetch for link ${linkId}...`);
//         try {
//           // Fetch the Payment Link entity to get the definitive customer data
//           const linkDetails = await razorpay.paymentLink.fetch(linkId);
          
//           // The definitive email will be in the top-level customer object of the fetched link
//           email = linkDetails.customer?.email || null;
          
//           if (email) {
//             console.log("✔️ Email successfully fetched via Razorpay API:", email);
//           } else {
//             console.warn("⚠️ Email still not found after fetching link details from API.");
//           }

//         } catch (apiError) {
//           console.error("❌ Razorpay API Fetch Error:", apiError);
//           // Don't fail the webhook, just log the error and continue without saving the user
//         }
//       }
      
//       // 5. Final Save Attempt
//       if (email && !email.includes('razorpay.com')) {
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
//           return res.status(500).json({ error: "DB Error" });
//         }
//       } else {
//         console.warn("⚠️ Webhook processing skipped. Customer email was still null/placeholder after all checks.");
//       }
//     }

//     // Acknowledge the webhook successfully
//     return res.json({ status: "ok" });
//   }
// );

// // ------------------------------------------------------
// // STATUS CHECK: READS FROM DATABASE
// // ------------------------------------------------------
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
import Razorpay from "razorpay";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI; 

// Middleware to parse incoming JSON data (for the new API endpoint)
app.use(express.json()); // <--- IMPORTANT: Needed to read POST body for link creation

// ------------------------------------------------------
// Razorpay Client Setup
// ------------------------------------------------------
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
  amount: { type: Number, required: true },
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
// ⚡ NEW API ENDPOINT: PROGRAMMATICALLY CREATE PAYMENT LINK
// ------------------------------------------------------
app.post("/api/create-payment-link", async (req, res) => {
    // You can send these values from your frontend
    const { amount, email } = req.body; 
    
    // Convert amount from Rupee (e.g., 100) to Paisa (e.g., 10000)
    const amountInPaise = Math.round(amount * 100); 

    if (!amount || !email) {
        return res.status(400).json({ error: "Missing amount or email in request." });
    }

    // Set expiration time (optional, 15 minutes in seconds)
    const expireTime = Math.floor(Date.now() / 1000) + (15 * 60); 

    const paymentLinkData = {
        amount: amountInPaise,
        currency: "INR",
        expire_by: expireTime,
        reference_id: `REF_${Date.now()}`, // Unique reference ID for tracking
        description: "Premium Feature Access",
        customer: {
            email: email,
            // You can add contact here if you collect it on the frontend
        },
        notify: {
            email: true, // Notify customer via email
            sms: false,
        },
        // We set mandatory email globally in Razorpay settings, but explicitly requiring it here is good practice
        reminder_enable: true, 
        callback_url: "https://your-frontend-success-page.com/payment-success", // Replace with your actual success URL
        callback_method: "get"
    };

    try {
        const link = await razorpay.paymentLink.create(paymentLinkData);
        
        console.log(`✔️ New Payment Link Created: ${link.short_url}`);

        // Send the short URL back to the frontend for redirection
        res.status(200).json({ 
            link_url: link.short_url,
            link_id: link.id
        });
    } catch (error) {
        console.error("❌ Error creating Razorpay link:", error);
        res.status(500).json({ error: "Failed to create payment link." });
    }
});
// ------------------------------------------------------


// ------------------------------------------------------
// 🚨 WEBHOOK HANDLER (No changes below, logic remains correct)
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

      // Extract the amount from the payment entity. It is mandatory for paid events.
      const amount = body.payload.payment?.entity?.amount;

      const linkId = body.payload.payment_link?.entity?.id;

      // 4. API FALLBACK: Fetch full link details if email is missing/null in the payload
      if ((!email || email.includes('razorpay.com')) && linkId) {
        console.log(`🔍 Email missing or invalid in webhook payload. Falling back to Razorpay API fetch for link ${linkId}...`);
        try {
          const linkDetails = await razorpay.paymentLink.fetch(linkId);
          email = linkDetails.customer?.email || null;
          
          if (email) {
            console.log("✔️ Email successfully fetched via Razorpay API:", email);
          } else {
            console.warn("⚠️ Email still not found after fetching link details from API.");
          }

        } catch (apiError) {
          console.error("❌ Razorpay API Fetch Error:", apiError);
        }
      }
      
      // 5. Final Save Attempt
      if (email && !email.includes('razorpay.com') && amount !== undefined && amount !== null) {
        const cleanedEmail = email.toLowerCase().trim();

        try {
          await PaidUser.findOneAndUpdate(
            { email: cleanedEmail },
            { $set: { paidAt: Date.now(), amount: amount } }, 
            { upsert: true, new: true } 
          );
          console.log(`✔️ Payment recorded in DB for: ${cleanedEmail} with amount: ${amount} paise`);
        } catch (dbError) {
          console.error("❌ DB Save Error:", dbError);
          return res.status(500).json({ error: "DB Error" });
        }
      } else {
        console.warn("⚠️ Webhook processing skipped. Customer email was still null/placeholder or amount was missing after all checks.");
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
    return res.json({ status: "paid", amount: user.amount }); 
  }

  return res.json({ status: "pending" });
});

// ------------------------------------------------------
app.listen(PORT, () => {
  console.log(`🚀 Backend running on http://localhost:${PORT}`);
});