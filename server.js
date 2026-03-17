require('dotenv').config();
const express = require('express');
const path = require('path');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');
const { Resend } = require('resend');
const { initDB, upsertCliente, criarVMBanco, registrarPagamento, getVMsByEmail, getAllClientes, getAllVMs } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || 'https://wiikfx.com';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const mp = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
const resend = new Resend(process.env.RESEND_API_KEY);

const PLANS = {
  basic: { name: 'WiikFX VPS Basic', price: 129.00, ram: '4GB', cpu: '2 vCPUs', disk: '40GB SSD' },
  pro:   { name: 'WiikFX VPS Pro',   price: 189.00, ram: '6GB', cpu: '4 vCPUs', disk: '40GB SSD' },
};

// ── Páginas ───────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/vps', (req, res) => res.sendFile(path.join(__dirname, 'public', 'vps.html')));
app.get('/sucesso', (req, res) => res.sendFile(path.join(__dirname, 'public', 'sucesso.html')));
app.get('/pendente', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pendente.html')));

// ── API: Checkout avulso ──────────────────────────────
app.post('/api/checkout/avulso', async (req, res) => {
  const { plan, nome, email, whatsapp } = req.body;
  if (!plan || !PLANS[plan]) return res.status(400).json({ error: 'Plano invalido' });
  if (!nome || !email) return res.status(400).json({ error: 'Nome e email obrigatorios' });
  const plano = PLANS[plan];
  try {
    const preference = new Preference(mp);
    const result = await preference.create({
      body: {
        items: [{ title: plano.name, quantity: 1, unit_price: plano.price, currency_id: 'BRL' }],
        payer: { name: nome, email },
        metadata: { plan, nome, email, whatsapp, tipo: 'avulso' },
        back_urls: {
          success: `${BASE_URL}/sucesso`,
          failure: `${BASE_URL}/vps`,
          pending: `${BASE_URL}/pendente`,
        },
        auto_return: 'approved',
        notification_url: `${BASE_URL}/api/webhook/mercadopago`,
        payment_methods: { installments: 1 },
      }
    });
    res.json({ checkout_url: result.init_point });
  } catch (err) {
    console.error('Erro checkout avulso:', err);
    res.status(500).json({ error: 'Erro ao iniciar pagamento' });
  }
});

// ── API: Checkout assinatura ──────────────────────────
app.post('/api/checkout/assinatura', async (req, res) => {
  const { plan, nome, email, whatsapp } = req.body;
  if (!plan || !PLANS[plan]) return res.status(400).json({ error: 'Plano invalido' });
  if (!nome || !email) return res.status(400).json({ error: 'Nome e email obrigatorios' });
  const plano = PLANS[plan];
  try {
    const response = await fetch('https://api.mercadopago.com/preapproval', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({
        reason: plano.name,
        auto_recurring: {
          frequency: 1,
          frequency_type: 'months',
          transaction_amount: plano.price,
          currency_id: 'BRL',
        },
        payer_email: email,
        back_url: `${BASE_URL}/sucesso`,
        notification_url: `${BASE_URL}/api/webhook/mercadopago`,
        external_reference: JSON.stringify({ plan, nome, email, whatsapp, tipo: 'assinatura' }),
      }),
    });
    const data = await response.json();
    if (!data.init_point) throw new Error(data.message || 'Erro na assinatura');
    res.json({ checkout_url: data.init_point });
  } catch (err) {
    console.error('Erro checkout assinatura:', err);
    res.status(500).json({ error: 'Erro ao iniciar assinatura' });
  }
});

// ── Webhook Mercado Pago ──────────────────────────────
app.post('/api/webhook/mercadopago', async (req, res) => {
  res.sendStatus(200);
  const { type, data } = req.body;
  try {
    if (type === 'payment' && data?.id) {
      const paymentClient = new Payment(mp);
      const payment = await paymentClient.get({ id: data.id });
      if (payment.status !== 'approved') return;
      const meta = payment.metadata || {};
      if (!meta.plan || !meta.email) return;
      await ativarVPS({
        plan: meta.plan, nome: meta.nome, email: meta.email, whatsapp: meta.whatsapp,
        tipo: 'avulso', mpPaymentId: String(data.id), valor: payment.transaction_amount,
      });
    }
    if (type === 'subscription_preapproval' && data?.id) {
      const r = await fetch(`https://api.mercadopago.com/preapproval/${data.id}`, {
        headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}` },
      });
      const sub = await r.json();
      if (sub.status !== 'authorized') return;
      const ref = JSON.parse(sub.external_reference || '{}');
      if (!ref.plan || !ref.email) return;
      await ativarVPS({
        plan: ref.plan, nome: ref.nome, email: ref.email, whatsapp: ref.whatsapp,
        tipo: 'assinatura', mpPreapprovalId: String(data.id),
        valor: PLANS[ref.plan]?.price,
      });
    }
  } catch (err) {
    console.error('Erro webhook:', err);
  }
});

// ── Ativar VPS ────────────────────────────────────────
async function ativarVPS({ plan, nome, email, whatsapp, tipo, mpPaymentId, mpPreapprovalId, valor }) {
  console.log(`Ativando VPS ${plan} para ${email}`);
  const plano = PLANS[plan];

  // 1. Salvar/atualizar cliente no banco
  const cliente = await upsertCliente({ nome, email, whatsapp });

  // 2. Criar VM no Proxmox (ou simular se não configurado)
  let vmInfo;
  if (process.env.PROXMOX_HOST && process.env.PROXMOX_HOST !== 'https://ip_do_servidor:8006') {
    vmInfo = await criarVMProxmox({ plan, email });
  } else {
    vmInfo = { ip: '000.000.000.000', usuario: 'Administrator', senha: gerarSenha(), porta: 3389, vmid: null };
    console.log('Proxmox nao configurado — simulando:', vmInfo);
  }

  // 3. Salvar VM no banco
  const vm = await criarVMBanco({
    clienteId: cliente.id, plano: plan, tipoCobranca: tipo,
    vmid: vmInfo.vmid, ip: vmInfo.ip, senha: vmInfo.senha,
    preapprovalId: mpPreapprovalId,
  });

  // 4. Registrar pagamento
  await registrarPagamento({
    vmId: vm.id, clienteId: cliente.id,
    mpPaymentId, mpPreapprovalId, tipo, status: 'aprovado', valor,
  });

  // 5. Enviar email
  await enviarEmailBoasVindas({ nome, email, plan: plano, vmInfo });

  console.log(`VPS ativada — cliente: ${email}, IP: ${vmInfo.ip}`);
}

// ── Criar VM no Proxmox ───────────────────────────────
async function criarVMProxmox({ plan, email }) {
  const SPECS = { basic: { memory: 4096, cores: 2 }, pro: { memory: 6144, cores: 4 } };
  const spec = SPECS[plan];
  const vmid = 200 + Math.floor(Math.random() * 800);
  const senha = gerarSenha();
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `PVEAPIToken=${process.env.PROXMOX_USER}!${process.env.PROXMOX_TOKEN_ID}=${process.env.PROXMOX_TOKEN_SECRET}`,
  };
  await fetch(`${process.env.PROXMOX_HOST}/api2/json/nodes/pve/qemu/100/clone`, {
    method: 'POST', headers,
    body: JSON.stringify({ newid: vmid, name: `vps-${email.split('@')[0]}`, full: 1 }),
  });
  await new Promise(r => setTimeout(r, 15000));
  await fetch(`${process.env.PROXMOX_HOST}/api2/json/nodes/pve/qemu/${vmid}/config`, {
    method: 'PUT', headers,
    body: JSON.stringify({ memory: spec.memory, cores: spec.cores }),
  });
  await fetch(`${process.env.PROXMOX_HOST}/api2/json/nodes/pve/qemu/${vmid}/status/start`, {
    method: 'POST', headers,
  });
  return { ip: 'A definir', usuario: 'Administrator', senha, porta: 3389, vmid };
}

// ── Email de boas-vindas ──────────────────────────────
async function enviarEmailBoasVindas({ nome, email, plan, vmInfo }) {
  await resend.emails.send({
    from: process.env.EMAIL_FROM || 'WiikFX <noreply@wiikfx.com>',
    to: email,
    subject: `Sua VPS WiikFX esta pronta!`,
    html: `
      <div style="font-family:Arial,sans-serif;background:#050505;color:#ffffff;padding:40px;max-width:560px;margin:0 auto;border-radius:16px;">
        <div style="text-align:center;margin-bottom:32px;">
          <span style="font-size:2.5rem;font-weight:900;">
            <span style="color:#1B4D3E">Wiik</span><span style="color:#5CBF8A">FX</span>
          </span>
        </div>
        <h1 style="font-size:1.4rem;font-weight:800;margin-bottom:8px;">Sua VPS esta ativa, ${nome}!</h1>
        <p style="color:#888;margin-bottom:28px;">Plano <strong style="color:#5CBF8A">${plan.name}</strong> ativado. Aqui estao seus dados de acesso:</p>
        <div style="background:#0d0d0d;border:1px solid rgba(92,191,138,0.2);border-radius:12px;padding:24px;margin-bottom:24px;">
          <table style="width:100%;border-collapse:collapse;">
            <tr><td style="color:#888;padding:8px 0;font-size:.9rem;">IP do servidor</td><td style="font-weight:700;color:#fff;text-align:right;">${vmInfo.ip}</td></tr>
            <tr style="border-top:1px solid #1a1a1a"><td style="color:#888;padding:8px 0;font-size:.9rem;">Usuario</td><td style="font-weight:700;color:#fff;text-align:right;">${vmInfo.usuario}</td></tr>
            <tr style="border-top:1px solid #1a1a1a"><td style="color:#888;padding:8px 0;font-size:.9rem;">Senha</td><td style="font-weight:700;color:#5CBF8A;text-align:right;">${vmInfo.senha}</td></tr>
            <tr style="border-top:1px solid #1a1a1a"><td style="color:#888;padding:8px 0;font-size:.9rem;">Porta RDP</td><td style="font-weight:700;color:#fff;text-align:right;">${vmInfo.porta}</td></tr>
          </table>
        </div>
        <div style="background:rgba(27,77,62,0.2);border:1px solid rgba(92,191,138,0.15);border-radius:10px;padding:16px;margin-bottom:24px;">
          <p style="font-size:.85rem;color:#aaa;margin:0;line-height:1.6;">
            <strong style="color:#5CBF8A">Como conectar:</strong> No Windows, abra "Conexao de Area de Trabalho Remota", digite o IP e faca login com as credenciais acima.
          </p>
        </div>
        <p style="color:#555;font-size:.8rem;text-align:center;">Suporte: <a href="https://t.me/WiikFX" style="color:#5CBF8A;">t.me/WiikFX</a></p>
      </div>
    `,
  });
}

// ── Utilitários ───────────────────────────────────────
function gerarSenha() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789@#!';
  return Array.from({ length: 14 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

// ── Fallback ──────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Iniciar servidor ──────────────────────────────────
// Servidor sobe imediatamente (healthcheck do Railway)
// Banco inicializa em paralelo sem bloquear
app.listen(PORT, () => console.log(`WiikFX rodando na porta ${PORT}`));

initDB().catch(err => {
  console.error('Aviso: erro ao inicializar banco:', err.message);
});
