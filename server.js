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

// 🚨 CRITICAL FIX: We are REMOVING the global app.use(express.json()) 
// to prevent it from running before the webhook's express.raw(). 
// express.json() will now be applied only to the /api/create-payment-link route.


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
app.post(
  "/api/create-payment-link", 
  express.json(), // 🔥 FIX: Applying JSON parser only to this route
  async (req, res) => {
    // You can send these values from your frontend
    const { amount, email } = req.body; 
    
    // Convert amount from Rupee (e.g., 100) to Paisa (e.g., 10000)
    const amountInPaise = Math.round(amount * 100); 

    if (!amount || !email) {
        return res.status(400).json({ error: "Missing amount or email in request." });
    }

    // ✅ CRITICAL FIX: Setting expiration time to 25 minutes (1500 seconds) 
    // This is well above the 15-minute minimum, preventing clock drift errors from Razorpay.
    const expireInSeconds = 25 * 60; // 25 minutes
    const expireTime = Math.floor(Date.now() / 1000) + expireInSeconds; 

    // LOG: Add a log to see the calculated timestamp in the Render logs
    console.log(`[Link Creation] Calculated Expire Time (UNIX): ${expireTime} (${expireInSeconds} seconds from now)`);

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
        // 🚨 CRITICAL EXTENSION FIX: Using the chrome-extension:// URL for the callback
        callback_url: "chrome-extension://hokdmlppdlkokmlolddngkcceadflbke/premium.html", 
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
        // IMPORTANT: We now correctly log the detailed error and send a generic 500 error to the client
        console.error("❌ Error creating Razorpay link:", error);
        res.status(500).json({ error: "Failed to create payment link." });
    }
  }
);
// ------------------------------------------------------

app.post(
  "/api/create-emergency-payment-link", 
  express.json(), // 🔥 FIX: Applying JSON parser only to this route
  async (req, res) => {
    // You can send these values from your frontend
    const { amount, email } = req.body; 
    
    // Convert amount from Rupee (e.g., 100) to Paisa (e.g., 10000)
    const amountInPaise = Math.round(amount * 100); 

    if (!amount || !email) {
        return res.status(400).json({ error: "Missing amount or email in request." });
    }

    // ✅ CRITICAL FIX: Setting expiration time to 25 minutes (1500 seconds) 
    // This is well above the 15-minute minimum, preventing clock drift errors from Razorpay.
    const expireInSeconds = 25 * 60; // 25 minutes
    const expireTime = Math.floor(Date.now() / 1000) + expireInSeconds; 

    // LOG: Add a log to see the calculated timestamp in the Render logs
    console.log(`[Link Creation] Calculated Expire Time (UNIX): ${expireTime} (${expireInSeconds} seconds from now)`);

    const paymentLinkData = {
        amount: amountInPaise,
        currency: "INR",
        expire_by: expireTime,
        reference_id: `REF_${Date.now()}`, // Unique reference ID for tracking
        description: "Emergency unlock fetaures",
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
        // 🚨 CRITICAL EXTENSION FIX: Using the chrome-extension:// URL for the callback
        callback_url: "chrome-extension://hokdmlppdlkokmlolddngkcceadflbke/premium.html", 
        callback_method: "get"
    };

    try {
        const link = await razorpay.paymentLink.create(paymentLinkData);
        
        console.log(`✔️ New Emergency Payment Link Created: ${link.short_url}`);

        // Send the short URL back to the frontend for redirection
        res.status(200).json({ 
            link_url: link.short_url,
            link_id: link.id
        });
    } catch (error) {
        // IMPORTANT: We now correctly log the detailed error and send a generic 500 error to the client
        console.error("❌ Error creating Razorpay link for Emergency Lock:", error);
        res.status(500).json({ error: "Failed to create payment link for Emergency Lock." });
    }
  }
);

// ------------------------------------------------------
// 🚨 WEBHOOK HANDLER
// ------------------------------------------------------
app.post(
  "/api/razorpay/webhook",
  express.raw({ type: "application/json" }), 
  async (req, res) => {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const receivedSignature = req.headers["x-razorpay-signature"];

    // 1. Signature Validation
    // ✅ This line requires req.body to be a Buffer, which is now guaranteed because 
    // the global JSON parser has been removed.
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
      // Convert the raw Buffer to a string for JSON parsing
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

app.get("/health", (req, res) => {
  res.status(200).send("OK");
});


app.get("/api/check-emergency-status", async (req, res) => {
  const email = req.query.email?.toLowerCase().trim();

  if (!email) return res.json({ status: "missing_email" });

  // Look up user payment record
  const user = await PaidUser.findOne({ email: email });

  if (!user) {
    return res.json({ status: "pending" });
  }

  // amount saved is in PAISA (49 rupees = 4900 paise)
  if (user.amount === 4900) {
    return res.json({ status: "paid", amount: user.amount });
  }

  // If the saved amount is not ₹49, then this record is for full premium
  return res.json({ status: "not_emergency" });
});

app.get("/api/country", async (req, res) => {
  try {
    const response = await fetch("https://ipapi.co/json/");
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error("Country API Error:", err);
    res.status(500).json({ error: "Failed to detect country" });
  }
});


app.get("/api/delete-emergency-payment", async (req, res) => {
  const email = req.query.email?.toLowerCase().trim();

  if (!email) {
    return res.status(400).json({ error: "Missing email" });
  }

  try {
    // Only delete emergency unlock payments (4900 paise)
    const result = await PaidUser.deleteOne({ email: email, amount: 4900 });

    if (result.deletedCount > 0) {
      console.log(`🗑️ Emergency Unlock record deleted for ${email}`);
      return res.json({ status: "deleted" });
    }

    return res.json({ status: "not_found" });
  } catch (err) {
    console.error("❌ Error deleting emergency record:", err);
    return res.status(500).json({ error: "Database delete error" });
  }
});

// ------------------------------------------------------
app.listen(PORT, () => {
  console.log(`🚀 Backend running on http://localhost:${PORT}`);
});