// ═══════════════════════════════════════════════════════════
// AkunStore — Backend Express.js untuk Railway.app
// File: server.js
//
// Deploy ke Railway:
// 1. Push ke GitHub
// 2. Connect Railway ke repo
// 3. Set environment variables di Railway dashboard
// ═══════════════════════════════════════════════════════════

const express = require("express");
const cors = require("cors");
const https = require("https");
const crypto = require("crypto");
const admin = require("firebase-admin");

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

// ═══════════════════════════════════════════
// FIREBASE ADMIN INIT
// Set environment variable: FIREBASE_SERVICE_ACCOUNT
// Isinya: JSON string dari service account key
// ═══════════════════════════════════════════
let db;
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
  db = admin.firestore();
  console.log("✅ Firebase connected");
} catch (e) {
  console.error("❌ Firebase init error:", e.message);
}

// ═══════════════════════════════════════════
// MIDTRANS CONFIG
// Set environment variables:
// MIDTRANS_SERVER_KEY=SB-Mid-server-xxxxx
// MIDTRANS_IS_PRODUCTION=false
// ═══════════════════════════════════════════
function getMidtransConfig() {
  const serverKey = process.env.MIDTRANS_SERVER_KEY || "";
  const isProduction = process.env.MIDTRANS_IS_PRODUCTION === "true";
  const apiUrl = isProduction
    ? "https://api.midtrans.com/v2"
    : "https://api.sandbox.midtrans.com/v2";
  const auth = Buffer.from(serverKey + ":").toString("base64");
  return { serverKey, isProduction, apiUrl, auth };
}

// ═══════════════════════════════════════════
// HELPER: HTTP Request ke Midtrans
// ═══════════════════════════════════════════
function midtransRequest(method, url, auth, body = null) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname,
      method,
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error("Invalid JSON dari Midtrans")); }
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ═══════════════════════════════════════════
// GET /products — Ambil semua produk
// ═══════════════════════════════════════════
app.get("/products", async (req, res) => {
  try {
    const snap = await db.collection("products").get();
    const products = [];
    snap.forEach((d) => products.push({ id: d.id, ...d.data() }));
    res.json({ success: true, products });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ═══════════════════════════════════════════
// POST /create-transaction
// Buat QRIS charge ke Midtrans
// Body: { productId, buyerName, buyerEmail }
// ═══════════════════════════════════════════
app.post("/create-transaction", async (req, res) => {
  const { productId, buyerName, buyerEmail } = req.body;

  if (!productId || !buyerName || !buyerEmail) {
    return res.status(400).json({ success: false, error: "Data tidak lengkap." });
  }

  try {
    // Cek produk & stok
    const productDoc = await db.collection("products").doc(productId).get();
    if (!productDoc.exists) {
      return res.status(404).json({ success: false, error: "Produk tidak ditemukan." });
    }
    const product = productDoc.data();
    if ((product.stock || 0) <= 0) {
      return res.status(400).json({ success: false, error: "Stok habis." });
    }

    const { apiUrl, auth } = getMidtransConfig();
    const orderId = `AKUNSTORE-${productId.slice(0, 6).toUpperCase()}-${Date.now()}`;

    // Buat charge QRIS
    const payload = {
      payment_type: "qris",
      transaction_details: {
        order_id: orderId,
        gross_amount: product.price,
      },
      customer_details: {
        first_name: buyerName,
        email: buyerEmail,
      },
      qris: { acquirer: "gopay" },
    };

    const response = await midtransRequest("POST", `${apiUrl}/charge`, auth, payload);

    if (!response.transaction_id) {
      console.error("Midtrans error:", response);
      return res.status(500).json({ success: false, error: response.status_message || "Gagal membuat transaksi." });
    }

    // URL gambar QR
    const qrCode =
      response.actions?.find((a) => a.name === "generate-qr-code")?.url ||
      response.qr_code_url ||
      null;

    // Simpan pending order ke Firestore
    await db.collection("pending_orders").doc(orderId).set({
      orderId,
      productId,
      productName: product.name,
      productPrice: product.price,
      buyerName,
      buyerEmail,
      transactionId: response.transaction_id,
      status: "pending",
      qrCode,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt: admin.firestore.Timestamp.fromDate(new Date(Date.now() + 10 * 60 * 1000)),
    });

    console.log(`✅ Transaksi dibuat: ${orderId}`);
    res.json({ success: true, orderId, qrCode, amount: product.price, expirySeconds: 600 });

  } catch (e) {
    console.error("create-transaction error:", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ═══════════════════════════════════════════
// GET /check-status/:orderId
// Cek status pembayaran ke Midtrans
// Jika paid → kirim akun ke user
// ═══════════════════════════════════════════
app.get("/check-status/:orderId", async (req, res) => {
  const { orderId } = req.params;

  try {
    const pendingDoc = await db.collection("pending_orders").doc(orderId).get();
    if (!pendingDoc.exists) {
      return res.status(404).json({ success: false, error: "Order tidak ditemukan." });
    }
    const pendingOrder = pendingDoc.data();

    // Sudah paid → return langsung
    if (pendingOrder.status === "paid") {
      return res.json({ success: true, status: "paid", account: pendingOrder.accountDelivered });
    }

    // Cek ke Midtrans
    const { apiUrl, auth } = getMidtransConfig();
    const response = await midtransRequest("GET", `${apiUrl}/${orderId}/status`, auth);
    const txStatus = response.transaction_status;
    const fraudStatus = response.fraud_status;

    if (txStatus === "settlement" || (txStatus === "capture" && fraudStatus === "accept")) {
      // Proses kirim akun — transaksi atomic
      const productRef = db.collection("products").doc(pendingOrder.productId);
      let deliveredAccount = null;

      await db.runTransaction(async (t) => {
        const freshPending = await t.get(db.collection("pending_orders").doc(orderId));
        if (freshPending.data().status === "paid") {
          deliveredAccount = freshPending.data().accountDelivered;
          return;
        }

        const productDoc = await t.get(productRef);
        if (!productDoc.exists || (productDoc.data().stock || 0) <= 0) {
          throw new Error("Stok habis.");
        }

        const accountSnap = await t.get(
          productRef.collection("accounts").where("sold", "==", false).limit(1)
        );
        if (accountSnap.empty) throw new Error("Akun habis.");

        const accDoc = accountSnap.docs[0];
        const accData = accDoc.data();
        deliveredAccount = {
          username: accData.username || null,
          password: accData.password || null,
          notes: accData.notes || null,
        };

        t.update(productRef.collection("accounts").doc(accDoc.id), {
          sold: true,
          soldAt: admin.firestore.FieldValue.serverTimestamp(),
          soldTo: pendingOrder.buyerEmail,
        });
        t.update(productRef, { stock: admin.firestore.FieldValue.increment(-1) });
        t.set(db.collection("orders").doc(orderId), {
          orderId,
          productId: pendingOrder.productId,
          productName: pendingOrder.productName,
          productPrice: pendingOrder.productPrice,
          buyerName: pendingOrder.buyerName,
          buyerEmail: pendingOrder.buyerEmail,
          accountDelivered: deliveredAccount,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        t.update(db.collection("pending_orders").doc(orderId), {
          status: "paid",
          accountDelivered: deliveredAccount,
          paidAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      });

      return res.json({ success: true, status: "paid", account: deliveredAccount });

    } else if (txStatus === "expire") {
      await db.collection("pending_orders").doc(orderId).update({ status: "expired" });
      return res.json({ success: true, status: "expired" });

    } else if (txStatus === "cancel" || txStatus === "deny") {
      await db.collection("pending_orders").doc(orderId).update({ status: "cancel" });
      return res.json({ success: true, status: "cancel" });

    } else {
      return res.json({ success: true, status: "pending" });
    }

  } catch (e) {
    console.error("check-status error:", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ═══════════════════════════════════════════
// POST /webhook — Notifikasi Midtrans
// Set di Midtrans: Payment Notification URL
// ═══════════════════════════════════════════
app.post("/webhook", async (req, res) => {
  const { order_id, transaction_status, fraud_status, signature_key, gross_amount, status_code } = req.body;

  // Verifikasi signature
  const { serverKey } = getMidtransConfig();
  const expected = crypto
    .createHash("sha512")
    .update(order_id + status_code + gross_amount + serverKey)
    .digest("hex");

  if (signature_key !== expected) {
    return res.status(403).json({ error: "Invalid signature" });
  }

  console.log(`Webhook: ${order_id} → ${transaction_status}`);
  res.status(200).json({ received: true });
});

// ═══════════════════════════════════════════
// Health check
// ═══════════════════════════════════════════
app.get("/", (req, res) => {
  res.json({ status: "AkunStore API OK 🚀", timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
