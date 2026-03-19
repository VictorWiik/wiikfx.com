const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clientes (
      id SERIAL PRIMARY KEY,
      nome VARCHAR(255) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      whatsapp VARCHAR(20),
      senha_hash VARCHAR(255),
      criado_em TIMESTAMP DEFAULT NOW()
    );

    ALTER TABLE clientes ADD COLUMN IF NOT EXISTS senha_hash VARCHAR(255);

    CREATE TABLE IF NOT EXISTS vms (
      id SERIAL PRIMARY KEY,
      cliente_id INTEGER REFERENCES clientes(id),
      plano VARCHAR(20) NOT NULL,
      tipo_cobranca VARCHAR(20) NOT NULL,
      status VARCHAR(20) DEFAULT 'pendente',
      vmid INTEGER,
      ip VARCHAR(50),
      usuario VARCHAR(100) DEFAULT 'Administrator',
      senha VARCHAR(100),
      porta INTEGER DEFAULT 3389,
      proxmox_node VARCHAR(50) DEFAULT 'pve',
      criado_em TIMESTAMP DEFAULT NOW(),
      expira_em TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS pagamentos (
      id SERIAL PRIMARY KEY,
      vm_id INTEGER REFERENCES vms(id),
      cliente_id INTEGER REFERENCES clientes(id),
      mp_payment_id VARCHAR(100),
      mp_preapproval_id VARCHAR(100),
      tipo VARCHAR(20),
      status VARCHAR(20),
      valor NUMERIC(10,2),
      criado_em TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS tokens_acesso (
      id SERIAL PRIMARY KEY,
      cliente_id INTEGER REFERENCES clientes(id),
      token VARCHAR(128) UNIQUE NOT NULL,
      usado BOOLEAN DEFAULT FALSE,
      expira_em TIMESTAMP NOT NULL,
      criado_em TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS sessoes (
      id SERIAL PRIMARY KEY,
      cliente_id INTEGER REFERENCES clientes(id),
      session_token VARCHAR(128) UNIQUE NOT NULL,
      expira_em TIMESTAMP NOT NULL,
      criado_em TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ip_pool (
      id SERIAL PRIMARY KEY,
      ip VARCHAR(20) UNIQUE NOT NULL,
      gateway VARCHAR(20) NOT NULL,
      netmask VARCHAR(20) NOT NULL,
      em_uso BOOLEAN DEFAULT FALSE,
      vmid INTEGER,
      criado_em TIMESTAMP DEFAULT NOW()
    );

    INSERT INTO ip_pool (ip, gateway, netmask) VALUES
      ('212.47.64.212', '212.47.64.1', '255.255.248.0'),
      ('212.47.64.213', '212.47.64.1', '255.255.248.0'),
      ('212.47.64.214', '212.47.64.1', '255.255.248.0'),
      ('212.47.64.215', '212.47.64.1', '255.255.248.0'),
      ('212.47.64.216', '212.47.64.1', '255.255.248.0'),
      ('212.47.64.217', '212.47.64.1', '255.255.248.0'),
      ('212.47.64.218', '212.47.64.1', '255.255.248.0')
    ON CONFLICT (ip) DO NOTHING;

    UPDATE ip_pool SET em_uso = TRUE WHERE ip IN ('212.47.64.212', '212.47.64.213');
  `);
  console.log('Banco de dados inicializado');
}

async function upsertCliente({ nome, email, whatsapp }) {
  const res = await pool.query(`
    INSERT INTO clientes (nome, email, whatsapp)
    VALUES ($1, $2, $3)
    ON CONFLICT (email) DO UPDATE SET nome = $1, whatsapp = $3
    RETURNING *
  `, [nome, email, whatsapp]);
  return res.rows[0];
}

async function getClienteByEmail(email) {
  const res = await pool.query('SELECT * FROM clientes WHERE email = $1', [email]);
  return res.rows[0] || null;
}

async function getClienteComSenha(email) {
  const res = await pool.query('SELECT * FROM clientes WHERE email = $1', [email]);
  return res.rows[0] || null;
}

async function criarTokenAcesso(clienteId) {
  const crypto = require('crypto');
  const token = crypto.randomBytes(48).toString('hex');
  const expira = new Date(Date.now() + 15 * 60 * 1000);
  await pool.query(`
    INSERT INTO tokens_acesso (cliente_id, token, expira_em)
    VALUES ($1, $2, $3)
  `, [clienteId, token, expira]);
  return token;
}

async function validarTokenAcesso(token) {
  const res = await pool.query(`
    SELECT t.*, c.* FROM tokens_acesso t
    JOIN clientes c ON c.id = t.cliente_id
    WHERE t.token = $1 AND t.usado = FALSE AND t.expira_em > NOW()
  `, [token]);
  if (!res.rows[0]) return null;
  await pool.query('UPDATE tokens_acesso SET usado = TRUE WHERE token = $1', [token]);
  return res.rows[0];
}

async function criarTokenSenha(clienteId) {
  const crypto = require('crypto');
  const token = crypto.randomBytes(48).toString('hex');
  const expira = new Date(Date.now() + 30 * 60 * 1000);
  await pool.query(`
    INSERT INTO tokens_acesso (cliente_id, token, expira_em)
    VALUES ($1, $2, $3)
  `, [clienteId, token, expira]);
  return token;
}

async function definirSenha(clienteId, senhaHash) {
  await pool.query('UPDATE clientes SET senha_hash = $1 WHERE id = $2', [senhaHash, clienteId]);
}

async function criarSessao(clienteId) {
  const crypto = require('crypto');
  const sessionToken = crypto.randomBytes(48).toString('hex');
  const expira = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await pool.query(`
    INSERT INTO sessoes (cliente_id, session_token, expira_em)
    VALUES ($1, $2, $3)
  `, [clienteId, sessionToken, expira]);
  return sessionToken;
}

async function validarSessao(sessionToken) {
  if (!sessionToken) return null;
  const res = await pool.query(`
    SELECT s.*, c.id as cliente_id, c.nome, c.email, c.whatsapp
    FROM sessoes s
    JOIN clientes c ON c.id = s.cliente_id
    WHERE s.session_token = $1 AND s.expira_em > NOW()
  `, [sessionToken]);
  return res.rows[0] || null;
}

async function encerrarSessao(sessionToken) {
  await pool.query('DELETE FROM sessoes WHERE session_token = $1', [sessionToken]);
}

async function criarVMBanco({ clienteId, plano, tipoCobranca, vmid, ip, senha, meses = 1 }) {
  const expira = new Date();
  expira.setMonth(expira.getMonth() + meses);
  const res = await pool.query(`
    INSERT INTO vms (cliente_id, plano, tipo_cobranca, status, vmid, ip, senha, expira_em)
    VALUES ($1, $2, $3, 'ativa', $4, $5, $6, $7)
    RETURNING *
  `, [clienteId, plano, tipoCobranca, vmid || null, ip, senha, expira]);
  return res.rows[0];
}

async function registrarPagamento({ vmId, clienteId, mpPaymentId, mpPreapprovalId, tipo, status, valor }) {
  const res = await pool.query(`
    INSERT INTO pagamentos (vm_id, cliente_id, mp_payment_id, mp_preapproval_id, tipo, status, valor)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *
  `, [vmId, clienteId, mpPaymentId || null, mpPreapprovalId || null, tipo, status, valor]);
  return res.rows[0];
}

async function getVMsByEmail(email) {
  const res = await pool.query(`
    SELECT v.*, c.nome, c.email
    FROM vms v
    JOIN clientes c ON c.id = v.cliente_id
    WHERE c.email = $1
    ORDER BY v.criado_em DESC
  `, [email]);
  return res.rows;
}

async function getPagamentosByClienteId(clienteId) {
  const res = await pool.query(`
    SELECT p.*, v.plano FROM pagamentos p
    LEFT JOIN vms v ON v.id = p.vm_id
    WHERE p.cliente_id = $1
    ORDER BY p.criado_em DESC
  `, [clienteId]);
  return res.rows;
}

async function getIPDisponivel() {
  const res = await pool.query('SELECT * FROM ip_pool WHERE em_uso = FALSE ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED');
  return res.rows[0] || null;
}

async function marcarIPUsado(ipId, vmid) {
  await pool.query('UPDATE ip_pool SET em_uso = TRUE, vmid = $1 WHERE id = $2', [vmid, ipId]);
}

async function liberarIP(vmid) {
  await pool.query('UPDATE ip_pool SET em_uso = FALSE, vmid = NULL WHERE vmid = $1', [vmid]);
}

async function getAllClientes() {
  const res = await pool.query(`
    SELECT c.*, COUNT(v.id) as total_vms
    FROM clientes c
    LEFT JOIN vms v ON v.cliente_id = c.id
    GROUP BY c.id ORDER BY c.criado_em DESC
  `);
  return res.rows;
}

async function getAllVMs() {
  const res = await pool.query(`
    SELECT v.*, c.nome, c.email, c.whatsapp
    FROM vms v JOIN clientes c ON c.id = v.cliente_id
    ORDER BY v.criado_em DESC
  `);
  return res.rows;
}

module.exports = {
  pool, initDB,
  upsertCliente, getClienteByEmail, getClienteComSenha,
  criarTokenAcesso, validarTokenAcesso,
  criarTokenSenha, definirSenha,
  criarSessao, validarSessao, encerrarSessao,
  criarVMBanco, registrarPagamento,
  getVMsByEmail, getPagamentosByClienteId,
  getAllClientes, getAllVMs,
  getIPDisponivel, marcarIPUsado, liberarIP,
};
