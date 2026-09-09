# Financeiro - teste

Sistema de gestão financeira com controle de pagamentos, receitas e saldos bancários.

## 🚀 Stack Tecnológica

- **Frontend:** Next.js 14.2.4 (App Router) + TypeScript
- **Backend:** Supabase (PostgreSQL)
- **Deploy:** Vercel
- **CI/CD:** GitHub Actions

## 📋 Funcionalidades

### Módulos de Cadastro
- **Áreas:** Cadastro de áreas de negócio
- **Contas de Receita:** Cadastro de contas para receitas
- **Bancos:** Cadastro de bancos e contas bancárias

### Módulos Operacionais
- **Saldo Diário:** Tela principal com 4 blocos:
  - Pagamentos diários por área
  - Receitas por conta
  - Pagamentos por banco
  - Saldo por banco

### Recursos Especiais
- ✅ Registro de usuário sem login (identificação por sessão)
- ✅ Calculadora integrada nos campos de valores (aceita `+`, `-`, `*`, `/`)
- ✅ Interface moderna em vermelho e branco
- ✅ Auditoria automática (quem, quando)

## 🏗️ Arquitetura

```
┌─────────────────┐
│    SUPABASE     │  ← PostgreSQL (schema: financas)
│  (PostgreSQL)   │     - Tabelas de cadastro
└────────┬────────┘     - Tabelas de movimentação
         │              - Auditoria automática
         ↓
┌─────────────────┐
│     GITHUB      │  ← CI/CD automático
│   Actions       │     - Migrations
└────────┬────────┘     - Type generation
         │
         ↓
┌─────────────────┐
│     VERCEL      │  ← Deploy automático
│  Next.js App    │     https://financeiro-germani.vercel.app
└─────────────────┘
```

## 📚 Documentação

- [Arquitetura do Sistema](./docs/ARQUITETURA.md)
- [Banco de Dados](./docs/BANCO_DE_DADOS.md)
- [Frontend](./docs/FRONTEND.md)
- [Setup e Instalação](./docs/SETUP.md)
- [Backup e Restore do Banco](./docs/BACKUP_RESTORE.md)

## ⚡ Quick Start

```bash
# 1. Clone o repositório
git clone https://github.com/EquipeGF2/Financeiro.git
cd Financeiro

# 2. Configure as variáveis de ambiente
cp docs/.env.example Front_Web/.env.local
# Edite Front_Web/.env.local com suas credenciais do Supabase

# 3. Instale as dependências
cd Front_Web
npm install

# 4. Rode o servidor de desenvolvimento
npm run dev
```

Acesse http://localhost:3000

## 🗄️ Banco de Dados

O sistema utiliza PostgreSQL via Supabase com schema `financas`. As migrations estão em `supabase/migrations/`.

### Principais Tabelas:
- `usr_usuarios` - Usuários sem login (sessão)
- `are_areas` - Áreas de negócio
- `ctr_contas_receita` - Contas de receita
- `ban_bancos` - Bancos e contas
- `pag_pagamentos_area` - Pagamentos por área
- `rec_receitas` - Receitas
- `pbk_pagamentos_banco` - Pagamentos por banco
- `sdb_saldo_banco` - Saldos bancários

## 🎨 Design

Interface moderna com as cores da empresa:
- **Primária:** Vermelho (#DC2626, #EF4444)
- **Secundária:** Branco (#FFFFFF)
- **Acentos:** Tons de cinza

## 🔐 Segurança

- Row Level Security (RLS) habilitado em todas as tabelas
- Políticas de acesso por usuário de sessão
- Auditoria automática de criação e modificação

## 🚀 Deploy

O deploy é automático via Vercel quando há push na branch `main`.

**URL de Produção:** https://financeiro-germani.vercel.app

## 🔧 Ajustes recentes

- Correção da liberação de períodos de cobrança, respeitando datas liberadas além do intervalo padrão.
- Centralização do cliente Supabase no frontend para evitar múltiplas instâncias do GoTrue no navegador.
- Persistência automática do saldo diário consolidado na tabela `sdd_saldo_diario`, garantindo trilha de auditoria.
- Função de backfill para preencher o saldo diário retroativo (inclusive períodos fechados) a partir dos saldos bancários
  consolidados.

## 📝 License

Private - EquipeGF2
