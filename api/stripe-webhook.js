// api/stripe-webhook.js
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Stripe a besoin du corps brut de la requête pour vérifier la signature
export const config = {
  api: {
    bodyParser: false,
  },
};

function buffer(readable) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readable.on('data', (chunk) => chunks.push(chunk));
    readable.on('end', () => resolve(Buffer.concat(chunks)));
    readable.on('error', reject);
  });
}

async function notifySlack(message) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn('SLACK_WEBHOOK_URL non configuré, notification ignorée.');
    return;
  }

  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: message }),
    });
  } catch (err) {
    console.error('Erreur envoi Slack :', err);
  }
}

async function updateAirtable(email) {
  const baseId = process.env.AIRTABLE_BASE_ID;
  const tableName = process.env.AIRTABLE_TABLE_NAME;
  const token = process.env.AIRTABLE_TOKEN;
  const emailField = 'Email';
  const paymentField = 'Acompte 30 € payé ?';

  // 1. Chercher la ligne correspondant à cet email
  const searchUrl = `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}?filterByFormula=${encodeURIComponent(`{${emailField}} = "${email}"`)}`;

  const searchResponse = await fetch(searchUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const searchData = await searchResponse.json();

  if (!searchData.records || searchData.records.length === 0) {
    console.warn(`Aucune ligne Airtable trouvée pour l'email : ${email}`);
    return { found: false };
  }

  // 2. Mettre à jour la première ligne correspondante
  const recordId = searchData.records[0].id;
  const updateUrl = `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}/${recordId}`;

  const updateResponse = await fetch(updateUrl, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      fields: {
        [paymentField]: 'Oui',
      },
    }),
  });

  if (!updateResponse.ok) {
    const errText = await updateResponse.text();
    throw new Error(`Erreur mise à jour Airtable : ${errText}`);
  }

  return { found: true, recordId };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  const sig = req.headers['stripe-signature'];
  const rawBody = await buffer(req);

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Signature webhook invalide :', err.message);
    return res.status(400).json({ error: `Webhook signature invalide: ${err.message}` });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email = session.customer_details?.email || session.customer_email;
    const amount = session.amount_total ? (session.amount_total / 100).toFixed(2) : '?';

    if (email) {
      try {
        const result = await updateAirtable(email);
        if (result.found) {
          await notifySlack(`✅ Paiement reçu : ${amount}€ de ${email} (CZ Studio) — Airtable mis à jour.`);
        } else {
          await notifySlack(`⚠️ Paiement reçu : ${amount}€ de ${email} (CZ Studio) — mais AUCUNE ligne trouvée dans Airtable pour cet email. Vérification manuelle nécessaire.`);
        }
      } catch (err) {
        console.error('Erreur lors de la mise à jour Airtable :', err);
        await notifySlack(`⚠️ Paiement reçu de ${email} (${amount}€) mais erreur lors de la mise à jour Airtable : ${err.message}`);
      }
    } else {
      console.warn('Aucun email trouvé dans la session Stripe.');
      await notifySlack(`⚠️ Paiement reçu (${amount}€) mais aucun email associé — impossible de mettre à jour Airtable.`);
    }
  }

  if (event.type === 'payment_intent.payment_failed') {
    const intent = event.data.object;
    const email = intent.receipt_email || intent.charges?.data?.[0]?.billing_details?.email || 'email inconnu';
    const reason = intent.last_payment_error?.message || 'raison inconnue';
    await notifySlack(`❌ Paiement échoué pour ${email} (CZ Studio) — Raison : ${reason}`);
  }

  res.status(200).json({ received: true });
}
