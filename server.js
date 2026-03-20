require('dotenv').config();
const express = require('express');
const path = require('path');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');
const { Resend } = require('resend');
const {
  initDB, upsertCliente, getClienteByEmail, getClienteComSenha,
  criarTokenAcesso, validarTokenAcesso,
  criarTokenSenha, definirSenha,
  criarSessao, validarSessao, encerrarSessao,
  criarVMBanco, registrarPagamento,
  getVMsByEmail, getPagamentosByClienteId,
  getIPDisponivel, marcarIPUsado, liberarIP,
} = require('./db');

const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || 'https://wiikfx.com';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const mp = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

function hashSenha(senha) {
  return crypto.createHash('sha256').update(senha + (process.env.SENHA_SALT || 'wiikfx2025')).digest('hex');
}

const PLANS = {
  vps1: { name: 'WiikFX VPS-1', ram: '4GB', cpu: '2 vCPUs', disk: '40GB SSD', prices: { mensal: 87.00, trimestral: 234.90, anual: 885.60 } },
  vps2: { name: 'WiikFX VPS-2', ram: '6GB', cpu: '4 vCPUs', disk: '50GB SSD', prices: { mensal: 127.00, trimestral: 342.90, anual: 1295.40 } },
  vps3: { name: 'WiikFX VPS-3', ram: '8GB', cpu: '6 vCPUs', disk: '60GB SSD', prices: { mensal: 197.00, trimestral: 531.90, anual: 2009.40 } },
};
const PERIOD_LABEL = { mensal: 'Mensal', trimestral: 'Trimestral', anual: 'Anual' };
const PERIOD_MONTHS = { mensal: 1, trimestral: 3, anual: 12 };
const PROXMOX_SPECS = {
  vps1: { memory: 4096, cores: 2, disk_extra: 0 },
  vps2: { memory: 6144, cores: 4, disk_extra: 10 },
  vps3: { memory: 8192, cores: 6, disk_extra: 20 },
};
const PROXMOX_TEMPLATE_ID = 203;
const PROXMOX_NODE = process.env.PROXMOX_NODE || 'm5527';

// ── Páginas ───────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/vps', (req, res) => res.sendFile(path.join(__dirname, 'public', 'vps.html')));
app.get('/sucesso', (req, res) => res.sendFile(path.join(__dirname, 'public', 'sucesso.html')));
app.get('/pendente', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pendente.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/definir-senha', (req, res) => res.sendFile(path.join(__dirname, 'public', 'definir-senha.html')));
app.get('/portal', async (req, res) => {
  const sessao = await validarSessao(parseCookie(req.headers.cookie)['wiikfx_session']);
  if (!sessao) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'portal.html'));
});

// ── Auth ──────────────────────────────────────────────
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
      html: emailBase(`<h2 style="font-size:1.2rem;font-weight:700;margin-bottom:8px;">Acesse seu portal</h2><p style="color:#888;margin-bottom:24px;font-size:.9rem;">Clique no botão abaixo para entrar no seu painel. O link expira em 15 minutos.</p><a href="${link}" style="display:block;text-align:center;background:#5CBF8A;color:#050505;padding:14px;border-radius:12px;font-weight:700;text-decoration:none;font-size:1rem;">Acessar meu portal</a>`),
    });
  }
  res.json({ ok: true });
});

app.get('/api/auth/verificar', async (req, res) => {
  const dados = await validarTokenAcesso(req.query.token);
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

app.post('/api/auth/login-senha', async (req, res) => {
  const { email, senha } = req.body;
  if (!email || !senha) return res.status(400).json({ error: 'Email e senha obrigatorios' });
  const cliente = await getClienteComSenha(email);
  if (!cliente) return res.status(404).json({ error: 'Email nao encontrado' });
  if (!cliente.senha_hash) return res.status(400).json({ error: 'sem_senha' });
  if (hashSenha(senha) !== cliente.senha_hash) return res.status(401).json({ error: 'Senha incorreta' });
  const sessionToken = await criarSessao(cliente.id);
  res.setHeader('Set-Cookie', `wiikfx_session=${sessionToken}; Path=/; HttpOnly; Max-Age=2592000; SameSite=Lax`);
  res.json({ ok: true });
});

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
      html: emailBase(`<h2 style="font-size:1.2rem;font-weight:700;margin-bottom:8px;">Defina sua senha</h2><p style="color:#888;margin-bottom:24px;font-size:.9rem;">Clique no botão abaixo para definir sua senha. O link expira em 30 minutos.</p><a href="${link}" style="display:block;text-align:center;background:#5CBF8A;color:#050505;padding:14px;border-radius:12px;font-weight:700;text-decoration:none;font-size:1rem;">Definir minha senha</a>`),
    });
  }
  res.json({ ok: true });
});

app.post('/api/auth/definir-senha', async (req, res) => {
  const { token, senha } = req.body;
  if (!token || !senha || senha.length < 8) return res.status(400).json({ error: 'Token e senha (min 8 chars) obrigatorios' });
  const dados = await validarTokenAcesso(token);
  if (!dados) return res.status(400).json({ error: 'Link invalido ou expirado' });
  await definirSenha(dados.cliente_id, hashSenha(senha));
  const sessionToken = await criarSessao(dados.cliente_id);
  res.setHeader('Set-Cookie', `wiikfx_session=${sessionToken}; Path=/; HttpOnly; Max-Age=2592000; SameSite=Lax`);
  res.json({ ok: true });
});

app.post('/api/portal/alterar-senha', async (req, res) => {
  const sessao = await validarSessao(parseCookie(req.headers.cookie)['wiikfx_session']);
  if (!sessao) return res.status(401).json({ error: 'Nao autenticado' });
  const { senha_atual, senha_nova } = req.body;
  if (!senha_nova || senha_nova.length < 8) return res.status(400).json({ error: 'Nova senha deve ter pelo menos 8 caracteres' });
  const cliente = await getClienteComSenha(sessao.email);
  if (cliente.senha_hash && hashSenha(senha_atual) !== cliente.senha_hash) return res.status(401).json({ error: 'Senha atual incorreta' });
  await definirSenha(sessao.cliente_id, hashSenha(senha_nova));
  res.json({ ok: true });
});

// ── Portal ────────────────────────────────────────────
app.get('/api/portal/dados', async (req, res) => {
  const sessao = await validarSessao(parseCookie(req.headers.cookie)['wiikfx_session']);
  if (!sessao) return res.status(401).json({ error: 'Nao autenticado' });
  const [vms, pagamentos, clienteCompleto] = await Promise.all([
    getVMsByEmail(sessao.email),
    getPagamentosByClienteId(sessao.cliente_id),
    getClienteComSenha(sessao.email),
  ]);
  res.json({ cliente: { nome: sessao.nome, email: sessao.email, tem_senha: !!clienteCompleto?.senha_hash }, vms, pagamentos });
});

app.post('/api/portal/reiniciar/:vmid', async (req, res) => {
  const sessao = await validarSessao(parseCookie(req.headers.cookie)['wiikfx_session']);
  if (!sessao) return res.status(401).json({ error: 'Nao autenticado' });
  const { vmid } = req.params;
  if (!proxmoxConfigurado()) return res.json({ ok: true, msg: 'Proxmox nao configurado — simulado' });
  try {
    await proxmoxRequest(`/nodes/${PROXMOX_NODE}/qemu/${vmid}/status/reboot`, 'POST');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao reiniciar VM' });
  }
});

// ── Checkout ──────────────────────────────────────────
app.post('/api/checkout/avulso', async (req, res) => {
  const { plan, period = 'mensal', nome, email, whatsapp } = req.body;
  if (!plan || !PLANS[plan]) return res.status(400).json({ error: 'Plano invalido' });
  if (!nome || !email) return res.status(400).json({ error: 'Nome e email obrigatorios' });
  const plano = PLANS[plan];
  const preco = plano.prices[period] || plano.prices.mensal;
  try {
    const preference = new Preference(mp);
    const result = await preference.create({
      body: {
        items: [{ title: `${plano.name} — ${PERIOD_LABEL[period]}`, quantity: 1, unit_price: preco, currency_id: 'BRL' }],
        payer: { name: nome, email },
        metadata: { plan, period, nome, email, whatsapp },
        back_urls: { success: `${BASE_URL}/sucesso`, failure: `${BASE_URL}/vps`, pending: `${BASE_URL}/pendente` },
        auto_return: 'approved',
        notification_url: `${BASE_URL}/api/webhook/mercadopago`,
        payment_methods: { installments: 1 },
      }
    });
    res.json({ checkout_url: result.init_point });
  } catch (err) {
    console.error('Erro checkout:', err);
    res.status(500).json({ error: 'Erro ao iniciar pagamento' });
  }
});

// ── Webhook MP ────────────────────────────────────────
app.post('/api/webhook/mercadopago', async (req, res) => {
  if (process.env.MP_WEBHOOK_SECRET) {
    const xSig = req.headers['x-signature'] || '';
    const xReqId = req.headers['x-request-id'] || '';
    const dataId = req.query['data.id'] || req.body?.data?.id || '';
    const ts = xSig.split(',').find(p => p.startsWith('ts='))?.split('=')[1] || '';
    const v1 = xSig.split(',').find(p => p.startsWith('v1='))?.split('=')[1] || '';
    const hash = crypto.createHmac('sha256', process.env.MP_WEBHOOK_SECRET).update(`id:${dataId};request-id:${xReqId};ts:${ts};`).digest('hex');
    if (v1 && hash !== v1) { console.warn('Webhook assinatura invalida'); return res.sendStatus(200); }
  }
  res.sendStatus(200);
  const { type, data } = req.body;
  try {
    if (type === 'payment' && data?.id) {
      const payment = await new Payment(mp).get({ id: data.id });
      if (payment.status !== 'approved') return;
      const meta = payment.metadata || {};
      if (!meta.plan || !meta.email) return;
      await ativarVPS({ plan: meta.plan, period: meta.period || 'mensal', nome: meta.nome, email: meta.email, whatsapp: meta.whatsapp, mpPaymentId: String(data.id), valor: payment.transaction_amount });
    }
  } catch (err) {
    console.error('Erro webhook:', err);
  }
});

// ── Ativar VPS ────────────────────────────────────────
async function ativarVPS({ plan, period = 'mensal', nome, email, whatsapp, mpPaymentId, valor }) {
  // Deduplicar — ignorar se pagamento ja foi processado
  const { pool } = require('./db');
  const jaProcessado = await pool.query('SELECT id FROM pagamentos WHERE mp_payment_id = $1', [String(mpPaymentId)]);
  if (jaProcessado.rows.length > 0) {
    console.log(`Pagamento ${mpPaymentId} ja processado — ignorando duplicata`);
    return;
  }
  console.log(`Ativando VPS ${plan} (${period}) para ${email}`);
  const plano = PLANS[plan];
  const cliente = await upsertCliente({ nome, email, whatsapp });
  const vmInfo = await criarVMProxmox({ plan, email });
  const vm = await criarVMBanco({
    clienteId: cliente.id, plano: plan, tipoCobranca: period,
    vmid: vmInfo.vmid, ip: vmInfo.ip, senha: vmInfo.senha,
    meses: PERIOD_MONTHS[period] || 1,
  });
  await registrarPagamento({ vmId: vm.id, clienteId: cliente.id, mpPaymentId, mpPreapprovalId: null, tipo: period, status: 'aprovado', valor });
  await enviarEmailBoasVindas({ nome, email, plan: plano, vmInfo });
  console.log(`VPS ativada — ${email} — IP: ${vmInfo.ip}`);
}

// ── Criar VM no Proxmox ───────────────────────────────
async function criarVMProxmox({ plan, email }) {
  const senha = gerarSenha();

  if (!proxmoxConfigurado()) {
    console.log('Proxmox nao configurado — simulando VM');
    return { ip: '000.000.000.000', usuario: 'Administrator', senha, porta: 3389, vmid: null };
  }

  const spec = PROXMOX_SPECS[plan];

  // Pegar próximo VMID disponível
  const vmListRes = await proxmoxRequest(`/nodes/${PROXMOX_NODE}/qemu`);
  const usedIds = (vmListRes.data || []).map(vm => vm.vmid);
  let vmid = 200;
  while (usedIds.includes(vmid)) vmid++;

  const ipInfo = await getIPDisponivel();
  if (!ipInfo) throw new Error('Nenhum IP disponivel no pool');

  // 1. Clonar template
  console.log(`Clonando template ${PROXMOX_TEMPLATE_ID} → VM ${vmid}`);
  const cloneRes = await proxmoxRequest(`/nodes/${PROXMOX_NODE}/qemu/${PROXMOX_TEMPLATE_ID}/clone`, 'POST', {
    newid: vmid,
    name: `vps-${email.split('@')[0].replace(/[^a-z0-9]/gi, '')}`,
    full: 1,
  });
  console.log(`Resposta clone: ${JSON.stringify(cloneRes)}`);
  if (!cloneRes.data) throw new Error(`Clone falhou: ${JSON.stringify(cloneRes)}`);

  // 2. Aguardar clonagem (120s max, não falha se timeout)
  await aguardarTaskProxmox(vmid, 120000);

  // 3. Ajustar recursos
  await proxmoxRequest(`/nodes/${PROXMOX_NODE}/qemu/${vmid}/config`, 'PUT', {
    memory: spec.memory,
    cores: spec.cores,
  });

  // Resize disco conforme plano
  if (spec.disk_extra > 0) {
    console.log(`Redimensionando disco +${spec.disk_extra}G para VM ${vmid}`);
    await proxmoxRequest(`/nodes/${PROXMOX_NODE}/qemu/${vmid}/resize`, 'PUT', {
      disk: 'scsi0', size: `+${spec.disk_extra}G`,
    });
    await aguardarResizeCompleto(vmid, 60000);
  }

  // 4. Iniciar VM
  console.log(`Iniciando VM ${vmid}...`);
  const startRes = await proxmoxRequest(`/nodes/${PROXMOX_NODE}/qemu/${vmid}/status/start`, 'POST');
  console.log(`Start response: ${JSON.stringify(startRes)}`);

  // 5. Aguardar VM ligar (60s fixo antes de tentar guest agent)
  console.log(`Aguardando VM ${vmid} ligar...`);
  await new Promise(r => setTimeout(r, 60000));

  // 6. Aguardar guest agent
  await aguardarGuestAgent(vmid, 180000);

  // 7. Criar arquivo de configuração na VM
  console.log(`Configurando IP ${ipInfo.ip} para VM ${vmid}`);
  const vmconfigCmd = `Set-Content -Path 'C:\\WiikFX\\vmconfig.txt' -Value @('IP=${ipInfo.ip}', 'GATEWAY=${ipInfo.gateway}', 'NETMASK=${ipInfo.netmask}', 'SENHA=${senha}')`;
  await proxmoxRequest(`/nodes/${PROXMOX_NODE}/qemu/${vmid}/agent/exec`, 'POST', {
    command: 'powershell',
    'input-data': vmconfigCmd,
  });

  await new Promise(r => setTimeout(r, 3000));

  // 8. Executar script de setup
  await proxmoxRequest(`/nodes/${PROXMOX_NODE}/qemu/${vmid}/agent/exec`, 'POST', {
    command: 'powershell',
    'input-data': '-ExecutionPolicy Bypass -File C:\\WiikFX\\SetupVM.ps1',
  });

  await new Promise(r => setTimeout(r, 5000));
  await marcarIPUsado(ipInfo.id, vmid);
  return { ip: ipInfo.ip, usuario: 'Administrator', senha, porta: 3389, vmid };
}

// ── Helpers Proxmox ───────────────────────────────────
function proxmoxConfigurado() {
  return process.env.PROXMOX_HOST && process.env.PROXMOX_HOST !== 'https://ip_do_servidor:8006';
}

async function proxmoxRequest(endpoint, method = 'GET', body = null) {
  const url = `${process.env.PROXMOX_HOST}/api2/json${endpoint}`;
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `PVEAPIToken=${process.env.PROXMOX_USER}!${process.env.PROXMOX_TOKEN_ID}=${process.env.PROXMOX_TOKEN_SECRET}`,
  };
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : null });
  const text = await res.text();
  console.log(`Proxmox ${method} ${endpoint} status=${res.status} body=${text.slice(0, 300)}`);
  if (!text || text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    console.warn('Proxmox resposta nao-JSON:', text.slice(0, 200));
    return {};
  }
}

async function aguardarTaskProxmox(vmid, timeout = 180000) {
  console.log(`Aguardando VM ${vmid} ficar pronta (sem lock)...`);
  const inicio = Date.now();
  while (Date.now() - inicio < timeout) {
    await new Promise(r => setTimeout(r, 8000));
    try {
      const res = await proxmoxRequest(`/nodes/${PROXMOX_NODE}/qemu`);
      const vms = res.data || [];
      const vm = vms.find(v => v.vmid === vmid);
      if (vm) {
        if (!vm.lock) {
          console.log(`VM ${vmid} confirmada e sem lock — pronta!`);
          return true;
        }
        console.log(`VM ${vmid} existe mas com lock='${vm.lock}', aguardando...`);
      } else {
        console.log(`VM ${vmid} ainda nao apareceu, aguardando...`);
      }
    } catch (err) {
      console.warn(`Erro ao verificar VM ${vmid}: ${err.message} — continuando...`);
    }
  }
  console.warn(`VM ${vmid} nao ficou pronta em ${timeout}ms — continuando mesmo assim`);
  return false;
}

async function aguardarResizeCompleto(vmid, timeout = 60000) {
  console.log(`Aguardando resize VM ${vmid}...`);
  const inicio = Date.now();
  while (Date.now() - inicio < timeout) {
    await new Promise(r => setTimeout(r, 5000));
    try {
      const res = await proxmoxRequest(`/nodes/${PROXMOX_NODE}/qemu`);
      const vm = (res.data || []).find(v => v.vmid === vmid);
      if (vm && !vm.lock) {
        console.log(`Resize VM ${vmid} concluido!`);
        return true;
      }
    } catch {}
  }
  return true;
}

async function aguardarGuestAgent(vmid, timeout = 180000) {
  console.log(`Aguardando guest agent VM ${vmid}...`);
  const inicio = Date.now();
  while (Date.now() - inicio < timeout) {
    try {
      const r = await proxmoxRequest(`/nodes/${PROXMOX_NODE}/qemu/${vmid}/agent/ping`, 'POST');
      if (!r.errors) {
        console.log(`Guest agent VM ${vmid} respondeu!`);
        return true;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 5000));
  }
  throw new Error(`Guest agent nao respondeu em ${timeout}ms`);
}

// ── Email ─────────────────────────────────────────────
async function enviarEmailBoasVindas({ nome, email, plan, vmInfo }) {
  if (!resend) { console.warn('Resend nao configurado'); return; }
  await resend.emails.send({
    from: process.env.EMAIL_FROM || 'WiikFX <noreply@wiikfx.com>',
    to: email,
    subject: 'Sua VPS WiikFX esta pronta!',
    html: emailBase(`
      <h1 style="font-size:1.4rem;font-weight:800;margin-bottom:8px;">Sua VPS esta ativa, ${nome}!</h1>
      <p style="color:#888;margin-bottom:28px;">Plano <strong style="color:#5CBF8A">${plan.name}</strong> ativado.</p>
      <div style="background:#0d0d0d;border:1px solid rgba(92,191,138,0.2);border-radius:12px;padding:24px;margin-bottom:24px;">
        <table style="width:100%;border-collapse:collapse;">
          <tr><td style="color:#888;padding:8px 0;font-size:.9rem;">IP</td><td style="font-weight:700;color:#fff;text-align:right;">${vmInfo.ip}</td></tr>
          <tr style="border-top:1px solid #1a1a1a"><td style="color:#888;padding:8px 0;font-size:.9rem;">Usuario</td><td style="font-weight:700;color:#fff;text-align:right;">${vmInfo.usuario}</td></tr>
          <tr style="border-top:1px solid #1a1a1a"><td style="color:#888;padding:8px 0;font-size:.9rem;">Senha</td><td style="font-weight:700;color:#5CBF8A;text-align:right;">${vmInfo.senha}</td></tr>
          <tr style="border-top:1px solid #1a1a1a"><td style="color:#888;padding:8px 0;font-size:.9rem;">Porta RDP</td><td style="font-weight:700;color:#fff;text-align:right;">${vmInfo.porta}</td></tr>
        </table>
      </div>
      <div style="background:rgba(27,77,62,0.2);border:1px solid rgba(92,191,138,0.15);border-radius:10px;padding:16px;margin-bottom:24px;">
        <p style="font-size:.85rem;color:#aaa;margin:0;line-height:1.6;"><strong style="color:#5CBF8A">Como conectar:</strong> Abra "Conexao de Area de Trabalho Remota", digite o IP e faca login com as credenciais acima.</p>
      </div>
      <div style="background:rgba(27,77,62,0.15);border:1px solid rgba(92,191,138,0.1);border-radius:10px;padding:16px;margin-bottom:24px;text-align:center;">
        <p style="font-size:.9rem;color:#aaa;margin:0 0 12px;">Acesse sua area de cliente para ver detalhes da sua VPS, reiniciar o servidor e gerenciar sua conta.</p>
        <a href="${BASE_URL}/portal" style="display:inline-block;background:#5CBF8A;color:#050505;padding:12px 28px;border-radius:10px;font-weight:700;text-decoration:none;font-size:.9rem;">Acessar minha area de cliente</a>
      </div>
      <p style="color:#555;font-size:.8rem;text-align:center;">Suporte: <a href="https://t.me/WiikFX" style="color:#5CBF8A;">t.me/WiikFX</a></p>
    `),
  });
}

function emailBase(content) {
  return `<div style="font-family:Arial,sans-serif;background:#050505;color:#fff;padding:40px;max-width:560px;margin:0 auto;border-radius:16px;"><div style="text-align:center;margin-bottom:32px;"><span style="font-size:2rem;font-weight:900;"><span style="color:#1B4D3E">Wiik</span><span style="color:#5CBF8A">FX</span></span></div>${content}</div>`;
}

// ── Utilitários ───────────────────────────────────────
function gerarSenha() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789@#!';
  return Array.from({ length: 14 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function parseCookie(cookieStr = '') {
  try {
    return Object.fromEntries(cookieStr.split(';').map(c => c.trim().split('=').map(decodeURIComponent)));
  } catch { return {}; }
}


app.get('/api/test-proxmox', async (req, res) => {
  const url = `${process.env.PROXMOX_HOST}/api2/json/nodes`;
  const token = `PVEAPIToken=${process.env.PROXMOX_USER}!${process.env.PROXMOX_TOKEN_ID}=${process.env.PROXMOX_TOKEN_SECRET}`;
  res.json({
    url,
    token_preview: token.slice(0, 60) + '...',
    proxmox_host: process.env.PROXMOX_HOST,
    proxmox_user: process.env.PROXMOX_USER,
    token_id: process.env.PROXMOX_TOKEN_ID,
    token_secret_preview: process.env.PROXMOX_TOKEN_SECRET?.slice(0, 8) + '...',
  });
});

// ── Fallback ──────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Start ─────────────────────────────────────────────
app.listen(PORT, () => console.log(`WiikFX rodando na porta ${PORT}`));
initDB().catch(err => console.error('Aviso banco:', err.message));
