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
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

const PLANS = {
  basic: { name: 'WiikFX VPS Basic', price: 129.00, ram: '4GB', cpu: '2 vCPUs', disk: '40GB SSD' },
  pro:   { name: 'WiikFX VPS Pro',   price: 189.00, ram: '6GB', cpu: '4 vCPUs', disk: '40GB SSD' },
};

// ── Páginas ───────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/vps', (req, res) => res.sendFile(path.join(__dirname, 'public', 'vps.html')));
app.get('/sucesso', (req, res) => res.sendFile(path.join(__dirname, 'public', 'sucesso.html')));
app.get('/pendente', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pendente.html')));

// ── Portal: Login (magic link) ───────────────────────
app.post('/api/auth/login', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email obrigatorio' });

  const cliente = await getClienteByEmail(email);
  if (!cliente) return res.status(404).json({ error: 'Email nao encontrado. Voce ja contratou uma VPS?' });

  const token = await criarTokenAcesso(cliente.id);
  const link = `${BASE_URL}/api/auth/verificar?token=${token}`;

  if (resend) {
    await resend.emails.send({
      from: process.env.EMAIL_FROM || 'WiikFX <noreply@wiikfx.com>',
      to: email,
      subject: 'Seu link de acesso WiikFX',
      html: `
        <div style="font-family:Arial,sans-serif;background:#050505;color:#fff;padding:40px;max-width:480px;margin:0 auto;border-radius:16px;">
          <div style="text-align:center;margin-bottom:24px;">
            <span style="font-size:2rem;font-weight:900;"><span style="color:#1B4D3E">Wiik</span><span style="color:#5CBF8A">FX</span></span>
          </div>
          <h2 style="font-size:1.2rem;font-weight:700;margin-bottom:8px;">Acesse seu portal</h2>
          <p style="color:#888;margin-bottom:24px;font-size:.9rem;">Clique no botão abaixo para entrar no seu painel. O link expira em 15 minutos.</p>
          <a href="${link}" style="display:block;text-align:center;background:#5CBF8A;color:#050505;padding:14px;border-radius:12px;font-weight:700;text-decoration:none;font-size:1rem;">Acessar meu portal</a>
          <p style="color:#444;font-size:.75rem;margin-top:20px;text-align:center;">Se nao solicitou este acesso, ignore este email.</p>
        </div>
      `,
    });
  }

  res.json({ ok: true });
});

app.get('/api/auth/verificar', async (req, res) => {
  const { token } = req.query;
  const dados = await validarTokenAcesso(token);
  if (!dados) return res.redirect('/login?erro=link_invalido');

  const sessionToken = await criarSessao(dados.cliente_id);
  res.setHeader('Set-Cookie', `wiikfx_session=${sessionToken}; Path=/; HttpOnly; Max-Age=2592000; SameSite=Lax`);
  res.redirect('/portal');
});

app.post('/api/auth/logout', async (req, res) => {
  const sessionToken = parseCookie(req.headers.cookie)['wiikfx_session'];
  if (sessionToken) await encerrarSessao(sessionToken);
  res.setHeader('Set-Cookie', 'wiikfx_session=; Path=/; Max-Age=0');
  res.json({ ok: true });
});

// ── Auth: Login com senha ────────────────────────────
app.post('/api/auth/login-senha', async (req, res) => {
  const { email, senha } = req.body;
  if (!email || !senha) return res.status(400).json({ error: 'Email e senha obrigatorios' });

  const cliente = await getClienteComSenha(email);
  if (!cliente) return res.status(404).json({ error: 'Email nao encontrado' });
  if (!cliente.senha_hash) return res.status(400).json({ error: 'sem_senha', msg: 'Voce ainda nao tem senha. Use o link magico para acessar e defina uma senha nas configuracoes.' });

  const hash = hashSenha(senha);
  if (hash !== cliente.senha_hash) return res.status(401).json({ error: 'Senha incorreta' });

  const sessionToken = await criarSessao(cliente.id);
  res.setHeader('Set-Cookie', `wiikfx_session=${sessionToken}; Path=/; HttpOnly; Max-Age=2592000; SameSite=Lax`);
  res.json({ ok: true });
});

// ── Auth: Solicitar link para definir senha ───────────
app.post('/api/auth/solicitar-senha', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email obrigatorio' });

  const cliente = await getClienteByEmail(email);
  if (!cliente) return res.status(404).json({ error: 'Email nao encontrado' });

  const token = await criarTokenSenha(cliente.id);
  const link = `${BASE_URL}/definir-senha?token=${token}`;

  if (resend) {
    await resend.emails.send({
      from: process.env.EMAIL_FROM || 'WiikFX <noreply@wiikfx.com>',
      to: email,
      subject: 'Defina sua senha WiikFX',
      html: `
        <div style="font-family:Arial,sans-serif;background:#050505;color:#fff;padding:40px;max-width:480px;margin:0 auto;border-radius:16px;">
          <div style="text-align:center;margin-bottom:24px;">
            <span style="font-size:2rem;font-weight:900;"><span style="color:#1B4D3E">Wiik</span><span style="color:#5CBF8A">FX</span></span>
          </div>
          <h2 style="font-size:1.2rem;font-weight:700;margin-bottom:8px;">Defina sua senha</h2>
          <p style="color:#888;margin-bottom:24px;font-size:.9rem;">Clique no botão abaixo para definir sua senha de acesso. O link expira em 30 minutos.</p>
          <a href="${link}" style="display:block;text-align:center;background:#5CBF8A;color:#050505;padding:14px;border-radius:12px;font-weight:700;text-decoration:none;font-size:1rem;">Definir minha senha</a>
          <p style="color:#444;font-size:.75rem;margin-top:20px;text-align:center;">Se nao solicitou, ignore este email.</p>
        </div>
      `,
    });
  }
  res.json({ ok: true });
});

// ── Auth: Definir senha via token ─────────────────────
app.post('/api/auth/definir-senha', async (req, res) => {
  const { token, senha } = req.body;
  if (!token || !senha) return res.status(400).json({ error: 'Token e senha obrigatorios' });
  if (senha.length < 8) return res.status(400).json({ error: 'Senha deve ter pelo menos 8 caracteres' });

  const dados = await validarTokenAcesso(token);
  if (!dados) return res.status(400).json({ error: 'Link invalido ou expirado' });

  await definirSenha(dados.cliente_id, hashSenha(senha));

  // Criar sessão automaticamente após definir senha
  const sessionToken = await criarSessao(dados.cliente_id);
  res.setHeader('Set-Cookie', `wiikfx_session=${sessionToken}; Path=/; HttpOnly; Max-Age=2592000; SameSite=Lax`);
  res.json({ ok: true });
});

// ── Auth: Alterar senha (autenticado) ─────────────────
app.post('/api/portal/alterar-senha', async (req, res) => {
  const sessionToken = parseCookie(req.headers.cookie)['wiikfx_session'];
  const sessao = await validarSessao(sessionToken);
  if (!sessao) return res.status(401).json({ error: 'Nao autenticado' });

  const { senha_atual, senha_nova } = req.body;
  if (!senha_nova || senha_nova.length < 8) return res.status(400).json({ error: 'Nova senha deve ter pelo menos 8 caracteres' });

  const cliente = await getClienteComSenha(sessao.email);
  if (cliente.senha_hash && hashSenha(senha_atual) !== cliente.senha_hash) {
    return res.status(401).json({ error: 'Senha atual incorreta' });
  }

  await definirSenha(sessao.cliente_id, hashSenha(senha_nova));
  res.json({ ok: true });
});

// ── Portal: Dados do cliente ──────────────────────────
app.get('/api/portal/dados', async (req, res) => {
  const sessionToken = parseCookie(req.headers.cookie)['wiikfx_session'];
  const sessao = await validarSessao(sessionToken);
  if (!sessao) return res.status(401).json({ error: 'Nao autenticado' });

  const vms = await getVMsByEmail(sessao.email);
  const pagamentos = await getPagamentosByClienteId(sessao.cliente_id);
  const clienteCompleto = await getClienteComSenha(sessao.email);
  res.json({
    cliente: { nome: sessao.nome, email: sessao.email, tem_senha: !!clienteCompleto?.senha_hash },
    vms, pagamentos
  });
});

// ── Portal: Reiniciar VM ──────────────────────────────
app.post('/api/portal/reiniciar/:vmid', async (req, res) => {
  const sessionToken = parseCookie(req.headers.cookie)['wiikfx_session'];
  const sessao = await validarSessao(sessionToken);
  if (!sessao) return res.status(401).json({ error: 'Nao autenticado' });

  const { vmid } = req.params;
  if (!process.env.PROXMOX_HOST || process.env.PROXMOX_HOST === 'https://ip_do_servidor:8006') {
    return res.json({ ok: true, msg: 'Proxmox nao configurado — simulado' });
  }

  try {
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `PVEAPIToken=${process.env.PROXMOX_USER}!${process.env.PROXMOX_TOKEN_ID}=${process.env.PROXMOX_TOKEN_SECRET}`,
    };
    await fetch(`${process.env.PROXMOX_HOST}/api2/json/nodes/pve/qemu/${vmid}/status/reboot`, {
      method: 'POST', headers,
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao reiniciar VM' });
  }
});

function parseCookie(cookieStr = '') {
  return Object.fromEntries(cookieStr.split(';').map(c => c.trim().split('=').map(decodeURIComponent)));
}

// ── Páginas do portal ─────────────────────────────────
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/definir-senha', (req, res) => res.sendFile(path.join(__dirname, 'public', 'definir-senha.html')));
app.get('/portal', async (req, res) => {
  const sessionToken = parseCookie(req.headers.cookie)['wiikfx_session'];
  const sessao = await validarSessao(sessionToken);
  if (!sessao) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'portal.html'));
});

// ── API: Checkout avulso ──────────────────────────────
app.post('/api/checkout/avulso', async (req, res) => {
  const { plan, period = 'mensal', nome, email, whatsapp } = req.body;
  if (!plan || !PLANS[plan]) return res.status(400).json({ error: 'Plano invalido' });
  if (!nome || !email) return res.status(400).json({ error: 'Nome e email obrigatorios' });
  const plano = PLANS[plan];
  const preco = plano.prices[period] || plano.prices.mensal;
  const titulo = `${plano.name} — ${PERIOD_LABEL[period]}`;
  try {
    const preference = new Preference(mp);
    const result = await preference.create({
      body: {
        items: [{ title: titulo, quantity: 1, unit_price: preco, currency_id: 'BRL' }],
        payer: { name: nome, email },
        metadata: { plan, period, nome, email, whatsapp, tipo: 'avulso' },
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
  // Validar assinatura secreta do MP
  if (process.env.MP_WEBHOOK_SECRET) {
    const crypto = require('crypto');
    const xSignature = req.headers['x-signature'] || '';
    const xRequestId = req.headers['x-request-id'] || '';
    const urlParams = new URLSearchParams(req.query);
    const dataId = urlParams.get('data.id') || req.body?.data?.id || '';
    const manifest = `id:${dataId};request-id:${xRequestId};ts:${xSignature.split(',').find(p => p.startsWith('ts='))?.split('=')[1] || ''};`;
    const ts = xSignature.split(',').find(p => p.startsWith('ts='))?.split('=')[1] || '';
    const v1 = xSignature.split(',').find(p => p.startsWith('v1='))?.split('=')[1] || '';
    const hash = crypto.createHmac('sha256', process.env.MP_WEBHOOK_SECRET).update(`id:${dataId};request-id:${xRequestId};ts:${ts};`).digest('hex');
    if (v1 && hash !== v1) {
      console.warn('Webhook com assinatura invalida — ignorado');
      return res.sendStatus(200);
    }
  }

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
async function ativarVPS({ plan, period = 'mensal', nome, email, whatsapp, mpPaymentId, valor }) {
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
  if (!resend) { console.warn('Resend nao configurado — email nao enviado'); return; }
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
