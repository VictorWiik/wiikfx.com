const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// Cria as tabelas se não existirem
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clientes (
      id SERIAL PRIMARY KEY,
      nome VARCHAR(255) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      whatsapp VARCHAR(20),
      criado_em TIMESTAMP DEFAULT NOW()
    );

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
      preapproval_id VARCHAR(100),
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
  `);
  console.log('Banco de dados inicializado');
}

// Upsert cliente (cria ou atualiza)
async function upsertCliente({ nome, email, whatsapp }) {
  const res = await pool.query(`
    INSERT INTO clientes (nome, email, whatsapp)
    VALUES ($1, $2, $3)
    ON CONFLICT (email) DO UPDATE SET nome = $1, whatsapp = $3
    RETURNING *
  `, [nome, email, whatsapp]);
  return res.rows[0];
}

// Criar VM no banco
async function criarVMBanco({ clienteId, plano, tipoCobranca, vmid, ip, senha, preapprovalId }) {
  const expira = new Date();
  expira.setMonth(expira.getMonth() + 1);
  const res = await pool.query(`
    INSERT INTO vms (cliente_id, plano, tipo_cobranca, status, vmid, ip, senha, preapproval_id, expira_em)
    VALUES ($1, $2, $3, 'ativa', $4, $5, $6, $7, $8)
    RETURNING *
  `, [clienteId, plano, tipoCobranca, vmid || null, ip, senha, preapprovalId || null, expira]);
  return res.rows[0];
}

// Registrar pagamento
async function registrarPagamento({ vmId, clienteId, mpPaymentId, mpPreapprovalId, tipo, status, valor }) {
  const res = await pool.query(`
    INSERT INTO pagamentos (vm_id, cliente_id, mp_payment_id, mp_preapproval_id, tipo, status, valor)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *
  `, [vmId, clienteId, mpPaymentId || null, mpPreapprovalId || null, tipo, status, valor]);
  return res.rows[0];
}

// Buscar VMs de um cliente pelo email
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

// Buscar todos os clientes (admin)
async function getAllClientes() {
  const res = await pool.query(`
    SELECT c.*, COUNT(v.id) as total_vms
    FROM clientes c
    LEFT JOIN vms v ON v.cliente_id = c.id
    GROUP BY c.id
    ORDER BY c.criado_em DESC
  `);
  return res.rows;
}

// Buscar todas as VMs (admin)
async function getAllVMs() {
  const res = await pool.query(`
    SELECT v.*, c.nome, c.email, c.whatsapp
    FROM vms v
    JOIN clientes c ON c.id = v.cliente_id
    ORDER BY v.criado_em DESC
  `);
  return res.rows;
}

module.exports = { pool, initDB, upsertCliente, criarVMBanco, registrarPagamento, getVMsByEmail, getAllClientes, getAllVMs };
