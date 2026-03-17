const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Páginas ──────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/vps', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'vps.html'));
});

// ── Webhook Mercado Pago ──────────────────────────────
app.post('/api/webhook/mercadopago', async (req, res) => {
  const { type, data } = req.body;

  if (type === 'payment') {
    const paymentId = data?.id;
    console.log('Pagamento recebido:', paymentId);

    // TODO: consultar pagamento na API do MP
    // TODO: criar VM no Proxmox
    // TODO: enviar email via Resend
  }

  res.sendStatus(200);
});

// ── Fallback ──────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 WiikFX server running on port ${PORT}`);
});
