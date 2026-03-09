/**
 * recalcularSaldoDiario
 *
 * Recalcula automaticamente os registros de sdd_saldo_diario a partir de uma
 * data específica, propagando o saldo final do dia anterior como saldo inicial
 * do dia seguinte. Isso garante que ajustes retroativos reflitam nos relatórios
 * sem necessidade de reprocessamento manual.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

const arredondar = (valor: number): number => Math.round(valor * 100) / 100;

type MaybeArray<T> = T | T[] | null | undefined;

const normalizarRelacao = <T,>(valor: MaybeArray<T>): Exclude<T, null | undefined>[] => {
  if (!valor) return [];
  const arr = Array.isArray(valor) ? valor : [valor];
  return arr.filter((item): item is Exclude<T, null | undefined> => item != null);
};

/**
 * Calcula receitas, despesas e aplicações de um dia específico.
 */
async function calcularMovimentoDoDia(
  supabase: SupabaseClient,
  data: string,
): Promise<{ totalReceitas: number; totalDespesas: number; aplicacoes: number }> {
  const [receitasRes, pagamentosRes] = await Promise.all([
    supabase
      .from('rec_receitas')
      .select('rec_id, rec_valor, ctr_contas_receita(ctr_nome)')
      .eq('rec_data', data),
    supabase
      .from('pag_pagamentos_area')
      .select('pag_valor, pag_are_id, are_areas(are_nome)')
      .eq('pag_data', data),
  ]);

  if (receitasRes.error) throw receitasRes.error;
  if (pagamentosRes.error) throw pagamentosRes.error;

  // Deduplicate receitas by rec_id
  const receitasUnicas = new Map<number, any>();
  normalizarRelacao(receitasRes.data).forEach((item: any) => {
    const recId = item?.rec_id;
    if (recId && !receitasUnicas.has(recId)) {
      receitasUnicas.set(recId, item);
    } else if (!recId) {
      receitasUnicas.set(Math.random(), item);
    }
  });

  let totalReceitas = 0;
  receitasUnicas.forEach((item) => {
    totalReceitas += arredondar(Number(item.rec_valor ?? 0));
  });

  let totalDespesas = 0;
  let aplicacoes = 0;

  normalizarRelacao(pagamentosRes.data).forEach((item: any) => {
    const titulo = normalizarRelacao(item.are_areas)[0]?.are_nome ?? '';
    const tituloNormalizado = String(titulo).trim().toUpperCase();
    const valor = arredondar(Number(item.pag_valor ?? 0));

    const ehAplicacao =
      tituloNormalizado.includes('APLICACAO') || tituloNormalizado.includes('APLICAÇÃO');
    const ehResgate = tituloNormalizado.includes('RESGATE');
    const ehTransferencia =
      tituloNormalizado.includes('TRANSFERENCIA') || tituloNormalizado.includes('TRANSFERÊNCIA');

    if (ehAplicacao) {
      if (ehResgate) {
        aplicacoes += valor;
      } else if (ehTransferencia) {
        aplicacoes -= valor;
      } else {
        aplicacoes -= valor;
      }
    } else {
      totalDespesas += valor;
    }
  });

  return {
    totalReceitas: arredondar(totalReceitas),
    totalDespesas: arredondar(totalDespesas),
    aplicacoes: arredondar(aplicacoes),
  };
}

/**
 * Gera lista de datas ISO entre início e fim (inclusive).
 */
function gerarIntervaloDatas(inicio: string, fim: string): string[] {
  const datas: string[] = [];
  const inicioDate = new Date(`${inicio}T00:00:00`);
  const fimDate = new Date(`${fim}T00:00:00`);
  const cursor = new Date(inicioDate);
  while (cursor <= fimDate) {
    datas.push(cursor.toISOString().split('T')[0]);
    cursor.setDate(cursor.getDate() + 1);
  }
  return datas;
}

/**
 * Recalcula e persiste os registros de sdd_saldo_diario a partir de
 * `dataInicio` até `dataFim` (padrão: hoje).
 *
 * Fluxo:
 * 1. Busca o saldo final do dia anterior a `dataInicio` para usar como ponto de partida.
 * 2. Para cada dia no intervalo, calcula o movimento (receitas - despesas + aplicações).
 * 3. Upsert em sdd_saldo_diario preservando o saldo_inicial encadeado.
 *
 * @returns Quantidade de dias processados.
 */
export async function recalcularSaldoDiario(
  supabase: SupabaseClient,
  usrId: string,
  dataInicio: string,
  dataFim?: string,
): Promise<number> {
  const hoje = new Date().toISOString().split('T')[0];
  const fim = dataFim ?? hoje;
  const datas = gerarIntervaloDatas(dataInicio, fim);

  if (datas.length === 0) return 0;

  // Buscar saldo final do dia anterior ao início (ponto de partida da cadeia)
  const { data: saldoAnteriorRes, error: errAnterior } = await supabase
    .from('sdd_saldo_diario')
    .select('sdd_saldo_final')
    .lt('sdd_data', datas[0])
    .order('sdd_data', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (errAnterior) throw errAnterior;

  // Buscar primeiro registro existente para preservar saldo_inicial original
  const { data: primeiroRegistro, error: errPrimeiro } = await supabase
    .from('sdd_saldo_diario')
    .select('sdd_data, sdd_saldo_inicial')
    .order('sdd_data', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (errPrimeiro) throw errPrimeiro;

  let saldoAnterior: number | null =
    saldoAnteriorRes?.sdd_saldo_final != null
      ? Number(saldoAnteriorRes.sdd_saldo_final)
      : null;

  let diasProcessados = 0;

  for (const data of datas) {
    const { totalReceitas, totalDespesas, aplicacoes } = await calcularMovimentoDoDia(
      supabase,
      data,
    );

    // Buscar registro existente para esta data
    const { data: registroAtual, error: errAtual } = await supabase
      .from('sdd_saldo_diario')
      .select('sdd_id, sdd_criado_em, sdd_saldo_inicial')
      .eq('sdd_data', data)
      .maybeSingle();

    if (errAtual) throw errAtual;

    const saldoInicialDia = arredondar(
      saldoAnterior !== null
        ? saldoAnterior
        : data === primeiroRegistro?.sdd_data
          ? Number(primeiroRegistro?.sdd_saldo_inicial ?? 0)
          : Number(registroAtual?.sdd_saldo_inicial ?? 0),
    );

    const saldoFinalDia = arredondar(saldoInicialDia + totalReceitas - totalDespesas + aplicacoes);

    const { error: errUpsert } = await supabase.from('sdd_saldo_diario').upsert(
      {
        sdd_data: data,
        sdd_saldo_inicial: saldoInicialDia,
        sdd_saldo_final: saldoFinalDia,
        sdd_descricao: 'Atualização automática',
        sdd_observacao: null,
        sdd_usr_id: usrId,
        ...(registroAtual?.sdd_criado_em ? { sdd_criado_em: registroAtual.sdd_criado_em } : {}),
      },
      { onConflict: 'sdd_data' },
    );

    if (errUpsert) throw errUpsert;

    diasProcessados++;
    saldoAnterior = saldoFinalDia;
  }

  return diasProcessados;
}
