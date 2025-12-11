import express from "express";
import crypto from "crypto";
import cors from "cors";
import dotenv from "dotenv";
import mongoose from "mongoose";
import Razorpay from "razorpay";
import geoip from "geoip-lite";
import rateLimit from "express-rate-limit";
import paypal from "@paypal/checkout-server-sdk";

import jwt from "jsonwebtoken";
import { OAuth2Client } from "google-auth-library";
import helmet from "helmet";
import bcrypt from "bcryptjs";

dotenv.config();

import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

const app = express();
const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI;

app.set("trust proxy", 1);

// ---------------------------
// Security middlewares (safe & non-breaking)
// ---------------------------
// Only CORS as global (you can lock origins below if you want)
// If you later want to restrict to the extension origin, change origin to an array:
// origin: ["chrome-extension://hokdmlppdlkokmlolddngkcceadflbke", "http://localhost:3000"]
app.use(cors());
// Helmet for security headers (harmless, non-breaking)
app.use(helmet());

// NOTE: We intentionally do NOT call app.use(express.json()) globally because
// the Razorpay webhook requires express.raw() to compute signatures correctly.
// We'll apply express.json() selectively to routes that need it.

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

// ------------------------------------------------------
// JWT & Google Auth Setup
// ------------------------------------------------------
const JWT_SECRET = process.env.JWT_SECRET || "replace_me_with_strong_secret";
const JWT_EXPIRY = process.env.JWT_EXPIRY || "30d";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

function signJwt(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY });
}

function verifyJwtToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return null;
  }
}

/**
 * Non-blocking middleware: if Authorization header / token is present and valid,
 * set req.user = payload. Otherwise set req.user = null and allow the request to continue.
 *
 * This keeps existing behavior intact (old callers using ?email= will still work).
 */
function verifyJwt(req, res, next) {
  const authHeader =
    req.headers.authorization ||
    req.query.token ||
    req.headers["x-access-token"];
  if (!authHeader) {
    req.user = null;
    return next();
  }

  const token = authHeader.startsWith("Bearer ")
    ? authHeader.split(" ")[1]
    : authHeader;

  const payload = verifyJwtToken(token);
  if (!payload) {
    req.user = null;
    return next();
  }

  req.user = payload; // typically { email, iat, exp }
  next();
}
// ------------------------------------------------------
// Rate limiters and helpers
// ------------------------------------------------------
const feedbackLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20,
  message: { error: "Too many feedback submissions. Please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

const createPaymentLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 20,
  message: { error: "Too many payment requests. Try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

// ------------------------------------------------------
// Schemas / Models
// ------------------------------------------------------
const PaidUserSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, index: true },
  paidAt: { type: Date, default: Date.now },
  expiresAt: { type: Date },
  amount: { type: Number, required: true },
});

const PaidUser = mongoose.model("PaidUser", PaidUserSchema);

const PaypalOrderSchema = new mongoose.Schema({
  orderID: { type: String, required: true, unique: true },
  email: { type: String, required: true, index: true },
  createdAt: { type: Date, default: Date.now },
  captured: { type: Boolean, default: false },
});

const PaypalOrder = mongoose.model("PaypalOrder", PaypalOrderSchema);

const EmergencySchema = new mongoose.Schema({
  email: String,
  amount: Number,
  paidAt: { type: Date, default: Date.now },
  status: { type: String, default: "paid" }, // preserve additional fields
  used: { type: Boolean, default: false },
  razorpay_payment_id: { type: String, default: null },
  razorpay_link_id: { type: String, default: null },
});

const EmergencyUnlock = mongoose.model("EmergencyUnlock", EmergencySchema);

const DailyUsageSchema = new mongoose.Schema({
  deviceId: { type: String, required: true, index: true },
  siteId: { type: String, required: true },
  date: { type: String, required: true }, // "YYYY-MM-DD"
  totalMinutes: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

DailyUsageSchema.index({ deviceId: 1, siteId: 1, date: 1 }, { unique: true });
DailyUsageSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 7 * 24 * 60 * 60 }
);

const DailyUsage = mongoose.model("DailyUsage", DailyUsageSchema);

const UserSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true },
    email: { type: String, required: true, unique: true, index: true },
    passwordHash: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
  },
  { collection: "users" }
);

const User = mongoose.model("User", UserSchema);

const OtpSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, index: true },
    otp: { type: String, required: true },
    purpose: { type: String, default: "pin_reset" },
    createdAt: { type: Date, default: Date.now },
  },
  { collection: "otps" }
);

// TTL: delete docs 2 minutes after createdAt
OtpSchema.index({ createdAt: 1 }, { expireAfterSeconds: 2 * 60 });

const Otp = mongoose.model("Otp", OtpSchema);

const PinSettingsSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, index: true },
    pinHash: { type: String, required: true }, // hashed PIN
    areas: { type: [String], default: [] }, // e.g. ["pinlocktime", "pincustomurl"]
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  { collection: "pin_settings" }
);

PinSettingsSchema.index({ email: 1 }, { unique: true });

const PinSettings = mongoose.model("PinSettings", PinSettingsSchema);

// ------------------------------------------------------
// Helper: PayPal client factory
// ------------------------------------------------------
function createPaypalClient() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_SECRET;
  const environment = new paypal.core.SandboxEnvironment(
    clientId,
    clientSecret
  );
  return new paypal.core.PayPalHttpClient(environment);
}

// ------------------------------------------------------
// Resend / Email setup already at top (resend)
// ------------------------------------------------------

// Root
app.get("/", (req, res) => {
  res.send("Backend is running ✔️");
});

// ------------------------------------------------------
// New: Exchange Google access_token for JWT
// ------------------------------------------------------
app.post("/api/auth/google", express.json(), async (req, res) => {
  const { access_token } = req.body;
  if (!access_token) {
    return res.status(400).json({ error: "Missing access_token" });
  }

  try {
    // Validate token with Google
    // For implicit flow tokens, tokeninfo is a light-weight verification
    const tokenInfo = await googleClient.getTokenInfo(access_token);

    // Ensure token audience matches your client ID
    if (!tokenInfo || tokenInfo.aud !== GOOGLE_CLIENT_ID) {
      console.warn(
        "Google token audience mismatch or invalid token:",
        tokenInfo
      );
      return res.status(401).json({ error: "Invalid token" });
    }

    const email = tokenInfo.email;
    const name = tokenInfo.email || tokenInfo.sub || "unknown";

    // Sign JWT for extension to use
    const jwtToken = signJwt({ email });

    return res.json({
      jwt: jwtToken,
      email,
      name,
      expiresIn: JWT_EXPIRY,
    });
  } catch (err) {
    console.error("Google auth verify failed:", err);
    return res.status(401).json({ error: "Invalid or expired Google token" });
  }
});

// ⚠️ ONLY Global Middleware: CORS
app.use(cors());

// Root check
app.get("/", (req, res) => {
  res.send("Backend is running ✔️");
});

// ------------------------------------------------------
// Payment link creation (Razorpay) - uses express.json() only on route
// ------------------------------------------------------
app.post(
  "/api/create-payment-link",
  createPaymentLimiter,
  express.json(),
  async (req, res) => {
    const { amount, email } = req.body;
    const amountInPaise = Math.round(amount * 100);

    if (!amount || !email) {
      return res
        .status(400)
        .json({ error: "Missing amount or email in request." });
    }

    const expireInSeconds = 25 * 60; // 25 minutes
    const expireTime = Math.floor(Date.now() / 1000) + expireInSeconds;

    console.log(
      `[Link Creation] Calculated Expire Time (UNIX): ${expireTime} (${expireInSeconds} seconds from now)`
    );

    const paymentLinkData = {
      amount: amountInPaise,
      currency: "INR",
      expire_by: expireTime,
      reference_id: `REF_${Date.now()}`,
      description: "Premium Feature Access",
      customer: {
        email: email,
      },
      notify: { email: true, sms: false },
      reminder_enable: true,
      callback_url:
        "chrome-extension://hokdmlppdlkokmlolddngkcceadflbke/premium.html",
      callback_method: "get",
      options: {
        checkout: {
          name: "BlockSocialMedia", // forces app name in checkout
        },
      },
    };

    try {
      const link = await razorpay.paymentLink.create(paymentLinkData);
      console.log(`✔️ New Payment Link Created: ${link.short_url}`);
      res.status(200).json({
        link_url: link.short_url,
        link_id: link.id,
      });
    } catch (error) {
      console.error("❌ Error creating Razorpay link:", error);
      res.status(500).json({ error: "Failed to create payment link." });
    }
  }
);

// ------------------------------------------------------
// Emergency payment link creation
// ------------------------------------------------------
app.post(
  "/api/create-emergency-payment-link",
  express.json(),
  async (req, res) => {
    const { amount, email } = req.body;
    const amountInPaise = Math.round(amount * 100);

    if (!amount || !email) {
      return res
        .status(400)
        .json({ error: "Missing amount or email in request." });
    }

    const expireInSeconds = 25 * 60; // 25 minutes
    const expireTime = Math.floor(Date.now() / 1000) + expireInSeconds;

    console.log(
      `[Link Creation] Calculated Expire Time (UNIX): ${expireTime} (${expireInSeconds} seconds from now)`
    );

    const paymentLinkData = {
      amount: amountInPaise,
      currency: "INR",
      expire_by: expireTime,
      reference_id: `REF_${Date.now()}`,
      description: "Emergency unlock fetaures",
      customer: { email: email },
      notify: { email: true, sms: false },
      reminder_enable: true,
      callback_url:
        "chrome-extension://hokdmlppdlkokmlolddngkcceadflbke/premium.html",
      callback_method: "get",
    };

    try {
      const link = await razorpay.paymentLink.create(paymentLinkData);
      console.log(`✔️ New Emergency Payment Link Created: ${link.short_url}`);

      res.status(200).json({
        link_url: link.short_url,
        link_id: link.id,
      });
    } catch (error) {
      console.error(
        "❌ Error creating Razorpay link for Emergency Lock:",
        error
      );
      res
        .status(500)
        .json({ error: "Failed to create payment link for Emergency Lock." });
    }
  }
);

// ------------------------------------------------------
// WEBHOOK HANDLER for Razorpay (raw body) — unchanged logic
// ------------------------------------------------------
app.post(
  "/api/razorpay/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const receivedSignature = req.headers["x-razorpay-signature"];

    // Signature validation (req.body is Buffer because of express.raw)
    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(req.body)
      .digest("hex");

    if (receivedSignature !== expectedSignature) {
      console.log("❌ Signature mismatch");
      return res.status(400).json({ error: "Invalid signature" });
    }

    console.log("✔️ Signature Verified.");

    let body = {};
    try {
      body = JSON.parse(req.body.toString());
    } catch (e) {
      console.error("❌ Failed to parse webhook JSON:", e);
      return res.status(400).json({ error: "Invalid JSON" });
    }

    console.log("📩 Event:", body.event);

    if (body.event === "payment_link.paid") {
      let email =
        body.payload.payment?.entity?.email ||
        body.payload.payment_link?.entity?.customer?.email ||
        body.payload.payment_link?.entity?.email ||
        null;

      const amount = body.payload.payment?.entity?.amount;
      const linkId = body.payload.payment_link?.entity?.id;

      if ((!email || email.includes("razorpay.com")) && linkId) {
        console.log(
          `🔍 Email missing or invalid in webhook payload. Falling back to Razorpay API fetch for link ${linkId}...`
        );
        try {
          const linkDetails = await razorpay.paymentLink.fetch(linkId);
          email = linkDetails.customer?.email || null;

          if (email) {
            console.log(
              "✔️ Email successfully fetched via Razorpay API:",
              email
            );
          } else {
            console.warn(
              "⚠️ Email still not found after fetching link details from API."
            );
          }
        } catch (apiError) {
          console.error("❌ Razorpay API Fetch Error:", apiError);
        }
      }

      if (
        email &&
        !email.includes("razorpay.com") &&
        amount !== undefined &&
        amount !== null
      ) {
        const cleanedEmail = email.toLowerCase().trim();

        try {
          if (amount === 4900) {
            const now = new Date();
            const expireDate = new Date(
              now.getTime() + 30 * 24 * 60 * 60 * 1000
            ); // +30 days

            await PaidUser.findOneAndUpdate(
              { email: cleanedEmail },
              {
                $set: {
                  paidAt: now,
                  expiresAt: expireDate,
                  amount: amount,
                },
              },
              { upsert: true, new: true }
            );
            console.log(`✔️ Premium payment saved for: ${cleanedEmail}`);
          } else if (amount === 2900) {
            await EmergencyUnlock.create({
              email: cleanedEmail,
              amount: 2900,
              status: "paid",
              used: false,
              razorpay_payment_id: body.payload.payment?.entity?.id || null,
              razorpay_link_id: body.payload.payment_link?.entity?.id || null,
            });
            console.log(`✔️ Emergency Unlock saved for: ${cleanedEmail}`);
          }
        } catch (dbError) {
          console.error("❌ DB Save Error:", dbError);
          return res.status(500).json({ error: "DB Error" });
        }
      } else {
        console.warn(
          "⚠️ Webhook processing skipped. Customer email was still null/placeholder or amount was missing after all checks."
        );
      }
    }

    return res.json({ status: "ok" });
  }
);

// ------------------------------------------------------
// STATUS CHECK: READS FROM DATABASE (augmented to use JWT, non-breaking)
// ------------------------------------------------------
app.get("/api/check-payment-status", verifyJwt, async (req, res) => {
  let email = req.user?.email || req.query.email;
  email = email?.toLowerCase().trim();

  if (!email) return res.json({ status: "missing_email" });

  try {
    const user = await PaidUser.findOne({ email });

    if (!user) {
      return res.json({ status: "pending" });
    }

    if (user.expiresAt && user.expiresAt < Date.now()) {
      return res.json({ status: "expired" });
    }

    return res.json({ status: "paid", expiresAt: user.expiresAt });
  } catch (err) {
    console.error("check-payment-status error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// Health
app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

// ------------------------------------------------------
// Check emergency payment status
// ------------------------------------------------------
app.get("/api/check-emergency-status", async (req, res) => {
  const email = req.query.email?.toLowerCase().trim();

  if (!email) return res.json({ status: "missing_email" });

  const record = await EmergencyUnlock.findOne({ email });

  if (!record) {
    return res.json({ status: "pending" });
  }

  return res.json({ status: "paid", amount: record.amount });
});

// app.get("/api/check-emergency-status", async (req, res) => {
//   const email = req.query.email?.toLowerCase().trim();

//   if (!email) return res.json({ status: "missing_email" });

//   // Look up user emergency unlock record
//   const record = await EmergencyUnlock.findOne({ email });

//   if (!record) {
//     return res.json({ status: "pending" });
//   }

//   return res.json({ status: "paid", amount: record.amount });
// });

// ------------------------------------------------------
// Country detection
// ------------------------------------------------------
app.get("/api/country", (req, res) => {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0];
  const geo = geoip.lookup(ip);

  if (geo && geo.country) {
    return res.json({
      country_code: geo.country,
      country_name: geo.city || "Unknown",
    });
  }

  return res.json({
    country_code: "IN",
    country_name: "India",
  });
});

// ------------------------------------------------------
// Delete emergency payment record
// ------------------------------------------------------
app.get("/api/delete-emergency-payment", async (req, res) => {
  const email = req.query.email?.toLowerCase().trim();

  if (!email) {
    return res.status(400).json({ error: "Missing email" });
  }

  try {
    const result = await EmergencyUnlock.deleteOne({
      email: email,
      amount: 2900,
    });

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

app.post("/api/feedback", feedbackLimiter, express.json(), async (req, res) => {
  const { rating, type, name, email, message } = req.body;

  // Enhanced validation
  if (!rating || !type || !name?.trim() || !email?.trim() || !message?.trim()) {
    return res.status(400).json({ error: "Missing or empty required fields" });
  }

  if (rating < 1 || rating > 5) {
    return res.status(400).json({ error: "Rating must be 1-5 stars" });
  }

  // -------------------------
  // ⭐ ENHANCED IP + Location
  // -------------------------
  const ip =
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket.remoteAddress ||
    "Unknown";
  const location = geoip.lookup(ip) || {};
  const country = location.country || "Unknown";
  const city = location.city || "Unknown";
  const region = location.region || "Unknown";

  // -------------------------
  // ⭐ ADVANCED Device Detection
  // -------------------------
  const userAgent = req.headers["user-agent"] || "Unknown Device";

  const parseDevice = (ua) => {
    let browser = "Unknown",
      os = "Unknown",
      device = "Desktop";

    // Browser detection (more precise)
    if (/chrome|crios/i.test(ua)) browser = "Chrome";
    else if (/firefox/i.test(ua)) browser = "Firefox";
    else if (/safari/i.test(ua) && !/chrome/i.test(ua)) browser = "Safari";
    else if (/edg/i.test(ua)) browser = "Edge";
    else if (/opera|opr/i.test(ua)) browser = "Opera";

    // OS + Device detection
    if (/windows/i.test(ua)) os = "Windows";
    else if (/macintosh|mac os x/i.test(ua)) os = "macOS";
    else if (/linux/i.test(ua)) os = "Linux";
    else if (/android/i.test(ua)) {
      os = "Android";
      device = "Mobile";
    } else if (/iphone|ipad|ipod/i.test(ua)) {
      os = "iOS";
      device = "Mobile";
    }

    // Extension detection
    const isExtension = ua.includes("Chrome/") && ua.includes("Extension");

    return { browser, os, device, isExtension };
  };

  const deviceInfo = parseDevice(userAgent);

  // -------------------------
  // ⭐ STAR RATING VISUAL
  // -------------------------
  const starRating = "★".repeat(rating) + "☆".repeat(5 - rating);

  // -------------------------
  // ⭐ PROFESSIONAL HTML TEMPLATE
  // -------------------------
  const emailHtml = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif; padding:30px; background:linear-gradient(135deg,#667eea 0%,#764ba2 100%); min-height:100vh;">
      <div style="max-width:700px; margin:0 auto; background:#ffffff; border-radius:20px; box-shadow:0 20px 40px rgba(0,0,0,0.1); overflow:hidden;">
        
        <!-- Header -->
        <div style="background:linear-gradient(135deg,#4f46e5,#7c3aed); color:white; padding:30px; text-align:center;">
          <h1 style="margin:0; font-size:28px; font-weight:700;">📩 New User Feedback</h1>
          <div style="font-size:24px; margin:10px 0; font-weight:300;">
            ${starRating}
          </div>
          <p style="margin:0; opacity:0.9; font-size:16px;">${rating}/5 Stars</p>
        </div>

        <!-- Content -->
        <div style="padding:30px;">
          <div style="display:grid; grid-template-columns:1fr 1fr; gap:20px; margin-bottom:25px;">
            <div>
              <h3 style="margin:0 0 8px 0; color:#374151; font-size:16px;">👤 User Details</h3>
              <p><strong>Name:</strong> ${name}</p>
              <p><strong>Email:</strong> <a href="mailto:${email}" style="color:#4f46e5;">${email}</a></p>
              <p><strong>Type:</strong> <span style="background:#dbeafe; padding:4px 12px; border-radius:20px; color:#1e40af; font-weight:500;">${type}</span></p>
            </div>
            <div>
              <h3 style="margin:0 0 8px 0; color:#374151; font-size:16px;">📍 Location</h3>
              <p><strong>IP:</strong> <code style="background:#f3f4f6; padding:2px 6px; border-radius:4px; font-family:monospace;">${ip}</code></p>
              <p><strong>Location:</strong> ${city}, ${region}, ${country}</p>
            </div>
          </div>

          <!-- Message -->
          <div style="background:#f8fafc; border:2px solid #e2e8f0; border-radius:12px; padding:25px; margin:25px 0;">
            <h3 style="margin:0 0 15px 0; color:#1f2937;">💬 User Message</h3>
            <div style="font-size:16px; line-height:1.6; color:#374151; white-space:pre-wrap;">
              ${message.replace(/\n/g, "<br>")}
            </div>
          </div>

          <!-- Device Info -->
          <div style="background:#f1f5f9; border-radius:12px; padding:20px; margin-top:25px;">
            <h3 style="margin:0 0 15px 0; color:#1e293b; display:flex; align-items:center; gap:8px;">
              🖥️ Device & Browser
              ${
                deviceInfo.isExtension
                  ? '<span style="background:#10b981; color:white; padding:2px 8px; border-radius:12px; font-size:12px;">EXTENSION</span>'
                  : ""
              }
            </h3>
            <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:12px; font-size:14px;">
              <div><strong>Browser:</strong> ${deviceInfo.browser}</div>
              <div><strong>OS:</strong> ${deviceInfo.os}</div>
              <div><strong>Device:</strong> ${deviceInfo.device}</div>
              <div><strong>User Agent:</strong> ${userAgent.slice(0, 80)}${
    userAgent.length > 80 ? "..." : ""
  }</div>
            </div>
          </div>

          <!-- Timestamp -->
          <div style="text-align:center; padding:20px; color:#6b7280; font-size:13px; border-top:1px solid #e5e7eb;">
            Received: ${new Date().toLocaleString("en-US", {
              weekday: "long",
              year: "numeric",
              month: "long",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
              timeZoneName: "short",
            })}
            <br><strong>BlockSocialMedia Chrome Extension</strong> © ${new Date().getFullYear()}
          </div>
        </div>
      </div>
    </div>
  `;

  // -------------------------
  // ⭐ Send Enhanced Email
  // -------------------------
  try {
    // await resend.emails.send({
    //   from: `BlockSocialMedia <onboarding@resend.dev>`,
    //   to: process.env.FEEDBACK_EMAIL,
    //   subject: `⭐ ${rating}/5 Stars - ${type} Feedback from ${name}`,
    //   html: emailHtml,
    //   tags: [
    //     `feedback-${rating}-stars`,
    //     `type-${type}`,
    //     `browser-${deviceInfo.browser}`,
    //   ],
    // });

    const resendResult = await resend.emails.send({
      from: "BlockSocialMedia <onboarding@resend.dev>",
      to: process.env.FEEDBACK_EMAIL,
      subject: `New Feedback – ${rating} ★ – ${type} from ${name}`,
      html: emailHtml,
    });

    console.log("📬 Feedback sent via Resend!", resendResult);

    // console.log(`📬 Feedback sent: ${rating}★ ${type} from ${email}`);
    return res.json({
      success: true,
      message: "Thank you for your feedback! 🎉",
    });
  } catch (err) {
    console.error("❌ Resend Email Error:", err);
    return res.status(500).json({ error: "Failed to send feedback" });
  }
});

app.post("/api/create-paypal-order", express.json(), async (req, res) => {
  const { amount, email } = req.body;
  if (!amount || !email)
    return res.status(400).json({ error: "Missing amount or email" });

  try {
    const client = createPaypalClient();

    const request = new paypal.orders.OrdersCreateRequest();
    request.requestBody({
      intent: "CAPTURE",
      purchase_units: [
        {
          amount: { currency_code: "USD", value: amount.toString() },
          custom_id: email,
        },
      ],
      application_context: {
        shipping_preference: "NO_SHIPPING",
      },
    });

    const order = await client.execute(request);

    await PaypalOrder.create({
      orderID: order.result.id,
      email,
      captured: false,
    });

    const approveLink = order.result.links.find(
      (l) => l.rel === "approve"
    )?.href;

    return res.json({ orderID: order.result.id, approveLink });
  } catch (err) {
    console.error("PayPal Create Order Error:", err);
    return res.status(500).json({ error: "PayPal order creation failed" });
  }
});

app.get("/api/check-paypal-status", async (req, res) => {
  const email = req.query.email?.toLowerCase().trim();
  if (!email) return res.status(400).json({ error: "Missing email" });

  try {
    const pending = await PaypalOrder.findOne({ email, captured: false }).sort({
      createdAt: -1,
    });
    if (!pending) return res.json({ status: "pending" });

    const client = createPaypalClient();

    const getReq = new paypal.orders.OrdersGetRequest(pending.orderID);
    const orderResp = await client.execute(getReq);

    const status = orderResp.result.status;
    console.log("PayPal order status:", pending.orderID, status);

    if (status === "APPROVED") {
      try {
        const capReq = new paypal.orders.OrdersCaptureRequest(pending.orderID);
        capReq.requestBody({});
        const capResp = await client.execute(capReq);

        pending.captured = true;
        await pending.save();

        const payerEmail = capResp.result.payer?.email_address || email;

        const now = new Date();
        const expire = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

        await PaidUser.findOneAndUpdate(
          { email: payerEmail.toLowerCase().trim() },
          {
            paidAt: now,
            expiresAt: expire,
            amount: Math.round(
              parseFloat(
                capResp.result.purchase_units[0].payments.captures[0].amount
                  .value
              ) * 100
            ),
          },
          { upsert: true }
        );

        return res.json({ status: "paid" });
      } catch (err) {
        console.error("PayPal capture failed:", err);
        return res.json({ status: "pending" });
      }
    }

    if (status === "COMPLETED") {
      pending.captured = true;
      await pending.save();
      return res.json({ status: "paid" });
    }

    return res.json({ status: "pending", paypalStatus: status });
  } catch (err) {
    console.error("check-paypal-status error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/capture-paypal-order", express.json(), async (req, res) => {
  try {
    const { orderID } = req.body;
    if (!orderID) {
      return res.status(400).json({ error: "Missing orderID" });
    }

    const client = createPaypalClient(); // ← we already created this earlier

    // Capture request for PayPal
    const request = new paypal.orders.OrdersCaptureRequest(orderID);
    request.requestBody({});

    const capture = await client.execute(request);

    console.log("PayPal Capture Response:", capture.result);

    // Extract buyer email
    const payerEmail =
      capture.result.payer?.email_address ||
      capture.result.purchase_units?.[0]?.payee?.email_address ||
      null;

    if (!payerEmail) {
      console.error("❌ No email found in PayPal capture!");
      return res.status(500).json({ error: "No email found in transaction" });
    }

    // Store PREMIUM USER — same logic as Razorpay
    const now = new Date();
    const expireDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    await PaidUser.findOneAndUpdate(
      { email: payerEmail.toLowerCase().trim() },
      {
        paidAt: now,
        expiresAt: expireDate,
        amount: capture.result.purchase_units[0].amount.value, // USD value
      },
      { upsert: true, new: true }
    );

    return res.json({ success: true });
  } catch (err) {
    console.error("PayPal Capture Error:", err);
    return res.status(500).json({ error: "PayPal capture failed" });
  }
});

// ------------------------------------------------------
// 🚨 DAILY ERROR SUMMARY ENDPOINT
app.post("/api/report-error-daily", express.json(), async (req, res) => {
  const { errors, date } = req.body;

  if (!errors || !Array.isArray(errors) || errors.length === 0) {
    return res.json({ success: true });
  }

  // IP for geo
  const ip =
    req.headers["x-forwarded-for"]?.split(",")[0] ||
    req.socket.remoteAddress ||
    "Unknown";
  const location = geoip.lookup(ip) || {};

  // Build HTML summary
  let emailHtml = `
    <div style="font-family:Arial, sans-serif; padding:20px; background:#f7f7f7;">
      <div style="max-width:700px; margin:0 auto; background:#ffffff; padding:25px; border-radius:12px;">
        <h1 style="color:#d32f2f;">📊 Daily Extension Error Report</h1>
        <h2 style="color:#333;">${date} (${errors.length} errors)</h2>
        
        <div style="background:#fff3cd; padding:15px; border-radius:8px; margin:20px 0;">
          <p><strong>IP:</strong> ${ip} | <strong>Location:</strong> ${
    location.city || "N/A"
  }, ${location.country || "N/A"}</p>
        </div>
  `;

  errors.forEach((err, i) => {
    emailHtml += `
      <div style="border-left:4px solid #f44336; padding:15px; margin:20px 0; background:#fafafa;">
        <h3 style="margin-top:0;">#${i + 1} ${err.context}</h3>
        <p><strong>Time:</strong> ${new Date(
          err.timestamp
        ).toLocaleString()}</p>
        <p><strong>User:</strong> ${err.userEmail}</p>
        <p><strong>Message:</strong> ${err.message}</p>
        ${
          err.stack
            ? `<details><summary>Stack Trace</summary><pre style="font-size:11px; overflow:auto;">${err.stack}</pre></details>`
            : ""
        }
      </div>
    `;
  });

  emailHtml += `
        <hr/>
        <p style="text-align:center; color:#666; font-size:12px;">
          BlockSocialMedia Chrome Extension | Auto-generated daily report
        </p>
      </div>
    </div>
  `;

  try {
    await resend.emails.send({
      from: "BlockSocialMedia Daily <onboarding@resend.dev>",
      to: process.env.FEEDBACK_EMAIL,
      subject: `📊 Extension Errors: ${errors.length} issues on ${date}`,
      html: emailHtml,
    });

    console.log(`📧 Daily report sent: ${errors.length} errors on ${date}`);
    res.json({ success: true });
  } catch (err) {
    console.error("Daily report email failed:", err);
    res.status(500).json({ error: "Email failed" });
  }
});

app.get("/api/free-limit-status", async (req, res) => {
  const deviceId = req.query.deviceId;
  const siteId = req.query.siteId;
  if (!deviceId || !siteId) {
    return res.status(400).json({ error: "Missing deviceId or siteId" });
  }

  const today = new Date().toISOString().slice(0, 10);

  try {
    const usage = await DailyUsage.findOne({ deviceId, siteId, date: today });
    const used = usage?.totalMinutes || 0;
    const remaining = Math.max(0, 30 - used);
    const canUse = remaining > 0;

    return res.json({ canUse, used, remaining, limit: 30 });
  } catch (e) {
    console.error("free-limit-status error", e);
    return res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/free-log-usage", express.json(), async (req, res) => {
  const { deviceId, siteId, minutes } = req.body;

  if (!deviceId || !siteId || !minutes || minutes <= 0) {
    return res.status(400).json({ error: "Invalid deviceId/siteId/minutes" });
  }

  const today = new Date().toISOString().slice(0, 10);

  try {
    const doc = await DailyUsage.findOneAndUpdate(
      { deviceId, siteId, date: today },
      {
        $setOnInsert: { deviceId, siteId, date: today, createdAt: new Date() },
        $inc: { totalMinutes: minutes },
        $set: { updatedAt: new Date() },
      },
      { new: true, upsert: true }
    );

    const used = doc.totalMinutes;
    const remaining = Math.max(0, 30 - used);
    return res.json({ success: true, used, remaining, limit: 30 });
  } catch (e) {
    console.error("free-log-usage error", e);
    return res.status(500).json({ error: "Server error" });
  }
});

// ------------------------------------------------------
// Email + Password SIGNUP
// ------------------------------------------------------
app.post("/api/auth/signup", express.json(), async (req, res) => {
  try {
    const { name, email, password } = req.body || {};

    if (!name || !name.trim() || !email || !password) {
      return res
        .status(400)
        .json({ error: "Name, email and password are required" });
    }

    if (password.length < 6) {
      return res
        .status(400)
        .json({ error: "Password must be at least 6 characters" });
    }

    const normalizedEmail = email.toLowerCase().trim();

    const existing = await User.findOne({ email: normalizedEmail });
    if (existing) {
      return res
        .status(409)
        .json({ error: "Email already registered. Please log in." });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const user = await User.create({
      name: name.trim(),
      email: normalizedEmail,
      passwordHash,
    });

    const jwtToken = signJwt({ email: user.email });

    return res.json({
      jwt: jwtToken,
      email: user.email,
      name: user.name,
      expiresIn: JWT_EXPIRY,
    });
  } catch (err) {
    console.error("Email signup error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ------------------------------------------------------
// Email + Password LOGIN
// ------------------------------------------------------
app.post("/api/auth/login", express.json(), async (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    const normalizedEmail = email.toLowerCase().trim();

    const user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const jwtToken = signJwt({ email: user.email });

    return res.json({
      jwt: jwtToken,
      email: user.email,
      name: user.name,
      expiresIn: JWT_EXPIRY,
    });
  } catch (err) {
    console.error("Email login error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

const sendPinOtpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 4, // max 4 OTP emails per 15 min per IP
  message: { error: "Too many OTP requests. Try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

app.post(
  "/api/pin/send-otp",
  express.json(),
  sendPinOtpLimiter,
  async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email required" });

    const normalizedEmail = email.toLowerCase().trim();
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    try {
      // optional: delete old OTPs for this email
      await Otp.deleteMany({ email: normalizedEmail, purpose: "pin_reset" });

      await Otp.create({
        email: normalizedEmail,
        otp,
        purpose: "pin_reset",
      });

      await resend.emails.send({
        from: "BlockSocialMedia <onboarding@resend.dev>",
        to: normalizedEmail,
        subject: "Block Social Media - PIN Reset Code",
        html: `
        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif; background:#f3f4f6; padding:24px;">
          <div style="max-width:480px; margin:0 auto; background:#ffffff; border-radius:16px; box-shadow:0 10px 30px rgba(15,23,42,0.12); overflow:hidden;">
            
            <!-- Header -->
            <div style="background:linear-gradient(135deg,#4f46e5,#7c3aed); padding:18px 24px; color:#ffffff;">
              <h1 style="margin:0; font-size:20px; font-weight:600;">PIN Reset Code</h1>
              <p style="margin:4px 0 0; font-size:13px; opacity:0.9;">
                Pin Reset - BlockSocialMedia 
              </p>
            </div>
      
            <!-- Content -->
            <div style="padding:24px 24px 20px;">
              <p style="margin:0 0 12px; font-size:14px; color:#111827;">
                Use the following one-time code to reset your PIN.
              </p>
      
              <!-- OTP Code -->
              <div style="
                margin:16px 0 18px;
                padding:14px 20px;
                background:#111827;
                color:#f9fafb;
                font-size:26px;
                font-weight:700;
                letter-spacing:8px;
                text-align:center;
                border-radius:12px;
              ">
                ${otp}
              </div>
      
              <p style="margin:0 0 8px; font-size:13px; color:#4b5563;">
                This code is valid for <strong>2 minutes</strong>. For your security, do not share it with anyone.
              </p>
              <p style="margin:0 0 16px; font-size:13px; color:#6b7280;">
                If you did not request a PIN reset, you can safely ignore this email. Your existing PIN will remain active.
              </p>
      
              <hr style="border:none; border-top:1px solid #e5e7eb; margin:18px 0 14px;" />
      
              <p style="margin:0; font-size:11px; color:#9ca3af; line-height:1.5;">
                Sent by <strong>BlockSocialMedia · SaveTime</strong><br/>
                You are receiving this email because a PIN reset was requested from the Chrome extension.
              </p>
            </div>
          </div>
        </div>
      `,
      });
      console.log("📧 OTP email sent via Resend:", otp);
      res.json({ success: true, message: "OTP sent" });
    } catch (err) {
      console.error("Send OTP error:", err);
      res.status(500).json({ error: "Server error" });
    }
  }
);

const pinResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // e.g. 4 verify attempts per 15 min per IP
  message: { error: "Too many PIN reset attempts. Try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

app.post(
  "/api/pin/reset",
  express.json(),
  pinResetLimiter,
  async (req, res) => {
    const { email, otp } = req.body;
    if (!email || !otp || otp.length !== 6) {
      return res
        .status(400)
        .json({ error: "Valid email and 6-digit OTP required" });
    }

    const normalizedEmail = email.toLowerCase().trim();

    try {
      const record = await Otp.findOne({
        email: normalizedEmail,
        purpose: "pin_reset",
        otp,
      });

      if (!record) {
        return res.status(400).json({ error: "Invalid or expired OTP" });
      }

      // consume OTP
      await Otp.deleteMany({ email: normalizedEmail, purpose: "pin_reset" });
      await PinSettings.deleteOne({ email: normalizedEmail });
      // you don't touch PIN here; frontend will clear local PIN after success
      res.json({ success: true });
    } catch (err) {
      console.error("PIN reset verify error:", err);
      res.status(500).json({ error: "Server error" });
    }
  }
);

// Save or update PIN settings for a user
app.post("/api/pin/save", express.json(), verifyJwt, async (req, res) => {
  try {
    const { email: bodyEmail, pin, areas } = req.body || {};

    // email from JWT is the trusted one
    const email = (req.user?.email || bodyEmail || "").toLowerCase().trim();
    if (!email) {
      return res.status(400).json({ error: "Missing email" });
    }

    if (!Array.isArray(areas)) {
      return res.status(400).json({ error: "areas must be an array" });
    }

    let update = { areas, updatedAt: new Date() };

    if (pin) {
      if (typeof pin !== "string" || pin.length !== 6) {
        return res.status(400).json({ error: "PIN must be 6 digits" });
      }
      // hash new PIN
      const pinHash = await bcrypt.hash(pin, 10);
      update.pinHash = pinHash;
      if (!update.createdAt) update.createdAt = new Date();
    }

    const result = await PinSettings.findOneAndUpdate(
      { email },
      { $set: update },
      { upsert: !!pin, new: true }
    );

    if (!result) {
      return res.status(400).json({ error: "PIN not found for update" });
    }

    return res.json({ success: true });
  } catch (err) {
    console.error("PIN save error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/pin/verify", express.json(), verifyJwt, async (req, res) => {
  try {
    const { email: bodyEmail, pin, areaId } = req.body || {};

    const email = (req.user?.email || bodyEmail || "").toLowerCase().trim();
    if (!email || !pin || !areaId) {
      return res.status(400).json({ ok: false, error: "Missing fields" });
    }

    const settings = await PinSettings.findOne({ email });
    if (!settings || !settings.pinHash) {
      return res.status(400).json({ ok: false, error: "PIN not set" });
    }

    // If this area is not protected, treat as allowed
    if (
      settings.areas &&
      !settings.areas.includes(areaId) &&
      areaId !== "pinmaster"
    ) {
      return res.json({ ok: true });
    }

    const valid = await bcrypt.compare(pin, settings.pinHash);
    if (!valid) {
      return res.status(401).json({ ok: false, error: "Incorrect PIN" });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("PIN verify error:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// ------------------------------------------------------
app.listen(PORT, () => {
  console.log(`🚀 Backend running on http://localhost:${PORT}`);
});
