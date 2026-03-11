# Fix Futuro: Relatório ignora sdd_saldo_inicial corrigido manualmente

**Status:** Pendente (registrado para implementação futura)
**Data:** 2026-03-11

---

## Problema

Ao corrigir `sdd_saldo_inicial` diretamente na tabela `sdd_saldo_diario` para um dia específico, o relatório de saldo diário (`/relatorios/saldo-diario`) continua mostrando o valor antigo.

## Causa raiz

A lógica de prioridade no relatório (`Front_Web/app/relatorios/saldo-diario/page.tsx`, linhas ~644-648) **sempre** prefere o `sdd_saldo_final` do dia anterior sobre o `sdd_saldo_inicial` do dia atual:

```typescript
// ATUAL - saldo_inicial registrado nunca é usado quando existe dia anterior
const saldoInicialRealizado = arredondar(
  saldoFinalAnterior ??                // PRIORIDADE 1 ← sempre ganha
  saldoInicialAtualRegistrado ??       // PRIORIDADE 2 ← nunca chega aqui
  primeiroSaldoInicialRegistrado ??
  saldoInicialPrevisto,
);
```

Se existir um registro em `sdd_saldo_diario` para o dia anterior, o relatório usa `sdd_saldo_final` desse dia como saldo inicial, **ignorando completamente** o `sdd_saldo_inicial` que foi corrigido manualmente.

A mesma lógica existe na função `registrarSaldoDiario` (linhas ~360-363) — ao salvar o snapshot, ela sobrescreve o `sdd_saldo_inicial` corrigido com o `sdd_saldo_final` do dia anterior.

## Solução proposta

### Alteração 1: Lógica de exibição (linha ~644-648)

Inverter a prioridade para que o valor explicitamente registrado tenha precedência:

```typescript
// CORRIGIDO - respeitar saldo_inicial quando explicitamente registrado
const saldoInicialRealizado = arredondar(
  saldoInicialAtualRegistrado ??       // PRIORIDADE 1: valor explícito do dia
  saldoFinalAnterior ??                // PRIORIDADE 2: cadeia automática
  primeiroSaldoInicialRegistrado ??
  saldoInicialPrevisto,
);
```

### Alteração 2: Lógica de salvamento (linhas ~360-363)

Na função `registrarSaldoDiario`, preservar o valor existente quando já registrado:

```typescript
const saldoInicialDia =
  registroExistente?.sdd_saldo_inicial ??    // PRIORIDADE 1: valor já registrado
  (registroAnterior?.sdd_saldo_final !== undefined && registroAnterior?.sdd_saldo_final !== null
    ? Number(registroAnterior.sdd_saldo_final)
    : resumo.saldoInicialRealizado);
```

## Arquivo a modificar

- `Front_Web/app/relatorios/saldo-diario/page.tsx`
  - Linha ~644-648: inverter prioridade do saldo inicial
  - Linhas ~360-363: preservar saldo inicial existente ao salvar

## Verificação

1. Verificar que existe um registro em `sdd_saldo_diario` com `sdd_saldo_inicial` corrigido
2. Abrir o relatório de saldo diário para essa data
3. Confirmar que o "Saldo Inicial Realizado" mostra o valor corrigido
4. Confirmar que o "Saldo Final Realizado" é recalculado corretamente a partir do saldo inicial corrigido

## Workaround atual

Para corrigir o saldo inicial de um dia D no relatório:
1. Alterar o `sdd_saldo_final` do dia **D-1** (dia anterior) em `sdd_saldo_diario` para o valor desejado como saldo inicial de D
2. O relatório do dia D usará esse valor como saldo inicial (pois `saldoFinalAnterior` é prioridade 1)
