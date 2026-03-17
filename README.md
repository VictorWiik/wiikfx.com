# WiikFX Platform v2

**Forex VPS — Plataforma de VPS para traders**

## Estrutura

```
├── public/
│   ├── index.html      # Landing page (em breve)
│   └── vps.html        # Página de planos VPS
├── server.js           # Servidor Express + webhook MP
├── package.json        # Dependências
├── railway.toml        # Configuração Railway
├── .env.example        # Variáveis de ambiente (modelo)
└── README.md
```

## Rotas

| Rota | Descrição |
|------|-----------|
| `GET /` | Landing page |
| `GET /vps` | Página de planos |
| `POST /api/webhook/mercadopago` | Webhook de pagamento |

## Variáveis de Ambiente (Railway)

Copie `.env.example` e configure no painel do Railway:

- `MP_PUBLIC_KEY` — Mercado Pago public key
- `MP_ACCESS_TOKEN` — Mercado Pago access token
- `RESEND_API_KEY` — Chave da API Resend
- `PROXMOX_HOST` — URL do Proxmox
- `PROXMOX_USER` — Usuário Proxmox
- `PROXMOX_TOKEN_ID` — Token ID Proxmox
- `PROXMOX_TOKEN_SECRET` — Token Secret Proxmox

## Desenvolvimento Local

```bash
npm install
cp .env.example .env   # preencha as variáveis
npm start
```

Acesse: http://localhost:3000

---

**WiikFX — Forex Precision**
📱 t.me/WiikFX | 📧 contato@wiikfx.com
