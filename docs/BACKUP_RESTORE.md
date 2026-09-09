# Backup e Restore do Banco de Dados

**Última atualização:** 2026-09-09
**Escopo:** schema `financas` do projeto Supabase de produção

---

## Sumário

1. [Como funciona](#como-funciona)
2. [Configuração inicial (uma vez)](#configuração-inicial-uma-vez)
3. [Onde ficam os backups](#onde-ficam-os-backups)
4. [Restaurar um backup](#restaurar-um-backup)
5. [Teste trimestral de restore](#teste-trimestral-de-restore)
6. [O que este backup NÃO cobre](#o-que-este-backup-não-cobre)

---

## Como funciona

O workflow `.github/workflows/backup-banco.yml` roda **todo dia às 03:00 (horário de Brasília)** e também pode ser disparado manualmente pela aba *Actions* → *Backup do banco (schema financas)* → *Run workflow*.

A cada execução ele:

1. conecta no projeto Supabase de produção usando os segredos já existentes no repositório;
2. gera dois dumps do schema `financas` — **estrutura** (tabelas, índices, triggers, políticas de RLS) e **dados** (comandos `INSERT`, um por linha, com os nomes das colunas explícitos);
3. confere que os dumps não estão vazios e que as tabelas centrais do sistema aparecem na estrutura — **se a conferência falhar, nada é publicado**;
4. compacta os dois arquivos e **criptografa com AES256** (GPG, senha simétrica);
5. publica o arquivo como *release* do repositório, com a tag `backup-AAAA-MM-DD`;
6. aplica a rotação de retenção;
7. em caso de falha, abre uma issue com o rótulo `backup-falhou` (ou comenta na que já estiver aberta).

### Por que *release* e não commit

Os backups são anexos de release, não arquivos versionados. Isso evita que o histórico do Git cresça indefinidamente (um anexo apagado libera o espaço de verdade; um arquivo commitado fica no histórico para sempre) e evita que o repositório dispare um deploy do Vercel a cada backup.

### Retenção

Aplicada por `.github/scripts/rotacionar-backups.py`:

| Faixa | O que fica guardado |
|-------|---------------------|
| Últimos 30 dias | **todos** os backups diários |
| Até 180 dias | os de **segunda-feira** |
| Até 730 dias (2 anos) | os do **dia 1º de cada mês** |
| Sempre | os **7 mais recentes**, independentemente da data |

Em regime, isso mantém em torno de 75 arquivos. Por segurança, o script se recusa a apagar qualquer coisa se a política resultar em nenhum backup mantido.

---

## Configuração inicial (uma vez)

Os segredos abaixo ficam em *Settings → Secrets and variables → Actions*. Os três primeiros já existiam para o workflow de migrations:

| Segredo | Para que serve |
|---------|----------------|
| `SUPABASE_ACCESS_TOKEN` | autenticação da CLI da Supabase |
| `SUPABASE_DB_PASSWORD` | senha do banco de produção |
| `SUPABASE_PROJECT_REF` | identificador do projeto Supabase |
| `BACKUP_GPG_PASSPHRASE` | **novo** — senha que criptografa os backups |

> ⚠️ **A senha do GPG precisa estar guardada fora do GitHub.** Se ela se perder, os backups viram arquivos ilegíveis — não existe recuperação. Guarde no gerenciador de senhas da GF2, junto com a senha do banco.

---

## Onde ficam os backups

Na aba **Releases** do repositório, tags `backup-AAAA-MM-DD`, arquivo `financas-AAAA-MM-DD.tar.gz.gpg`.

Para baixar pelo terminal (requer a CLI `gh` autenticada):

```bash
gh release download backup-2026-09-09 \
  --repo EquipeGF2/Germani_Financeiro \
  --pattern '*.gpg'
```

Ou pela interface do GitHub, clicando no arquivo dentro da release.

---

## Restaurar um backup

### Passo 1 — Descriptografar e abrir

```bash
gpg --decrypt --output financas.tar.gz financas-2026-09-09.tar.gz.gpg
# a senha pedida é a do segredo BACKUP_GPG_PASSPHRASE

tar -xzf financas.tar.gz
# gera: estrutura.sql e dados.sql
```

### Passo 2 — Escolher o destino

**Nunca restaure direto em produção sem antes validar num projeto de teste.** Um restore por cima de dados existentes vai esbarrar em chaves duplicadas e pode deixar o banco em estado misto.

- **Projeto de teste (recomendado, e o caminho do teste trimestral):** crie um projeto novo na Supabase e restaure nele.
- **Produção, em desastre real:** só depois de confirmar que o dump está íntegro no projeto de teste.

A string de conexão está em *Supabase → Project Settings → Database → Connection string* (formato `postgresql://postgres:SENHA@HOST:5432/postgres`).

### Passo 3 — Restaurar

```bash
export DB_URL='postgresql://postgres:SENHA@HOST:5432/postgres'

psql "$DB_URL" -v ON_ERROR_STOP=1 -f estrutura.sql
psql "$DB_URL" -v ON_ERROR_STOP=1 -f dados.sql
```

O dump de dados já traz os `setval` das sequences, então os `serial` continuam de onde pararam — sem risco de colisão de ID nos próximos lançamentos.

### Passo 4 — Se o destino já tiver dados

Limpe as tabelas antes do `dados.sql` (as chaves estrangeiras exigem `CASCADE`):

```sql
-- CUIDADO: apaga todo o conteúdo do schema financas no banco conectado
DO $$
DECLARE tabela record;
BEGIN
  FOR tabela IN
    SELECT tablename FROM pg_tables WHERE schemaname = 'financas'
  LOOP
    EXECUTE format('TRUNCATE TABLE financas.%I CASCADE', tabela.tablename);
  END LOOP;
END $$;
```

### Passo 5 — Conferir

```sql
SELECT 'areas', count(*) FROM financas.are_areas
UNION ALL SELECT 'previsao', count(*) FROM financas.pvi_previsao_itens
UNION ALL SELECT 'saldos', count(*) FROM financas.sdb_saldo_banco
UNION ALL SELECT 'pagamentos', count(*) FROM financas.pag_pagamentos_area;
```

---

## Teste trimestral de restore

Backup que nunca foi restaurado não é backup — é um arquivo que se supõe bom. A cada trimestre, com o último backup disponível:

- [ ] Baixar o backup mais recente e descriptografar
- [ ] Criar um projeto Supabase temporário
- [ ] Rodar `estrutura.sql` e `dados.sql` sem erro
- [ ] Conferir as contagens do Passo 5 contra a produção
- [ ] Rodar o front apontando para o projeto de teste (`NEXT_PUBLIC_SUPABASE_URL` e `NEXT_PUBLIC_SUPABASE_ANON_KEY` locais) e abrir o relatório de Previsão Semanal de uma semana conhecida
- [ ] Apagar o projeto temporário
- [ ] Registrar a data do teste aqui embaixo

| Data do teste | Backup usado | Resultado | Quem testou |
|---------------|--------------|-----------|-------------|
| _(preencher no primeiro teste)_ | | | |

---

## O que este backup NÃO cobre

| Item | Onde está protegido |
|------|---------------------|
| Estrutura do banco (tabelas, RLS, triggers) | Também versionada em `supabase/migrations/` — o dump é redundância |
| Outros schemas (`auth`, `storage`, `public`) | **Não coberto.** O sistema não usa autenticação da Supabase nem storage; se isso mudar, o dump precisa ser ampliado |
| Código da aplicação | Repositório Git + histórico do GitHub |
| Variáveis de ambiente do Vercel | **Não coberto.** Anote-as no gerenciador de senhas |
| Recuperação a um ponto no tempo (PITR) | Depende do plano da Supabase — o backup diário daqui cobre a granularidade de 1 dia |

---

**Mantido por:** EquipeGF2
