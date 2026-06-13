// api/webhook.js
const crypto = require('crypto');

// Initialisation Firebase
const admin = require('firebase-admin');

// Initialiser Firebase Admin SDK avec les credentials
if (!admin.apps.length) {
  try {
    const credentials = JSON.parse(process.env.FIREBASE_ADMIN_CREDENTIALS);
    admin.initializeApp({
      credential: admin.credential.cert(credentials),
      projectId: "gestion-dettes-fcea1"
    });
  } catch (e) {
    console.error("Firebase init error:", e);
  }
}

const db = admin.firestore();
const TRANSACTION_FEE_RATE = 0.10;

// Vérification de la signature webhook
function verifySignature(rawBody, signature, timestamp, webhookId, secret) {
  if (!signature || !timestamp || !webhookId || !secret) return false;
  
  const signedContent = `${webhookId}.${timestamp}.${rawBody}`;
  
  try {
    const secretKey = Buffer.from(secret, 'base64');
    const computed = crypto
      .createHmac('sha256', secretKey)
      .update(signedContent)
      .digest('base64');
    return signature.includes(computed);
  } catch (error) {
    console.error("Signature verification error:", error);
    return false;
  }
}

// Mise à jour de la dette
async function updateDebtAfterPayment(grossAmountPaid, debtorId, userEmail, transactionId) {
  if (!debtorId) return false;
  
  const fee = grossAmountPaid * TRANSACTION_FEE_RATE;
  const debtReduction = grossAmountPaid - fee;
  
  if (debtReduction <= 0) return false;
  
  try {
    const debtorRef = db.collection("debtors").doc(debtorId);
    const debtor = await debtorRef.get();
    
    if (!debtor.exists) {
      console.error("Debtor not found:", debtorId);
      return false;
    }
    
    const oldDebt = debtor.data().currentDebt || 0;
    const newDebt = Math.max(0, oldDebt - debtReduction);
    const today = new Date().toISOString().split('T')[0];
    
    const transaction = {
      type: "remboursement",
      amount: debtReduction,
      grossAmount: grossAmountPaid,
      fee: fee,
      date: today,
      description: `Paiement en ligne (ID: ${transactionId}) - Frais 10% déduits - Email: ${userEmail}`,
      timestamp: admin.firestore.Timestamp.now()
    };
    
    await debtorRef.update({
      currentDebt: newDebt,
      transactions: admin.firestore.FieldValue.arrayUnion(transaction)
    });
    
    console.log(`✅ Dette mise à jour: ${debtorId} - Réduction: ${debtReduction}€`);
    return true;
  } catch (error) {
    console.error("Erreur mise à jour Firebase:", error);
    return false;
  }
}

// Handler Vercel
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }
  
  const signature = req.headers['webhook-signature'];
  const timestamp = req.headers['webhook-timestamp'];
  const webhookId = req.headers['webhook-id'];
  const rawBody = JSON.stringify(req.body);
  const webhookSecret = process.env.DODO_WEBHOOK_SECRET;
  
  if (webhookSecret) {
    const isValid = verifySignature(rawBody, signature, timestamp, webhookId, webhookSecret);
    if (!isValid) {
      console.error("Invalid webhook signature");
      return res.status(401).send('Invalid signature');
    }
  }
  
  res.status(200).send('OK');
  
  try {
    const event = req.body;
    console.log("Webhook reçu:", event.type);
    
    if (event.type === 'payment.succeeded') {
      const metadata = event.metadata || {};
      const debtorId = metadata.debtor_id;
      const grossAmount = metadata.gross_amount || (event.amount / 100);
      const userEmail = event.customer?.email || metadata.customer_email;
      const transactionId = event.id || `payment_${Date.now()}`;
      
      if (debtorId && grossAmount) {
        await updateDebtAfterPayment(grossAmount, debtorId, userEmail, transactionId);
      }
    }
  } catch (error) {
    console.error("Webhook processing error:", error);
  }
};
