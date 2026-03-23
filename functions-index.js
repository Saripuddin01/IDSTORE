// ═══════════════════════════════════════════════════════════
// AkunStore — Firebase Cloud Functions
// File: functions/index.js
//
// Deploy: firebase deploy --only functions
// ═══════════════════════════════════════════════════════════

const functions = require("firebase-functions");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

// ═══════════════════════════════════════════
// processOrder — Called from storefront
// Takes product ID + buyer info
// Finds available account → delivers → logs order
// ═══════════════════════════════════════════
exports.processOrder = functions.https.onCall(async (data, context) => {
  const { productId, buyerName, buyerEmail } = data;

  // --- Validate input ---
  if (!productId || !buyerName || !buyerEmail) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "productId, buyerName, dan buyerEmail wajib diisi."
    );
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(buyerEmail)) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "Format email tidak valid."
    );
  }

  const productRef = db.collection("products").doc(productId);

  try {
    // === TRANSACTION: atomic pick + mark sold ===
    const result = await db.runTransaction(async (t) => {
      // 1. Check product exists & has stock
      const productDoc = await t.get(productRef);
      if (!productDoc.exists) {
        throw new functions.https.HttpsError("not-found", "Produk tidak ditemukan.");
      }

      const product = productDoc.data();
      if ((product.stock || 0) <= 0) {
        throw new functions.https.HttpsError(
          "resource-exhausted",
          "Stok produk habis! Silakan hubungi admin."
        );
      }

      // 2. Get one available (unsold) account
      const accountSnap = await t.get(
        productRef.collection("accounts")
          .where("sold", "==", false)
          .limit(1)
      );

      if (accountSnap.empty) {
        throw new functions.https.HttpsError(
          "resource-exhausted",
          "Stok akun habis. Silakan hubungi admin."
        );
      }

      const accountDoc = accountSnap.docs[0];
      const accountData = accountDoc.data();
      const accountRef = productRef.collection("accounts").doc(accountDoc.id);

      // 3. Mark account as sold
      t.update(accountRef, {
        sold: true,
        soldAt: admin.firestore.FieldValue.serverTimestamp(),
        soldTo: buyerEmail,
      });

      // 4. Decrement stock
      t.update(productRef, {
        stock: admin.firestore.FieldValue.increment(-1),
      });

      // 5. Create order record
      const orderRef = db.collection("orders").doc();
      t.set(orderRef, {
        productId,
        productName: product.name,
        productPrice: product.price || 0,
        buyerName,
        buyerEmail,
        accountDelivered: {
          username: accountData.username || null,
          password: accountData.password || null,
          notes: accountData.notes || null,
        },
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return {
        account: {
          username: accountData.username || null,
          password: accountData.password || null,
          notes: accountData.notes || null,
        },
        product: product.name,
        orderId: orderRef.id,
      };
    });

    // === (Optional) Send email via nodemailer ===
    // Uncomment & configure if you want email delivery
    // await sendDeliveryEmail(buyerEmail, buyerName, result);

    functions.logger.info(`Order sukses: ${result.orderId} → ${buyerEmail}`);

    return {
      success: true,
      message: "Akun berhasil dikirim!",
      account: result.account,
      orderId: result.orderId,
    };

  } catch (error) {
    functions.logger.error("processOrder error:", error);
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError("internal", "Terjadi kesalahan server. Coba lagi.");
  }
});


// ═══════════════════════════════════════════
// (Optional) Webhook dari payment gateway
// Contoh: Midtrans/Xendit server-to-server
// ═══════════════════════════════════════════
exports.paymentWebhook = functions.https.onRequest(async (req, res) => {
  // Verifikasi signature payment gateway di sini
  // const signature = req.headers['x-signature'];
  // if (!verifySignature(signature, req.body)) return res.status(403).send('Unauthorized');

  const { order_id, transaction_status, gross_amount } = req.body;

  if (transaction_status === "settlement" || transaction_status === "capture") {
    // Payment confirmed → process order
    try {
      // Parse order_id format: "AKUNSTORE-{productId}-{timestamp}"
      const parts = (order_id || "").split("-");
      const productId = parts[1];
      const buyerEmail = req.body.customer_details?.email;
      const buyerName = req.body.customer_details?.first_name || "Pelanggan";

      if (!productId || !buyerEmail) {
        return res.status(400).json({ error: "Missing productId or buyerEmail" });
      }

      // Reuse processOrder logic (direct Firestore call)
      // In production, call the callable function or duplicate the logic here
      functions.logger.info(`Payment confirmed for ${order_id}, processing...`);

      // TODO: trigger processOrder logic here
      // For now, log and return 200 to acknowledge webhook
      res.status(200).json({ received: true, order_id });

    } catch (e) {
      functions.logger.error("Webhook error:", e);
      res.status(500).json({ error: e.message });
    }
  } else {
    // Other statuses: pending, cancel, deny — just acknowledge
    res.status(200).json({ received: true, status: transaction_status });
  }
});


// ═══════════════════════════════════════════
// (Optional) Email delivery helper
// Requires: npm install nodemailer
// ═══════════════════════════════════════════
/*
const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: functions.config().mail.user,
    pass: functions.config().mail.pass,
  },
});

async function sendDeliveryEmail(to, name, orderData) {
  const { account, product } = orderData;
  await transporter.sendMail({
    from: '"AkunStore" <noreply@akunstore.com>',
    to,
    subject: `✅ Akun ${product} Kamu Sudah Siap!`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:auto">
        <h2>Halo ${name}!</h2>
        <p>Terima kasih telah berbelanja di AkunStore. Berikut detail akun kamu:</p>
        <div style="background:#f5f5f5;border-radius:8px;padding:20px;margin:20px 0">
          <p><strong>Produk:</strong> ${product}</p>
          <p><strong>Username/Email:</strong> <code>${account.username}</code></p>
          <p><strong>Password:</strong> <code>${account.password}</code></p>
          ${account.notes ? `<p><strong>Catatan:</strong> ${account.notes}</p>` : ''}
        </div>
        <p style="color:#e00">⚠️ Jangan bagikan akun ini ke siapapun!</p>
        <p>Salam,<br>Tim AkunStore</p>
      </div>
    `,
  });
}
*/
