
'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { Header } from '@/components/layout';
import { Button, Card, Input, Loading, ConfirmModal } from '@/components/ui';
import {
  getOrCreateUser,
  getSupabaseClient,
  type UsuarioRow,
} from '@/lib/supabaseClient';
import { getUserSession } from '@/lib/userSession';
import { evaluateMath, formatCurrency } from '@/lib/mathParser';
import { traduzirErroSupabase } from '@/lib/supabaseErrors';
import { dataLiberadaParaEdicao } from '@/lib/verificarPeriodoLiberado';
import { recalcularSaldoDiario } from '@/lib/recalcularSaldoDiario';

type Mensagem = { tipo: 'sucesso' | 'erro' | 'info'; texto: string };
type Processo = 'area' | 'receita' | 'banco' | 'saldo';

type AreaOption = { id: number; nome: string };
type ContaOption = { id: number; nome: string; codigo: string };
type BancoOption = { id: number; nome: string };

type RegistroMensagem = Record<Processo, Mensagem | null>;
type RegistroProcesso = Record<Processo, boolean>;

type MaybeArray<T> = T | T[] | null | undefined;

type PagamentoAreaRow = {
  pag_id?: unknown;
  pag_valor?: unknown;
  pag_data?: unknown;
  pag_are_id?: unknown;
  are_areas?: MaybeArray<{ are_nome?: unknown } | null>;
};

type ReceitaRow = {
  rec_id?: unknown;
  rec_valor?: unknown;
  rec_data?: unknown;
  rec_ctr_id?: unknown;
  ctr_contas_receita?: MaybeArray<{ ctr_nome?: unknown } | null>;
};

type PagamentoBancoRow = {
  pbk_id?: unknown;
  pbk_valor?: unknown;
  pbk_data?: unknown;
  pbk_ban_id?: unknown;
  ban_bancos?: MaybeArray<{ ban_nome?: unknown } | null>;
};

type SaldoBancoRow = {
  sdb_id?: unknown;
  sdb_saldo?: unknown;
  sdb_data?: unknown;
  sdb_ban_id?: unknown;
  ban_bancos?: MaybeArray<{ ban_nome?: unknown } | null>;
};

type PagamentoArea = {
  id: number;
  valor: number;
  data: string;
  area: string;
  areaId: number;
};

type Receita = {
  id: number;
  valor: number;
  data: string;
  conta: string;
  contaId: number;
};

type PagamentoBanco = {
  id: number;
  valor: number;
  data: string;
  banco: string;
  bancoId: number;
};

type SaldoBanco = {
  id: number;
  valor: number;
  data: string;
  banco: string;
  bancoId: number;
};

type FormMapa = Record<number, string>;

const normalizeRelation = <T,>(value: MaybeArray<T>): Exclude<T, null | undefined>[] => {
  if (!value) {
    return [];
  }

  const arrayValue = Array.isArray(value) ? value : [value];
  return arrayValue.filter((item): item is Exclude<T, null | undefined> => item != null);
};

const toNumber = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toString = (value: unknown, fallback = ''): string => {
  if (value === null || value === undefined) {
    return fallback;
  }
  return String(value);
};

const mapPagamentosArea = (rows: MaybeArray<PagamentoAreaRow | null>): PagamentoArea[] =>
  normalizeRelation(rows).map((row) => ({
    id: toNumber(row.pag_id),
    valor: toNumber(row.pag_valor),
    data: toString(row.pag_data),
    area: normalizeRelation(row.are_areas ?? null)[0]?.are_nome
      ? toString(normalizeRelation(row.are_areas ?? null)[0]?.are_nome)
      : 'Área não informada',
    areaId: toNumber(row.pag_are_id),
  }));

const mapReceitas = (rows: MaybeArray<ReceitaRow | null>): Receita[] =>
  normalizeRelation(rows).map((row) => ({
    id: toNumber(row.rec_id),
    valor: toNumber(row.rec_valor),
    data: toString(row.rec_data),
    conta: normalizeRelation(row.ctr_contas_receita ?? null)[0]?.ctr_nome
      ? toString(normalizeRelation(row.ctr_contas_receita ?? null)[0]?.ctr_nome)
      : 'Conta não informada',
    contaId: toNumber(row.rec_ctr_id),
  }));

const mapPagamentosBanco = (rows: MaybeArray<PagamentoBancoRow | null>): PagamentoBanco[] =>
  normalizeRelation(rows).map((row) => ({
    id: toNumber(row.pbk_id),
    valor: toNumber(row.pbk_valor),
    data: toString(row.pbk_data),
    banco: normalizeRelation(row.ban_bancos ?? null)[0]?.ban_nome
      ? toString(normalizeRelation(row.ban_bancos ?? null)[0]?.ban_nome)
      : 'Banco não informado',
    bancoId: toNumber(row.pbk_ban_id),
  }));

const mapSaldosBanco = (rows: MaybeArray<SaldoBancoRow | null>): SaldoBanco[] =>
  normalizeRelation(rows).map((row) => ({
    id: toNumber(row.sdb_id),
    valor: toNumber(row.sdb_saldo),
    data: toString(row.sdb_data),
    banco: normalizeRelation(row.ban_bancos ?? null)[0]?.ban_nome
      ? toString(normalizeRelation(row.ban_bancos ?? null)[0]?.ban_nome)
      : 'Banco não informado',
    bancoId: toNumber(row.sdb_ban_id),
  }));

const sincronizarMapa = (options: { id: number }[], mapa: FormMapa): FormMapa => {
  const next: FormMapa = {};
  options.forEach((option) => {
    next[option.id] = mapa[option.id] ?? '';
  });
  return next;
};

const formatarData = (isoDate: string): string => {
  if (!isoDate) {
    return '';
  }

  const data = new Date(isoDate + 'T00:00:00');
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(data);
};

const calcularUltimoDiaUtil = (): string => {
  const hoje = new Date();
  const data = new Date(hoje);
  data.setDate(data.getDate() - 1);

  for (let i = 0; i < 7; i += 1) {
    const diaSemana = data.getDay();
    if (diaSemana !== 0 && diaSemana !== 6) {
      return data.toISOString().split('T')[0];
    }

    data.setDate(data.getDate() - 1);
  }

  return new Date(hoje).toISOString().split('T')[0];
};

const obterOrdemArea = (nomeArea: string): number => {
  const nomeNormalizado = nomeArea.trim().toUpperCase();
  const ordemAreas: Record<string, number> = {
    'GASTO COM MATERIAL E CONSUMO': 1,
    'MATERIAL E CONSUMO': 1,
    'GASTO RH': 2,
    'RH': 2,
    'GASTO FINANCEIRO E FISCAL': 3,
    'FINANCEIRO E FISCAL': 3,
    'GASTO LOGISTICA': 4,
    'LOGISTICA': 4,
    'GASTO COMERCIAL': 5,
    'COMERCIAL': 5,
    'GASTO MARKETING': 6,
    'MARKETING': 6,
    'GASTO LOJA DE FABRICA': 7,
    'LOJA DE FABRICA': 7,
    'GASTO TI': 8,
    'TI': 8,
    'GASTO DIRETORIA': 9,
    'DIRETORIA': 9,
    'GASTO COMPRAS': 10,
    'COMPRAS': 10,
    'GASTO INVESTIMENTO': 11,
    'INVESTIMENTO': 11,
    'GASTO DALLAS': 12,
    'DALLAS': 12,
    'TRANSFERÊNCIA PARA APLICAÇÃO': 13,
    'TRANSFERENCIA PARA APLICACAO': 13,
    'APLICACAO': 13,
  };

  // Procura pela chave exata
  if (ordemAreas[nomeNormalizado] !== undefined) {
    return ordemAreas[nomeNormalizado];
  }

  // Procura se contém alguma das palavras-chave
  for (const [chave, ordem] of Object.entries(ordemAreas)) {
    if (nomeNormalizado.includes(chave)) {
      return ordem;
    }
  }

  // Se não encontrou, retorna um valor alto para aparecer no final
  return 999;
};

const normalizarExpressao = (valor: string): string =>
  valor.replace(/\s+/g, '').replace(/,/g, '.');

const avaliarEntrada = (valor: string | undefined): number | null => {
  if (!valor) {
    return null;
  }

  const normalizado = normalizarExpressao(valor);
  if (!normalizado) {
    return null;
  }

  const resultado = evaluateMath(normalizado);
  if (resultado !== null) {
    return resultado;
  }

  const parsed = Number(normalizado);
  if (Number.isFinite(parsed)) {
    return Math.round(parsed * 100) / 100;
  }

  return null;
};

const formatarValorParaInput = (valor: number | null | undefined): string => {
  if (valor === null || valor === undefined) {
    return '';
  }

  const numero = Number(valor);
  if (!Number.isFinite(numero)) {
    return '';
  }

  return numero.toFixed(2).replace('.', ',');
};

const SaldoDiarioPage: React.FC = () => {
  const ultimoDiaUtil = useMemo(() => calcularUltimoDiaUtil(), []);
  const [dataReferencia, setDataReferencia] = useState(ultimoDiaUtil);

  const [usuario, setUsuario] = useState<UsuarioRow | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [atualizando, setAtualizando] = useState(false);
  const [dataLiberada, setDataLiberada] = useState(true);
  const [motivoBloqueio, setMotivoBloqueio] = useState<string>('');

  const [pagamentosArea, setPagamentosArea] = useState<PagamentoArea[]>([]);
  const [receitas, setReceitas] = useState<Receita[]>([]);
  const [pagamentosBanco, setPagamentosBanco] = useState<PagamentoBanco[]>([]);
  const [saldosBanco, setSaldosBanco] = useState<SaldoBanco[]>([]);
  const [saldosBancoDiaAnterior, setSaldosBancoDiaAnterior] = useState<SaldoBanco[]>([]);

  const [areaOptions, setAreaOptions] = useState<AreaOption[]>([]);
  const [contaOptions, setContaOptions] = useState<ContaOption[]>([]);
  const [bancoOptions, setBancoOptions] = useState<BancoOption[]>([]);

  const [pagamentosAreaForm, setPagamentosAreaForm] = useState<FormMapa>({});
  const [receitasForm, setReceitasForm] = useState<FormMapa>({});
  const [pagamentosBancoForm, setPagamentosBancoForm] = useState<FormMapa>({});
  const [saldosBancoForm, setSaldosBancoForm] = useState<FormMapa>({});
  const [pagamentosAreaEdicao, setPagamentosAreaEdicao] = useState<FormMapa>({});
  const [receitasEdicao, setReceitasEdicao] = useState<FormMapa>({});
  const [pagamentosBancoEdicao, setPagamentosBancoEdicao] = useState<FormMapa>({});
  const [saldosBancoEdicao, setSaldosBancoEdicao] = useState<FormMapa>({});

  // Controle de quais registros estão em modo de edição
  const [emEdicaoArea, setEmEdicaoArea] = useState<Set<number>>(new Set());
  const [emEdicaoReceita, setEmEdicaoReceita] = useState<Set<number>>(new Set());
  const [emEdicaoPagamentoBanco, setEmEdicaoPagamentoBanco] = useState<Set<number>>(new Set());
  const [emEdicaoSaldoBanco, setEmEdicaoSaldoBanco] = useState<Set<number>>(new Set());

  // Controle de quais registros estão selecionados para exclusão em lote
  const [itensSelecionadosArea, setItensSelecionadosArea] = useState<Set<number>>(new Set());
  const [itensSelecionadosReceita, setItensSelecionadosReceita] = useState<Set<number>>(new Set());
  const [itensSelecionadosBanco, setItensSelecionadosBanco] = useState<Set<number>>(new Set());
  const [itensSelecionadosSaldo, setItensSelecionadosSaldo] = useState<Set<number>>(new Set());

  // Controle do modal de confirmação de exclusão em lote
  const [modalConfirmacao, setModalConfirmacao] = useState<{
    aberto: boolean;
    processo: Processo | null;
    quantidade: number;
  }>({ aberto: false, processo: null, quantidade: 0 });

  // Áreas ordenadas de acordo com a sequência definida
  const areaOptionsOrdenadas = useMemo(() => {
    return [...areaOptions].sort((a, b) => {
      const ordemA = obterOrdemArea(a.nome);
      const ordemB = obterOrdemArea(b.nome);
      if (ordemA !== ordemB) {
        return ordemA - ordemB;
      }
      return a.nome.localeCompare(b.nome, 'pt-BR');
    });
  }, [areaOptions]);

  const [processando, setProcessando] = useState<RegistroProcesso>({
    area: false,
    receita: false,
    banco: false,
    saldo: false,
  });
  const [mensagens, setMensagens] = useState<RegistroMensagem>({
    area: null,
    receita: null,
    banco: null,
    saldo: null,
  });
  const [registroEditando, setRegistroEditando] = useState<Record<Processo, number | null>>({
    area: null,
    receita: null,
    banco: null,
    saldo: null,
  });
  const [registroExcluindo, setRegistroExcluindo] = useState<Record<Processo, number | null>>({
    area: null,
    receita: null,
    banco: null,
    saldo: null,
  });

  const edicaoLiberada = dataLiberada;

  useEffect(() => {
    setPagamentosAreaForm((prev) => sincronizarMapa(areaOptions, prev));
  }, [areaOptions]);

  useEffect(() => {
    setReceitasForm((prev) => sincronizarMapa(contaOptions, prev));
  }, [contaOptions]);

  useEffect(() => {
    setPagamentosBancoForm((prev) => sincronizarMapa(bancoOptions, prev));
    setSaldosBancoForm((prev) => sincronizarMapa(bancoOptions, prev));
  }, [bancoOptions]);

  useEffect(() => {
    setPagamentosAreaEdicao(() => {
      const mapa: FormMapa = {};
      pagamentosArea.forEach((registro) => {
        mapa[registro.id] = formatarValorParaInput(registro.valor);
      });
      return mapa;
    });
  }, [pagamentosArea]);

  useEffect(() => {
    setReceitasEdicao(() => {
      const mapa: FormMapa = {};
      receitas.forEach((registro) => {
        mapa[registro.id] = formatarValorParaInput(registro.valor);
      });
      return mapa;
    });
  }, [receitas]);

  useEffect(() => {
    setPagamentosBancoEdicao(() => {
      const mapa: FormMapa = {};
      pagamentosBanco.forEach((registro) => {
        mapa[registro.id] = formatarValorParaInput(registro.valor);
      });
      return mapa;
    });
  }, [pagamentosBanco]);

  useEffect(() => {
    setSaldosBancoEdicao(() => {
      const mapa: FormMapa = {};
      saldosBanco.forEach((registro) => {
        mapa[registro.id] = formatarValorParaInput(registro.valor);
      });
      return mapa;
    });
  }, [saldosBanco]);

  const atualizarMensagem = useCallback(
    (processo: Processo, mensagem: Mensagem | null) => {
      setMensagens((prev) => ({ ...prev, [processo]: mensagem }));
    },
    []
  );

  const atualizarProcesso = useCallback((processo: Processo, status: boolean) => {
    setProcessando((prev) => ({ ...prev, [processo]: status }));
  }, []);

  const carregarOpcoes = useCallback(async () => {
    const supabase = getSupabaseClient();
    const [areasRes, contasRes, bancosRes] = await Promise.all([
      supabase
        .from('are_areas')
        .select('are_id, are_nome')
        .eq('are_ativo', true)
        .order('are_nome', { ascending: true }),
      supabase
        .from('ctr_contas_receita')
        .select('ctr_id, ctr_nome, ctr_codigo')
        .eq('ctr_ativo', true)
        .order('ctr_codigo, ctr_nome', { ascending: true }),
      supabase
        .from('ban_bancos')
        .select('ban_id, ban_nome')
        .eq('ban_ativo', true)
        .order('ban_nome', { ascending: true }),
    ]);

    if (areasRes.error) throw areasRes.error;
    if (contasRes.error) throw contasRes.error;
    if (bancosRes.error) throw bancosRes.error;

    setAreaOptions(
      (areasRes.data ?? []).map((area: { are_id: number; are_nome: string | null }) => ({
        id: Number(area.are_id),
        nome: area.are_nome ?? 'Área sem nome',
      }))
    );

    setContaOptions(
      (contasRes.data ?? []).map((conta: { ctr_id: number; ctr_nome: string | null; ctr_codigo: string | null }) => ({
        id: Number(conta.ctr_id),
        nome: conta.ctr_nome ?? 'Conta sem nome',
        codigo: conta.ctr_codigo ?? '',
      }))
    );

    setBancoOptions(
      (bancosRes.data ?? []).map((banco: { ban_id: number; ban_nome: string | null }) => ({
        id: Number(banco.ban_id),
        nome: banco.ban_nome ?? 'Banco sem nome',
      }))
    );
  }, []);

  const carregarMovimentacoes = useCallback(
    async (data: string) => {
      const supabase = getSupabaseClient();

      // Buscar o último dia COM saldo registrado (não apenas o dia anterior)
      const { data: ultimoSaldo, error: ultimoSaldoError } = await supabase
        .from('sdb_saldo_banco')
        .select('sdb_data')
        .lt('sdb_data', data) // Menor que a data atual
        .order('sdb_data', { ascending: false })
        .limit(1);

      let dataAnterior = null;
      if (ultimoSaldo && ultimoSaldo.length > 0) {
        dataAnterior = ultimoSaldo[0].sdb_data;
      }

      const [pagAreaRes, recRes, pagBancoRes, saldoRes, saldoDiaAnteriorRes] = await Promise.all([
        supabase
          .from('pag_pagamentos_area')
          .select('pag_id, pag_valor, pag_data, pag_are_id, are_areas(are_nome)')
          .eq('pag_data', data)
          .order('pag_criado_em', { ascending: false })
          .limit(100),
        supabase
          .from('rec_receitas')
          .select('rec_id, rec_valor, rec_data, rec_ctr_id, ctr_contas_receita(ctr_nome)')
          .eq('rec_data', data)
          .order('rec_criado_em', { ascending: false })
          .limit(100),
        supabase
          .from('pbk_pagamentos_banco')
          .select('pbk_id, pbk_valor, pbk_data, pbk_ban_id, ban_bancos(ban_nome)')
          .eq('pbk_data', data)
          .order('pbk_criado_em', { ascending: false })
          .limit(100),
        supabase
          .from('sdb_saldo_banco')
          .select('sdb_id, sdb_saldo, sdb_data, sdb_ban_id, ban_bancos(ban_nome)')
          .eq('sdb_data', data)
          .order('sdb_criado_em', { ascending: false })
          .limit(100),
        // Buscar saldo do último dia com lançamento (se existir)
        dataAnterior
          ? supabase
              .from('sdb_saldo_banco')
              .select('sdb_id, sdb_saldo, sdb_data, sdb_ban_id, ban_bancos(ban_nome)')
              .eq('sdb_data', dataAnterior)
              .order('sdb_criado_em', { ascending: false })
              .limit(100)
          : Promise.resolve({ data: [], error: null }),
      ]);

      if (pagAreaRes.error) throw pagAreaRes.error;
      if (recRes.error) throw recRes.error;
      if (pagBancoRes.error) throw pagBancoRes.error;
      if (saldoRes.error) throw saldoRes.error;
      if (saldoDiaAnteriorRes.error) throw saldoDiaAnteriorRes.error;

      setPagamentosArea(mapPagamentosArea(pagAreaRes.data as MaybeArray<PagamentoAreaRow | null>));
      setReceitas(mapReceitas(recRes.data as MaybeArray<ReceitaRow | null>));
      setPagamentosBanco(mapPagamentosBanco(pagBancoRes.data as MaybeArray<PagamentoBancoRow | null>));
      setSaldosBanco(mapSaldosBanco(saldoRes.data as MaybeArray<SaldoBancoRow | null>));
      setSaldosBancoDiaAnterior(mapSaldosBanco(saldoDiaAnteriorRes.data as MaybeArray<SaldoBancoRow | null>));
    },
    []
  );

  useEffect(() => {
    const inicializar = async () => {
      try {
        setCarregando(true);
        const supabase = getSupabaseClient();
        const { userId, userName, userEmail } = getUserSession();
        const { data, error } = await getOrCreateUser(
          supabase,
          userId,
          userName ?? undefined,
          userEmail ?? undefined,
        );

        if (error) throw error;
        if (!data) {
          setErro('Não foi possível identificar o usuário atual.');
          return;
        }

        setUsuario(data);
        await carregarOpcoes();
        setErro(null);
      } catch (error) {
        console.error('Erro ao carregar movimentação diária:', error);
        setErro('Não foi possível carregar os dados da movimentação diária.');
      } finally {
        setCarregando(false);
      }
    };

    inicializar();
  }, [carregarOpcoes]);

  useEffect(() => {
    if (!usuario) {
      return;
    }

    const atualizar = async () => {
      try {
        setAtualizando(true);
        await carregarMovimentacoes(dataReferencia);
        setErro(null);
      } catch (error) {
        console.error('Erro ao atualizar movimentação diária:', error);
        setErro('Não foi possível carregar os dados para a data selecionada.');
      } finally {
        setAtualizando(false);
      }
    };

    atualizar();
  }, [usuario, dataReferencia, carregarMovimentacoes]);

  // Verifica se a data está liberada para edição
  useEffect(() => {
    const verificarDataLiberada = async () => {
      try {
        const supabase = getSupabaseClient();
        const resultado = await dataLiberadaParaEdicao(supabase, dataReferencia);

        setDataLiberada(resultado.liberada);
        setMotivoBloqueio(resultado.motivo);
      } catch (error) {
        console.error('Erro ao verificar data liberada:', error);
        setDataLiberada(false);
        setMotivoBloqueio('Erro ao verificar permissão');
      }
    };

    if (dataReferencia) {
      verificarDataLiberada();
    }
  }, [dataReferencia]);

  const limparMensagem = (processo: Processo) => atualizarMensagem(processo, null);

  const handleAtualizar = async () => {
    try {
      setAtualizando(true);
      await carregarMovimentacoes(dataReferencia);
      setErro(null);
    } catch (error) {
      console.error('Erro ao atualizar movimentação diária:', error);
      setErro('Não foi possível atualizar os dados. Tente novamente.');
    } finally {
      setAtualizando(false);
    }
  };

  /**
   * Dispara o recálculo de sdd_saldo_diario a partir da data de referência.
   * Executado em background após cada operação de gravação para manter os
   * relatórios sempre atualizados sem intervenção manual.
   */
  const atualizarSaldoDiarioAutomaticamente = useCallback(
    async (dataRef: string) => {
      if (!usuario) return;
      try {
        const supabase = getSupabaseClient();
        await recalcularSaldoDiario(supabase, usuario.usr_id, dataRef);
      } catch (err) {
        // Falha silenciosa: o recálculo é uma conveniência, não deve bloquear o fluxo principal
        console.warn('Aviso: não foi possível atualizar saldos diários automaticamente:', err);
      }
    },
    [usuario],
  );

  /**
   * Recarrega os dados da tela e recalcula os saldos diários em seguida.
   * Deve ser usado após qualquer operação de escrita (inserção, edição, exclusão).
   */
  const recarregarERecalcular = useCallback(
    async (dataRef: string) => {
      await carregarMovimentacoes(dataRef);
      // Dispara recálculo em background (não bloqueia a UI)
      atualizarSaldoDiarioAutomaticamente(dataRef);
    },
    [carregarMovimentacoes, atualizarSaldoDiarioAutomaticamente],
  );

  const handleRegistrarPagamentosArea = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!usuario) return;

    if (!edicaoLiberada) {
      atualizarMensagem('area', {
        tipo: 'erro',
        texto: `Os lançamentos só podem ser registrados para o último dia útil (${formatarData(ultimoDiaUtil)}).`,
      });
      return;
    }

    const novos: {
      pag_are_id: number;
      pag_usr_id: string;
      pag_data: string;
      pag_valor: number;
    }[] = [];
    const atualizacoes: PagamentoArea[] = [];

    areaOptions.forEach((area) => {
      const valorCalculado = avaliarEntrada(pagamentosAreaForm[area.id]);
      if (valorCalculado === null || valorCalculado <= 0) {
        return;
      }

      const existente = pagamentosAreaPorAreaId.get(area.id);
      if (existente) {
        if (Math.abs(valorCalculado - existente.valor) > 0.009) {
          atualizacoes.push({
            ...existente,
            valor: valorCalculado,
          });
        }
      } else {
        novos.push({
          pag_are_id: area.id,
          pag_usr_id: usuario.usr_id,
          pag_data: dataReferencia,
          pag_valor: valorCalculado,
        });
      }
    });

    if (novos.length === 0 && atualizacoes.length === 0) {
      atualizarMensagem('area', {
        tipo: 'erro',
        texto: 'Informe valores válidos ou diferentes do que já está registrado antes de salvar.',
      });
      return;
    }

    try {
      atualizarProcesso('area', true);
      atualizarMensagem('area', null);

      const supabase = getSupabaseClient();
      if (novos.length > 0) {
        const { error: inserirErro } = await supabase.from('pag_pagamentos_area').insert(novos);
        if (inserirErro) throw inserirErro;
      }

      if (atualizacoes.length > 0) {
        const payload = atualizacoes.map((registro) => ({
          pag_id: registro.id,
          pag_are_id: registro.areaId,
          pag_usr_id: usuario.usr_id,
          pag_data: dataReferencia,
          pag_valor: registro.valor,
        }));
        const { error: atualizarErro } = await supabase
          .from('pag_pagamentos_area')
          .upsert(payload, { onConflict: 'pag_id' });
        if (atualizarErro) throw atualizarErro;
      }

      const areasProcessadas = new Set<number>();
      novos.forEach((item) => areasProcessadas.add(item.pag_are_id));
      atualizacoes.forEach((item) => areasProcessadas.add(item.areaId));

      if (areasProcessadas.size > 0) {
        setPagamentosAreaForm((prev) => {
          const next = { ...prev };
          areasProcessadas.forEach((id) => {
            next[id] = '';
          });
          return next;
        });
      }

      const mensagemPartes: string[] = [];
      if (novos.length > 0) {
        mensagemPartes.push(`${novos.length} novo${novos.length > 1 ? 's' : ''}`);
      }
      if (atualizacoes.length > 0) {
        mensagemPartes.push(`${atualizacoes.length} atualizado${atualizacoes.length > 1 ? 's' : ''}`);
      }

      atualizarMensagem('area', {
        tipo: 'sucesso',
        texto:
          mensagemPartes.length === 0
            ? 'Pagamentos por área registrados.'
            : `Pagamentos por área salvos (${mensagemPartes.join(' e ')}).`,
      });
      await recarregarERecalcular(dataReferencia);
    } catch (error) {
      console.error('Erro ao registrar pagamento por área:', error);
      atualizarMensagem('area', {
        tipo: 'erro',
        texto: traduzirErroSupabase(
          error,
          'Não foi possível registrar os pagamentos. Verifique os dados e tente novamente.',
        ),
      });
    } finally {
      atualizarProcesso('area', false);
    }
  };

  const handleRegistrarReceitas = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!usuario) return;

    if (!edicaoLiberada) {
      atualizarMensagem('receita', {
        tipo: 'erro',
        texto: `Os lançamentos só podem ser registrados para o último dia útil (${formatarData(ultimoDiaUtil)}).`,
      });
      return;
    }

    const novos: {
      rec_ctr_id: number;
      rec_usr_id: string;
      rec_data: string;
      rec_valor: number;
    }[] = [];
    const atualizacoes: Receita[] = [];

    contaOptions.forEach((conta) => {
      const valorCalculado = avaliarEntrada(receitasForm[conta.id]);
      if (valorCalculado === null || valorCalculado <= 0) {
        return;
      }

      const existente = receitasPorContaId.get(conta.id);
      if (existente) {
        if (Math.abs(valorCalculado - existente.valor) > 0.009) {
          atualizacoes.push({
            ...existente,
            valor: valorCalculado,
          });
        }
      } else {
        novos.push({
          rec_ctr_id: conta.id,
          rec_usr_id: usuario.usr_id,
          rec_data: dataReferencia,
          rec_valor: valorCalculado,
        });
      }
    });

    if (novos.length === 0 && atualizacoes.length === 0) {
      atualizarMensagem('receita', {
        tipo: 'erro',
        texto: 'Informe valores válidos ou diferentes do que já está registrado antes de salvar.',
      });
      return;
    }

    try {
      atualizarProcesso('receita', true);
      atualizarMensagem('receita', null);

      const supabase = getSupabaseClient();
      if (novos.length > 0) {
        const { error: inserirErro } = await supabase.from('rec_receitas').insert(novos);
        if (inserirErro) throw inserirErro;
      }

      if (atualizacoes.length > 0) {
        const payload = atualizacoes.map((registro) => ({
          rec_id: registro.id,
          rec_ctr_id: registro.contaId,
          rec_usr_id: usuario.usr_id,
          rec_data: dataReferencia,
          rec_valor: registro.valor,
        }));
        const { error: atualizarErro } = await supabase
          .from('rec_receitas')
          .upsert(payload, { onConflict: 'rec_id' });
        if (atualizarErro) throw atualizarErro;
      }

      const contasProcessadas = new Set<number>();
      novos.forEach((item) => contasProcessadas.add(item.rec_ctr_id));
      atualizacoes.forEach((item) => contasProcessadas.add(item.contaId));

      if (contasProcessadas.size > 0) {
        setReceitasForm((prev) => {
          const next = { ...prev };
          contasProcessadas.forEach((id) => {
            next[id] = '';
          });
          return next;
        });
      }

      const mensagemPartes: string[] = [];
      if (novos.length > 0) {
        mensagemPartes.push(`${novos.length} nova${novos.length > 1 ? 's' : ''}`);
      }
      if (atualizacoes.length > 0) {
        mensagemPartes.push(`${atualizacoes.length} atualizada${atualizacoes.length > 1 ? 's' : ''}`);
      }

      atualizarMensagem('receita', {
        tipo: 'sucesso',
        texto:
          mensagemPartes.length === 0
            ? 'Receitas registradas com sucesso.'
            : `Receitas salvas (${mensagemPartes.join(' e ')}).`,
      });
      await recarregarERecalcular(dataReferencia);
    } catch (error) {
      console.error('Erro ao registrar receitas:', error);
      atualizarMensagem('receita', {
        tipo: 'erro',
        texto: traduzirErroSupabase(
          error,
          'Não foi possível registrar as receitas. Tente novamente em instantes.',
        ),
      });
    } finally {
      atualizarProcesso('receita', false);
    }
  };

  const handleRegistrarPagamentosBanco = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!usuario) return;

    if (!edicaoLiberada) {
      atualizarMensagem('banco', {
        tipo: 'erro',
        texto: `Os lançamentos só podem ser registrados para o último dia útil (${formatarData(ultimoDiaUtil)}).`,
      });
      return;
    }

    const novos: {
      pbk_ban_id: number;
      pbk_usr_id: string;
      pbk_data: string;
      pbk_valor: number;
    }[] = [];
    const atualizacoes: PagamentoBanco[] = [];

    bancoOptions.forEach((banco) => {
      const valorCalculado = avaliarEntrada(pagamentosBancoForm[banco.id]);
      if (valorCalculado === null || valorCalculado <= 0) {
        return;
      }

      const existente = pagamentosBancoPorBancoId.get(banco.id);
      if (existente) {
        if (Math.abs(valorCalculado - existente.valor) > 0.009) {
          atualizacoes.push({
            ...existente,
            valor: valorCalculado,
          });
        }
      } else {
        novos.push({
          pbk_ban_id: banco.id,
          pbk_usr_id: usuario.usr_id,
          pbk_data: dataReferencia,
          pbk_valor: valorCalculado,
        });
      }
    });

    if (novos.length === 0 && atualizacoes.length === 0) {
      atualizarMensagem('banco', {
        tipo: 'erro',
        texto: 'Informe valores válidos ou diferentes do que já está registrado antes de salvar.',
      });
      return;
    }

    try {
      atualizarProcesso('banco', true);
      atualizarMensagem('banco', null);

      const supabase = getSupabaseClient();
      if (novos.length > 0) {
        const { error: inserirErro } = await supabase.from('pbk_pagamentos_banco').insert(novos);
        if (inserirErro) throw inserirErro;
      }

      if (atualizacoes.length > 0) {
        const payload = atualizacoes.map((registro) => ({
          pbk_id: registro.id,
          pbk_ban_id: registro.bancoId,
          pbk_usr_id: usuario.usr_id,
          pbk_data: dataReferencia,
          pbk_valor: registro.valor,
        }));
        const { error: atualizarErro } = await supabase
          .from('pbk_pagamentos_banco')
          .upsert(payload, { onConflict: 'pbk_id' });
        if (atualizarErro) throw atualizarErro;
      }

      const bancosProcessados = new Set<number>();
      novos.forEach((item) => bancosProcessados.add(item.pbk_ban_id));
      atualizacoes.forEach((item) => bancosProcessados.add(item.bancoId));

      if (bancosProcessados.size > 0) {
        setPagamentosBancoForm((prev) => {
          const next = { ...prev };
          bancosProcessados.forEach((id) => {
            next[id] = '';
          });
          return next;
        });
      }

      const mensagemPartes: string[] = [];
      if (novos.length > 0) {
        mensagemPartes.push(`${novos.length} novo${novos.length > 1 ? 's' : ''}`);
      }
      if (atualizacoes.length > 0) {
        mensagemPartes.push(`${atualizacoes.length} atualizado${atualizacoes.length > 1 ? 's' : ''}`);
      }

      atualizarMensagem('banco', {
        tipo: 'sucesso',
        texto:
          mensagemPartes.length === 0
            ? 'Pagamentos bancários registrados.'
            : `Pagamentos bancários salvos (${mensagemPartes.join(' e ')}).`,
      });
      await recarregarERecalcular(dataReferencia);
    } catch (error) {
      console.error('Erro ao registrar pagamentos bancários:', error);
      atualizarMensagem('banco', {
        tipo: 'erro',
        texto: traduzirErroSupabase(
          error,
          'Não foi possível registrar os pagamentos bancários. Revise os dados e tente novamente.',
        ),
      });
    } finally {
      atualizarProcesso('banco', false);
    }
  };

  const handleRegistrarSaldosBanco = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!usuario) return;

    if (!edicaoLiberada) {
      atualizarMensagem('saldo', {
        tipo: 'erro',
        texto: `Os lançamentos só podem ser registrados para o último dia útil (${formatarData(ultimoDiaUtil)}).`,
      });
      return;
    }

    const registros = bancoOptions
      .map((banco) => {
        const valorCalculado = avaliarEntrada(saldosBancoForm[banco.id]);
        if (valorCalculado === null) {
          return null;
        }

        return {
          sdb_ban_id: banco.id,
          sdb_usr_id: usuario.usr_id,
          sdb_data: dataReferencia,
          sdb_saldo: valorCalculado,
        };
      })
      .filter(Boolean) as {
      sdb_ban_id: number;
      sdb_usr_id: string;
      sdb_data: string;
      sdb_saldo: number;
    }[];

    if (registros.length === 0) {
      atualizarMensagem('saldo', {
        tipo: 'erro',
        texto: 'Informe saldos numéricos para ao menos um banco antes de salvar.',
      });
      return;
    }

    try {
      atualizarProcesso('saldo', true);
      atualizarMensagem('saldo', null);

      const supabase = getSupabaseClient();
      const { error } = await supabase
        .from('sdb_saldo_banco')
        .upsert(registros, { onConflict: 'sdb_ban_id,sdb_data' });

      if (error) throw error;

      setSaldosBancoForm((prev) => {
        const next = { ...prev };
        registros.forEach((registro) => {
          next[registro.sdb_ban_id] = '';
        });
        return next;
      });

      atualizarMensagem('saldo', {
        tipo: 'sucesso',
        texto:
          registros.length === 1
            ? 'Saldo bancário atualizado com sucesso.'
            : `${registros.length} saldos bancários atualizados com sucesso.`,
      });
      await recarregarERecalcular(dataReferencia);
    } catch (error) {
      console.error('Erro ao registrar saldos bancários:', error);
      atualizarMensagem('saldo', {
        tipo: 'erro',
        texto: traduzirErroSupabase(
          error,
          'Não foi possível registrar os saldos. Tente novamente.',
        ),
      });
    } finally {
      atualizarProcesso('saldo', false);
    }
  };

  const handleAtualizarPagamentoAreaExistente = async (registro: PagamentoArea) => {
    if (!usuario) return;
    if (!edicaoLiberada) {
      atualizarMensagem('area', {
        tipo: 'erro',
        texto: `As edições só podem ser realizadas para o último dia útil (${formatarData(ultimoDiaUtil)}).`,
      });
      return;
    }

    const entrada = pagamentosAreaEdicao[registro.id] ?? '';
    const valorCalculado = avaliarEntrada(entrada);
    if (valorCalculado === null || valorCalculado <= 0) {
      atualizarMensagem('area', {
        tipo: 'erro',
        texto: 'Informe um valor positivo para atualizar o pagamento.',
      });
      return;
    }

    if (Math.abs(valorCalculado - registro.valor) < 0.01) {
      atualizarMensagem('area', {
        tipo: 'info',
        texto: 'O valor informado é igual ao já registrado.',
      });
      return;
    }

    try {
      setRegistroEditando((prev) => ({ ...prev, area: registro.id }));
      atualizarMensagem('area', null);

      const supabase = getSupabaseClient();
      const { error } = await supabase
        .from('pag_pagamentos_area')
        .update({ pag_valor: valorCalculado })
        .eq('pag_id', registro.id);

      if (error) throw error;

      atualizarMensagem('area', {
        tipo: 'sucesso',
        texto: 'Pagamento por área atualizado com sucesso.',
      });
      await recarregarERecalcular(dataReferencia);
    } catch (error) {
      console.error('Erro ao atualizar pagamento por área:', error);
      atualizarMensagem('area', {
        tipo: 'erro',
        texto: traduzirErroSupabase(
          error,
          'Não foi possível atualizar o pagamento selecionado. Tente novamente.',
        ),
      });
    } finally {
      setRegistroEditando((prev) => ({ ...prev, area: null }));
    }
  };

  const handleExcluirPagamentoArea = async (registro: PagamentoArea) => {
    if (!usuario) return;
    if (!edicaoLiberada) {
      atualizarMensagem('area', {
        tipo: 'erro',
        texto: `As exclusões só podem ser realizadas para o último dia útil (${formatarData(ultimoDiaUtil)}).`,
      });
      return;
    }

    try {
      setRegistroExcluindo((prev) => ({ ...prev, area: registro.id }));
      atualizarMensagem('area', null);

      const supabase = getSupabaseClient();
      const { error } = await supabase.from('pag_pagamentos_area').delete().eq('pag_id', registro.id);
      if (error) throw error;

      atualizarMensagem('area', {
        tipo: 'sucesso',
        texto: 'Pagamento por área removido com sucesso.',
      });
      await recarregarERecalcular(dataReferencia);
    } catch (error) {
      console.error('Erro ao excluir pagamento por área:', error);
      atualizarMensagem('area', {
        tipo: 'erro',
        texto: traduzirErroSupabase(
          error,
          'Não foi possível remover o pagamento selecionado. Tente novamente.',
        ),
      });
    } finally {
      setRegistroExcluindo((prev) => ({ ...prev, area: null }));
    }
  };

  const handleAtualizarReceitaExistente = async (registro: Receita) => {
    if (!usuario) return;
    if (!edicaoLiberada) {
      atualizarMensagem('receita', {
        tipo: 'erro',
        texto: `As edições só podem ser realizadas para o último dia útil (${formatarData(ultimoDiaUtil)}).`,
      });
      return;
    }

    const entrada = receitasEdicao[registro.id] ?? '';
    const valorCalculado = avaliarEntrada(entrada);
    if (valorCalculado === null || valorCalculado <= 0) {
      atualizarMensagem('receita', {
        tipo: 'erro',
        texto: 'Informe um valor positivo para atualizar a receita.',
      });
      return;
    }

    if (Math.abs(valorCalculado - registro.valor) < 0.01) {
      atualizarMensagem('receita', {
        tipo: 'info',
        texto: 'O valor informado é igual ao já registrado.',
      });
      return;
    }

    try {
      setRegistroEditando((prev) => ({ ...prev, receita: registro.id }));
      atualizarMensagem('receita', null);

      const supabase = getSupabaseClient();
      const { error } = await supabase
        .from('rec_receitas')
        .update({ rec_valor: valorCalculado })
        .eq('rec_id', registro.id);

      if (error) throw error;

      atualizarMensagem('receita', {
        tipo: 'sucesso',
        texto: 'Receita atualizada com sucesso.',
      });
      await recarregarERecalcular(dataReferencia);
    } catch (error) {
      console.error('Erro ao atualizar receita:', error);
      atualizarMensagem('receita', {
        tipo: 'erro',
        texto: traduzirErroSupabase(
          error,
          'Não foi possível atualizar a receita selecionada. Tente novamente.',
        ),
      });
    } finally {
      setRegistroEditando((prev) => ({ ...prev, receita: null }));
    }
  };

  const handleExcluirReceita = async (registro: Receita) => {
    if (!usuario) return;
    if (!edicaoLiberada) {
      atualizarMensagem('receita', {
        tipo: 'erro',
        texto: `As exclusões só podem ser realizadas para o último dia útil (${formatarData(ultimoDiaUtil)}).`,
      });
      return;
    }

    try {
      setRegistroExcluindo((prev) => ({ ...prev, receita: registro.id }));
      atualizarMensagem('receita', null);

      const supabase = getSupabaseClient();
      const { error } = await supabase.from('rec_receitas').delete().eq('rec_id', registro.id);
      if (error) throw error;

      atualizarMensagem('receita', {
        tipo: 'sucesso',
        texto: 'Receita removida com sucesso.',
      });
      await recarregarERecalcular(dataReferencia);
    } catch (error) {
      console.error('Erro ao excluir receita:', error);
      atualizarMensagem('receita', {
        tipo: 'erro',
        texto: traduzirErroSupabase(
          error,
          'Não foi possível remover a receita selecionada. Tente novamente.',
        ),
      });
    } finally {
      setRegistroExcluindo((prev) => ({ ...prev, receita: null }));
    }
  };

  const handleAtualizarPagamentoBancoExistente = async (registro: PagamentoBanco) => {
    if (!usuario) return;
    if (!edicaoLiberada) {
      atualizarMensagem('banco', {
        tipo: 'erro',
        texto: `As edições só podem ser realizadas para o último dia útil (${formatarData(ultimoDiaUtil)}).`,
      });
      return;
    }

    const entrada = pagamentosBancoEdicao[registro.id] ?? '';
    const valorCalculado = avaliarEntrada(entrada);
    if (valorCalculado === null || valorCalculado <= 0) {
      atualizarMensagem('banco', {
        tipo: 'erro',
        texto: 'Informe um valor positivo para atualizar o pagamento.',
      });
      return;
    }

    if (Math.abs(valorCalculado - registro.valor) < 0.01) {
      atualizarMensagem('banco', {
        tipo: 'info',
        texto: 'O valor informado é igual ao já registrado.',
      });
      return;
    }

    try {
      setRegistroEditando((prev) => ({ ...prev, banco: registro.id }));
      atualizarMensagem('banco', null);

      const supabase = getSupabaseClient();
      const { error } = await supabase
        .from('pbk_pagamentos_banco')
        .update({ pbk_valor: valorCalculado })
        .eq('pbk_id', registro.id);

      if (error) throw error;

      atualizarMensagem('banco', {
        tipo: 'sucesso',
        texto: 'Pagamento por banco atualizado com sucesso.',
      });
      await recarregarERecalcular(dataReferencia);
    } catch (error) {
      console.error('Erro ao atualizar pagamento por banco:', error);
      atualizarMensagem('banco', {
        tipo: 'erro',
        texto: traduzirErroSupabase(
          error,
          'Não foi possível atualizar o pagamento selecionado. Tente novamente.',
        ),
      });
    } finally {
      setRegistroEditando((prev) => ({ ...prev, banco: null }));
    }
  };

  const handleExcluirPagamentoBanco = async (registro: PagamentoBanco) => {
    if (!usuario) return;
    if (!edicaoLiberada) {
      atualizarMensagem('banco', {
        tipo: 'erro',
        texto: `As exclusões só podem ser realizadas para o último dia útil (${formatarData(ultimoDiaUtil)}).`,
      });
      return;
    }

    try {
      setRegistroExcluindo((prev) => ({ ...prev, banco: registro.id }));
      atualizarMensagem('banco', null);

      const supabase = getSupabaseClient();
      const { error } = await supabase.from('pbk_pagamentos_banco').delete().eq('pbk_id', registro.id);
      if (error) throw error;

      atualizarMensagem('banco', {
        tipo: 'sucesso',
        texto: 'Pagamento bancário removido com sucesso.',
      });
      await recarregarERecalcular(dataReferencia);
    } catch (error) {
      console.error('Erro ao excluir pagamento bancário:', error);
      atualizarMensagem('banco', {
        tipo: 'erro',
        texto: traduzirErroSupabase(
          error,
          'Não foi possível remover o pagamento bancário selecionado. Tente novamente.',
        ),
      });
    } finally {
      setRegistroExcluindo((prev) => ({ ...prev, banco: null }));
    }
  };

  const handleAtualizarSaldoBancoExistente = async (registro: SaldoBanco) => {
    if (!usuario) return;
    if (!edicaoLiberada) {
      atualizarMensagem('saldo', {
        tipo: 'erro',
        texto: `As edições só podem ser realizadas para o último dia útil (${formatarData(ultimoDiaUtil)}).`,
      });
      return;
    }

    const entrada = saldosBancoEdicao[registro.id] ?? '';
    const valorCalculado = avaliarEntrada(entrada);
    if (valorCalculado === null) {
      atualizarMensagem('saldo', {
        tipo: 'erro',
        texto: 'Informe um saldo numérico para atualizar o banco selecionado.',
      });
      return;
    }

    if (Math.abs(valorCalculado - registro.valor) < 0.01) {
      atualizarMensagem('saldo', {
        tipo: 'info',
        texto: 'O valor informado é igual ao já registrado.',
      });
      return;
    }

    try {
      setRegistroEditando((prev) => ({ ...prev, saldo: registro.id }));
      atualizarMensagem('saldo', null);

      const supabase = getSupabaseClient();
      const { error } = await supabase
        .from('sdb_saldo_banco')
        .update({ sdb_saldo: valorCalculado })
        .eq('sdb_id', registro.id);

      if (error) throw error;

      atualizarMensagem('saldo', {
        tipo: 'sucesso',
        texto: 'Saldo bancário atualizado com sucesso.',
      });
      await recarregarERecalcular(dataReferencia);
    } catch (error) {
      console.error('Erro ao atualizar saldo bancário:', error);
      atualizarMensagem('saldo', {
        tipo: 'erro',
        texto: traduzirErroSupabase(
          error,
          'Não foi possível atualizar o saldo selecionado. Tente novamente.',
        ),
      });
    } finally {
      setRegistroEditando((prev) => ({ ...prev, saldo: null }));
    }
  };

  const handleExcluirSaldoBanco = async (registro: SaldoBanco) => {
    if (!usuario) return;
    if (!edicaoLiberada) {
      atualizarMensagem('saldo', {
        tipo: 'erro',
        texto: `As exclusões só podem ser realizadas para o último dia útil (${formatarData(ultimoDiaUtil)}).`,
      });
      return;
    }

    try {
      setRegistroExcluindo((prev) => ({ ...prev, saldo: registro.id }));
      atualizarMensagem('saldo', null);

      const supabase = getSupabaseClient();
      const { error } = await supabase.from('sdb_saldo_banco').delete().eq('sdb_id', registro.id);
      if (error) throw error;

      atualizarMensagem('saldo', {
        tipo: 'sucesso',
        texto: 'Saldo bancário removido com sucesso.',
      });
      await recarregarERecalcular(dataReferencia);
    } catch (error) {
      console.error('Erro ao excluir saldo bancário:', error);
      atualizarMensagem('saldo', {
        tipo: 'erro',
        texto: traduzirErroSupabase(
          error,
          'Não foi possível remover o saldo selecionado. Tente novamente.',
        ),
      });
    } finally {
      setRegistroExcluindo((prev) => ({ ...prev, saldo: null }));
    }
  };

  // Funções de exclusão em lote
  const abrirConfirmacaoExclusaoLote = (processo: Processo) => {
    let quantidade = 0;
    switch (processo) {
      case 'area':
        quantidade = itensSelecionadosArea.size;
        break;
      case 'receita':
        quantidade = itensSelecionadosReceita.size;
        break;
      case 'banco':
        quantidade = itensSelecionadosBanco.size;
        break;
      case 'saldo':
        quantidade = itensSelecionadosSaldo.size;
        break;
    }

    if (quantidade === 0) return;

    setModalConfirmacao({ aberto: true, processo, quantidade });
  };

  const confirmarExclusaoLote = async () => {
    setModalConfirmacao({ aberto: false, processo: null, quantidade: 0 });

    // Executa as exclusões para todos os cards que têm itens selecionados
    if (itensSelecionadosArea.size > 0) {
      await handleExcluirLotePagamentosArea();
    }
    if (itensSelecionadosReceita.size > 0) {
      await handleExcluirLoteReceitas();
    }
    if (itensSelecionadosBanco.size > 0) {
      await handleExcluirLotePagamentosBanco();
    }
    if (itensSelecionadosSaldo.size > 0) {
      await handleExcluirLoteSaldosBanco();
    }
  };

  const handleExcluirLotePagamentosArea = async () => {
    if (!usuario || itensSelecionadosArea.size === 0) return;
    if (!edicaoLiberada) {
      atualizarMensagem('area', {
        tipo: 'erro',
        texto: `As exclusões só podem ser realizadas para o último dia útil (${formatarData(ultimoDiaUtil)}).`,
      });
      return;
    }

    try {
      setProcessando((prev) => ({ ...prev, area: true }));
      atualizarMensagem('area', null);

      const supabase = getSupabaseClient();
      const ids = Array.from(itensSelecionadosArea);

      const { error } = await supabase
        .from('pag_pagamentos_area')
        .delete()
        .in('pag_id', ids);

      if (error) throw error;

      atualizarMensagem('area', {
        tipo: 'sucesso',
        texto: `${ids.length} pagamento(s) por área removido(s) com sucesso.`,
      });

      setItensSelecionadosArea(new Set());
      await recarregarERecalcular(dataReferencia);
    } catch (error) {
      console.error('Erro ao excluir pagamentos por área:', error);
      atualizarMensagem('area', {
        tipo: 'erro',
        texto: traduzirErroSupabase(
          error,
          'Não foi possível remover os pagamentos selecionados. Tente novamente.',
        ),
      });
    } finally {
      setProcessando((prev) => ({ ...prev, area: false }));
    }
  };

  const handleExcluirLoteReceitas = async () => {
    if (!usuario || itensSelecionadosReceita.size === 0) return;
    if (!edicaoLiberada) {
      atualizarMensagem('receita', {
        tipo: 'erro',
        texto: `As exclusões só podem ser realizadas para o último dia útil (${formatarData(ultimoDiaUtil)}).`,
      });
      return;
    }

    try {
      setProcessando((prev) => ({ ...prev, receita: true }));
      atualizarMensagem('receita', null);

      const supabase = getSupabaseClient();
      const ids = Array.from(itensSelecionadosReceita);

      const { error } = await supabase
        .from('rec_receitas')
        .delete()
        .in('rec_id', ids);

      if (error) throw error;

      atualizarMensagem('receita', {
        tipo: 'sucesso',
        texto: `${ids.length} receita(s) removida(s) com sucesso.`,
      });

      setItensSelecionadosReceita(new Set());
      await recarregarERecalcular(dataReferencia);
    } catch (error) {
      console.error('Erro ao excluir receitas:', error);
      atualizarMensagem('receita', {
        tipo: 'erro',
        texto: traduzirErroSupabase(
          error,
          'Não foi possível remover as receitas selecionadas. Tente novamente.',
        ),
      });
    } finally {
      setProcessando((prev) => ({ ...prev, receita: false }));
    }
  };

  const handleExcluirLotePagamentosBanco = async () => {
    if (!usuario || itensSelecionadosBanco.size === 0) return;
    if (!edicaoLiberada) {
      atualizarMensagem('banco', {
        tipo: 'erro',
        texto: `As exclusões só podem ser realizadas para o último dia útil (${formatarData(ultimoDiaUtil)}).`,
      });
      return;
    }

    try {
      setProcessando((prev) => ({ ...prev, banco: true }));
      atualizarMensagem('banco', null);

      const supabase = getSupabaseClient();
      const ids = Array.from(itensSelecionadosBanco);

      const { error } = await supabase
        .from('pbk_pagamentos_banco')
        .delete()
        .in('pbk_id', ids);

      if (error) throw error;

      atualizarMensagem('banco', {
        tipo: 'sucesso',
        texto: `${ids.length} pagamento(s) por banco removido(s) com sucesso.`,
      });

      setItensSelecionadosBanco(new Set());
      await recarregarERecalcular(dataReferencia);
    } catch (error) {
      console.error('Erro ao excluir pagamentos por banco:', error);
      atualizarMensagem('banco', {
        tipo: 'erro',
        texto: traduzirErroSupabase(
          error,
          'Não foi possível remover os pagamentos selecionados. Tente novamente.',
        ),
      });
    } finally {
      setProcessando((prev) => ({ ...prev, banco: false }));
    }
  };

  const handleExcluirLoteSaldosBanco = async () => {
    if (!usuario || itensSelecionadosSaldo.size === 0) return;
    if (!edicaoLiberada) {
      atualizarMensagem('saldo', {
        tipo: 'erro',
        texto: `As exclusões só podem ser realizadas para o último dia útil (${formatarData(ultimoDiaUtil)}).`,
      });
      return;
    }

    try {
      setProcessando((prev) => ({ ...prev, saldo: true }));
      atualizarMensagem('saldo', null);

      const supabase = getSupabaseClient();
      const ids = Array.from(itensSelecionadosSaldo);

      const { error } = await supabase
        .from('sdb_saldo_banco')
        .delete()
        .in('sdb_id', ids);

      if (error) throw error;

      atualizarMensagem('saldo', {
        tipo: 'sucesso',
        texto: `${ids.length} saldo(s) bancário(s) removido(s) com sucesso.`,
      });

      setItensSelecionadosSaldo(new Set());
      await recarregarERecalcular(dataReferencia);
    } catch (error) {
      console.error('Erro ao excluir saldos bancários:', error);
      atualizarMensagem('saldo', {
        tipo: 'erro',
        texto: traduzirErroSupabase(
          error,
          'Não foi possível remover os saldos selecionados. Tente novamente.',
        ),
      });
    } finally {
      setProcessando((prev) => ({ ...prev, saldo: false }));
    }
  };

  const totalPagamentosArea = useMemo(
    () => pagamentosArea.reduce((sum, p) => sum + Number(p.valor), 0),
    [pagamentosArea]
  );
  const totalReceitas = useMemo(
    () => receitas.reduce((sum, r) => sum + Number(r.valor), 0),
    [receitas]
  );
  const totalPagamentosBanco = useMemo(
    () => pagamentosBanco.reduce((sum, p) => sum + Number(p.valor), 0),
    [pagamentosBanco]
  );
  const totalSaldos = useMemo(
    () => saldosBanco.reduce((sum, s) => sum + Number(s.valor), 0),
    [saldosBanco]
  );
  const totalSaldosDiaAnterior = useMemo(
    () => saldosBancoDiaAnterior.reduce((sum, s) => sum + Number(s.valor), 0),
    [saldosBancoDiaAnterior]
  );

  const totalFormArea = useMemo(
    () =>
      areaOptions.reduce((sum, area) => {
        const valor = avaliarEntrada(pagamentosAreaForm[area.id]);
        return sum + (valor ?? 0);
      }, 0),
    [areaOptions, pagamentosAreaForm]
  );

  const totalFormReceita = useMemo(
    () =>
      contaOptions.reduce((sum, conta) => {
        const valor = avaliarEntrada(receitasForm[conta.id]);
        return sum + (valor ?? 0);
      }, 0),
    [contaOptions, receitasForm]
  );

  const totalFormPagBanco = useMemo(
    () =>
      bancoOptions.reduce((sum, banco) => {
        const valor = avaliarEntrada(pagamentosBancoForm[banco.id]);
        return sum + (valor ?? 0);
      }, 0),
    [bancoOptions, pagamentosBancoForm]
  );

  const totalFormSaldoBanco = useMemo(
    () =>
      bancoOptions.reduce((sum, banco) => {
        const valor = avaliarEntrada(saldosBancoForm[banco.id]);
        return sum + (valor ?? 0);
      }, 0),
    [bancoOptions, saldosBancoForm]
  );

  const pagamentosAreaPorAreaId = useMemo(() => {
    const mapa = new Map<number, PagamentoArea>();
    pagamentosArea.forEach((registro) => {
      if (registro.areaId) {
        mapa.set(registro.areaId, registro);
      }
    });
    return mapa;
  }, [pagamentosArea]);

  const receitasPorContaId = useMemo(() => {
    const mapa = new Map<number, Receita>();
    receitas.forEach((registro) => {
      if (registro.contaId) {
        mapa.set(registro.contaId, registro);
      }
    });
    return mapa;
  }, [receitas]);

  const pagamentosBancoPorBancoId = useMemo(() => {
    const mapa = new Map<number, PagamentoBanco>();
    pagamentosBanco.forEach((registro) => {
      if (registro.bancoId) {
        mapa.set(registro.bancoId, registro);
      }
    });
    return mapa;
  }, [pagamentosBanco]);

  const saldosBancoPorBancoId = useMemo(() => {
    const mapa = new Map<number, SaldoBanco>();
    saldosBanco.forEach((registro) => {
      if (registro.bancoId) {
        mapa.set(registro.bancoId, registro);
      }
    });
    return mapa;
  }, [saldosBanco]);

  const helperValor = (valor: string | undefined): string | undefined => {
    const resultado = avaliarEntrada(valor);
    return resultado !== null ? `Resultado: ${formatCurrency(resultado)}` : undefined;
  };

  // Separar contas por código
  const contasTitulos = useMemo(() => contaOptions.filter(c => c.codigo === '200'), [contaOptions]);
  const contasDepositosPix = useMemo(() => contaOptions.filter(c => c.codigo === '201'), [contaOptions]);
  const contasOutras = useMemo(() => contaOptions.filter(c => c.codigo !== '200' && c.codigo !== '201'), [contaOptions]);

  // Resumos
  const resumoPorBanco = useMemo(() => {
    const resumo = new Map<number, { banco: string; total: number }>();
    receitas.forEach(rec => {
      const conta = contaOptions.find(c => c.id === rec.contaId);
      if (conta) {
        // Aqui você precisaria ter o banco_id na conta para agrupar
        // Por enquanto vamos apenas criar estrutura básica
      }
    });
    return resumo;
  }, [receitas, contaOptions]);

  const resumoPorTipoReceita = useMemo(() => {
    const resumo = new Map<string, { tipo: string; total: number }>();
    receitas.forEach(rec => {
      const conta = contaOptions.find(c => c.id === rec.contaId);
      if (conta) {
        const tipo = conta.codigo === '200' ? 'Títulos (200)' : conta.codigo === '201' ? 'Depósitos e PIX (201)' : 'Outros';
        const atual = resumo.get(tipo) || { tipo, total: 0 };
        resumo.set(tipo, { tipo, total: atual.total + rec.valor });
      }
    });
    return Array.from(resumo.values());
  }, [receitas, contaOptions]);

  if (carregando) {
    return (
      <>
        <Header title="Movimentação Diária" />
        <div className="page-content flex items-center justify-center h-96">
          <Loading size="lg" text="Carregando dados..." />
        </div>
      </>
    );
  }

  return (
    <>
      <Header
        title="Movimentação Diária"
        subtitle={`Operação referenciada em ${formatarData(dataReferencia)}`}
        actions={
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
            <Input
              type="date"
              value={dataReferencia}
              onChange={(event) => setDataReferencia(event.target.value)}
            />
            <Button variant="secondary" onClick={handleAtualizar} loading={atualizando}>
              Atualizar
            </Button>
            {(itensSelecionadosArea.size > 0 || itensSelecionadosReceita.size > 0 || itensSelecionadosBanco.size > 0 || itensSelecionadosSaldo.size > 0) && (
              <Button
                type="button"
                variant="danger"
                onClick={() => {
                  const total = itensSelecionadosArea.size + itensSelecionadosReceita.size + itensSelecionadosBanco.size + itensSelecionadosSaldo.size;
                  setModalConfirmacao({ aberto: true, processo: 'area', quantidade: total });
                }}
                disabled={!edicaoLiberada}
              >
                Excluir Selecionados ({itensSelecionadosArea.size + itensSelecionadosReceita.size + itensSelecionadosBanco.size + itensSelecionadosSaldo.size})
              </Button>
            )}
          </div>
        }
      />

      <div className="page-content space-y-6">
        {erro && (
          <div className="rounded-md border border-error-200 bg-error-50 px-4 py-3 text-error-700">
            {erro}
          </div>
        )}

        {!edicaoLiberada && (
          <div className="rounded-md border border-warning-200 bg-warning-50 px-4 py-3">
            <div className="flex items-start gap-2">
              <svg className="h-5 w-5 text-warning-600 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
              </svg>
              <div>
                <p className="font-semibold text-warning-800">Período bloqueado para edição</p>
                <p className="text-warning-700 mt-1">{motivoBloqueio}</p>
              </div>
            </div>
          </div>
        )}

        {edicaoLiberada && motivoBloqueio && (
          <div className="rounded-md border border-green-200 bg-green-50 px-4 py-3">
            <div className="flex items-start gap-2">
              <svg className="h-5 w-5 text-green-600 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
              </svg>
              <div>
                <p className="font-semibold text-green-800">Período liberado</p>
                <p className="text-green-700 mt-1">{motivoBloqueio}</p>
              </div>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-lg border border-gray-200 bg-white/80 p-3 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Saldo Inicial</p>
            <p className="mt-2 text-xl font-semibold text-gray-900">{formatCurrency(totalSaldosDiaAnterior)}</p>
            <p className="mt-1 text-xs text-gray-400">Soma dos saldos dos bancos do dia anterior</p>
          </div>
          <div className="rounded-lg border border-gray-200 bg-white/80 p-3 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Receitas</p>
            <p className="mt-2 text-xl font-semibold text-gray-900">{formatCurrency(totalReceitas)}</p>
            <p className="mt-1 text-xs text-gray-400">Entradas do dia</p>
          </div>
          <div className="rounded-lg border border-gray-200 bg-white/80 p-3 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Pagamentos</p>
            <p className="mt-2 text-xl font-semibold text-gray-900">{formatCurrency(totalPagamentosArea)}</p>
            <p className="mt-1 text-xs text-gray-400">Pagamentos por área (ignora pagamentos por banco)</p>
          </div>
          <div className="rounded-lg border border-gray-200 bg-white/80 p-3 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Saldo Final</p>
            <p className="mt-2 text-xl font-semibold text-gray-900">{formatCurrency(totalSaldos)}</p>
            <p className="mt-1 text-xs text-gray-400">Saldo final do dia</p>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          <Card title="Pagamentos por Área" subtitle={`Total registrado: ${formatCurrency(totalPagamentosArea)}`} variant="primary">
            <div className="space-y-5">
              <form className="space-y-4" onSubmit={handleRegistrarPagamentosArea}>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setPagamentosAreaForm(sincronizarMapa(areaOptions, {}));
                        limparMensagem('area');
                      }}
                      disabled={processando.area || areaOptions.length === 0}
                    >
                      Limpar campos
                    </Button>
                    <Button
                      type="submit"
                      variant="primary"
                      size="sm"
                      loading={processando.area}
                      disabled={areaOptions.length === 0 || !edicaoLiberada}
                    >
                      Registrar pagamentos
                    </Button>
                  </div>
                  <div className="rounded-md border border-dashed border-primary-200 bg-primary-50/40 px-4 py-2 text-sm text-primary-800">
                    <span>Total a registrar: </span>
                    <strong>{formatCurrency(totalFormArea)}</strong>
                  </div>
                </div>

                <div className="overflow-x-auto rounded-lg border border-gray-200">
                  <table className="min-w-full divide-y divide-gray-200 text-sm">
                    <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                      <tr>
                        <th className="px-4 py-3 text-center font-semibold w-12">
                          <input
                            type="checkbox"
                            checked={pagamentosArea.length > 0 && itensSelecionadosArea.size === pagamentosArea.length}
                            onChange={(e) => {
                              if (e.target.checked) {
                                setItensSelecionadosArea(new Set(pagamentosArea.map(p => p.id)));
                              } else {
                                setItensSelecionadosArea(new Set());
                              }
                            }}
                            className="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                            disabled={!edicaoLiberada || pagamentosArea.length === 0}
                          />
                        </th>
                        <th className="px-4 py-3 text-left font-semibold">Área</th>
                        <th className="px-4 py-3 text-left font-semibold w-52">Valor / Expressão</th>
                        <th className="px-4 py-3 text-left font-semibold min-w-[280px]">Registrado</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 bg-white/80">
                      {areaOptions.length === 0 ? (
                        <tr>
                          <td colSpan={4} className="px-4 py-6 text-center text-sm text-gray-500">
                            Cadastre áreas no menu Cadastros &gt; Áreas para liberar esta seção.
                          </td>
                        </tr>
                      ) : (
                        areaOptionsOrdenadas.map((area) => {
                          const registro = pagamentosAreaPorAreaId.get(area.id);
                          return (
                            <tr key={area.id}>
                              <td className="px-4 py-3 text-center">
                                {registro && (
                                  <input
                                    type="checkbox"
                                    checked={itensSelecionadosArea.has(registro.id)}
                                    onChange={(e) => {
                                      const novoSet = new Set(itensSelecionadosArea);
                                      if (e.target.checked) {
                                        novoSet.add(registro.id);
                                      } else {
                                        novoSet.delete(registro.id);
                                      }
                                      setItensSelecionadosArea(novoSet);
                                    }}
                                    className="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                                    disabled={!edicaoLiberada || emEdicaoArea.has(registro.id)}
                                  />
                                )}
                              </td>
                              <td className="px-4 py-3 font-medium text-gray-700">{area.nome}</td>
                              <td className="px-4 py-3 align-top">
                                <Input
                                  type="text"
                                  inputMode="decimal"
                                  placeholder={registro ? "Clique em editar" : "Ex.: 10+20+30"}
                                  value={pagamentosAreaForm[area.id] ?? ''}
                                  onChange={(event) =>
                                    setPagamentosAreaForm((prev) => ({
                                      ...prev,
                                      [area.id]: event.target.value,
                                    }))
                                  }
                                  disabled={processando.area || !edicaoLiberada || !!registro}
                                  helperText={!registro ? helperValor(pagamentosAreaForm[area.id]) : undefined}
                                  fullWidth
                                />
                              </td>
                              <td className="px-4 py-3 align-top">
                                {registro ? (
                                  <div className="space-y-2">
                                    {emEdicaoArea.has(registro.id) ? (
                                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                                        <Input
                                          type="text"
                                          inputMode="decimal"
                                          value={pagamentosAreaEdicao[registro.id] ?? ''}
                                          onChange={(event) =>
                                            setPagamentosAreaEdicao((prev) => ({
                                              ...prev,
                                              [registro.id]: event.target.value,
                                            }))
                                          }
                                          disabled={
                                            !edicaoLiberada ||
                                            registroEditando.area === registro.id ||
                                            registroExcluindo.area === registro.id
                                          }
                                          helperText={helperValor(pagamentosAreaEdicao[registro.id])}
                                          className="sm:w-44"
                                        />
                                        <div className="flex gap-2">
                                          <Button
                                            type="button"
                                            variant="secondary"
                                            size="sm"
                                            onClick={() => handleAtualizarPagamentoAreaExistente(registro)}
                                            disabled={!edicaoLiberada}
                                            loading={registroEditando.area === registro.id}
                                          >
                                            Salvar edição
                                          </Button>
                                          <Button
                                            type="button"
                                            variant="ghost"
                                            size="sm"
                                            onClick={() => {
                                              setEmEdicaoArea(prev => {
                                                const novo = new Set(prev);
                                                novo.delete(registro.id);
                                                return novo;
                                              });
                                              setPagamentosAreaEdicao((prev) => {
                                                const novo = { ...prev };
                                                delete novo[registro.id];
                                                return novo;
                                              });
                                            }}
                                            disabled={registroEditando.area === registro.id}
                                          >
                                            Cancelar
                                          </Button>
                                        </div>
                                      </div>
                                    ) : (
                                      <div className="flex items-start justify-between gap-2">
                                        <span className="font-semibold text-primary-700">
                                          {formatCurrency(registro.valor)}
                                        </span>
                                        <Button
                                          type="button"
                                          variant="secondary"
                                          size="sm"
                                          onClick={() => {
                                            setEmEdicaoArea(prev => new Set(prev).add(registro.id));
                                            setPagamentosAreaEdicao((prev) => ({
                                              ...prev,
                                              [registro.id]: formatarValorParaInput(registro.valor),
                                            }));
                                          }}
                                          disabled={!edicaoLiberada}
                                        >
                                          Editar
                                        </Button>
                                      </div>
                                    )}
                                  </div>
                                ) : (
                                  <span className="text-sm text-gray-400">Nenhum valor registrado</span>
                                )}
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>

                {mensagens.area && (
                  <div
                    className={`rounded-md border px-4 py-2 text-sm ${
                      mensagens.area.tipo === 'sucesso'
                        ? 'border-success-200 bg-success-50 text-success-700'
                        : mensagens.area.tipo === 'erro'
                        ? 'border-error-200 bg-error-50 text-error-700'
                        : 'border-primary-200 bg-primary-50 text-primary-800'
                    }`}
                  >
                    {mensagens.area.texto}
                  </div>
                )}
              </form>

            </div>
          </Card>
          <Card title="Pagamentos por Banco" subtitle={`Total registrado: ${formatCurrency(totalPagamentosBanco)}`} variant="danger">
            <div className="space-y-5">
              <form className="space-y-4" onSubmit={handleRegistrarPagamentosBanco}>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setPagamentosBancoForm(sincronizarMapa(bancoOptions, {}));
                        limparMensagem('banco');
                      }}
                      disabled={processando.banco || bancoOptions.length === 0}
                    >
                      Limpar campos
                    </Button>
                    <Button
                      type="submit"
                      variant="primary"
                      size="sm"
                      loading={processando.banco}
                      disabled={bancoOptions.length === 0 || !edicaoLiberada}
                    >
                      Registrar pagamentos
                    </Button>
                  </div>
                  <div className="rounded-md border border-dashed border-error-200 bg-error-50/50 px-4 py-2 text-sm text-error-700">
                    <span>Total a registrar: </span>
                    <strong>{formatCurrency(totalFormPagBanco)}</strong>
                  </div>
                </div>

                <div className="overflow-x-auto rounded-lg border border-gray-200">
                  <table className="min-w-full divide-y divide-gray-200 text-sm">
                    <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                      <tr>
                        <th className="px-4 py-3 text-center font-semibold w-12">
                          <input
                            type="checkbox"
                            checked={pagamentosBanco.length > 0 && itensSelecionadosBanco.size === pagamentosBanco.length}
                            onChange={(e) => {
                              if (e.target.checked) {
                                setItensSelecionadosBanco(new Set(pagamentosBanco.map(p => p.id)));
                              } else {
                                setItensSelecionadosBanco(new Set());
                              }
                            }}
                            className="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                            disabled={!edicaoLiberada || pagamentosBanco.length === 0}
                          />
                        </th>
                        <th className="px-4 py-3 text-left font-semibold">Banco</th>
                        <th className="px-4 py-3 text-left font-semibold w-52">Valor / Expressão</th>
                        <th className="px-4 py-3 text-left font-semibold min-w-[280px]">Registrado</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 bg-white/80">
                      {bancoOptions.length === 0 ? (
                        <tr>
                          <td colSpan={4} className="px-4 py-6 text-center text-sm text-gray-500">
                            Cadastre bancos no menu Cadastros &gt; Bancos para liberar esta seção.
                          </td>
                        </tr>
                      ) : (
                        bancoOptions.map((banco) => {
                          const registro = pagamentosBancoPorBancoId.get(banco.id);
                          return (
                            <tr key={banco.id}>
                              <td className="px-4 py-3 text-center">
                                {registro && (
                                  <input
                                    type="checkbox"
                                    checked={itensSelecionadosBanco.has(registro.id)}
                                    onChange={(e) => {
                                      const novoSet = new Set(itensSelecionadosBanco);
                                      if (e.target.checked) {
                                        novoSet.add(registro.id);
                                      } else {
                                        novoSet.delete(registro.id);
                                      }
                                      setItensSelecionadosBanco(novoSet);
                                    }}
                                    className="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                                    disabled={!edicaoLiberada || emEdicaoPagamentoBanco.has(registro.id)}
                                  />
                                )}
                              </td>
                              <td className="px-4 py-3 font-medium text-gray-700">{banco.nome}</td>
                              <td className="px-4 py-3 align-top">
                                <Input
                                  type="text"
                                  inputMode="decimal"
                                  placeholder={registro ? "Clique em editar" : "Ex.: 1200/3"}
                                  value={pagamentosBancoForm[banco.id] ?? ''}
                                  onChange={(event) =>
                                    setPagamentosBancoForm((prev) => ({
                                      ...prev,
                                      [banco.id]: event.target.value,
                                    }))
                                  }
                                  disabled={processando.banco || !edicaoLiberada || !!registro}
                                  helperText={!registro ? helperValor(pagamentosBancoForm[banco.id]) : undefined}
                                  fullWidth
                                />
                              </td>
                              <td className="px-4 py-3 align-top">
                                {registro ? (
                                  <div className="space-y-2">
                                    {emEdicaoPagamentoBanco.has(registro.id) ? (
                                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                                        <Input
                                          type="text"
                                          inputMode="decimal"
                                          value={pagamentosBancoEdicao[registro.id] ?? ''}
                                          onChange={(event) =>
                                            setPagamentosBancoEdicao((prev) => ({
                                              ...prev,
                                              [registro.id]: event.target.value,
                                            }))
                                          }
                                          disabled={
                                            !edicaoLiberada ||
                                            registroEditando.banco === registro.id ||
                                            registroExcluindo.banco === registro.id
                                          }
                                          helperText={helperValor(pagamentosBancoEdicao[registro.id])}
                                          className="sm:w-44"
                                        />
                                        <div className="flex gap-2">
                                          <Button
                                            type="button"
                                            variant="secondary"
                                            size="sm"
                                            onClick={() => handleAtualizarPagamentoBancoExistente(registro)}
                                            disabled={!edicaoLiberada}
                                            loading={registroEditando.banco === registro.id}
                                          >
                                            Salvar edição
                                          </Button>
                                          <Button
                                            type="button"
                                            variant="ghost"
                                            size="sm"
                                            onClick={() => {
                                              setEmEdicaoPagamentoBanco(prev => {
                                                const novo = new Set(prev);
                                                novo.delete(registro.id);
                                                return novo;
                                              });
                                              setPagamentosBancoEdicao((prev) => {
                                                const novo = { ...prev };
                                                delete novo[registro.id];
                                                return novo;
                                              });
                                            }}
                                            disabled={registroEditando.banco === registro.id}
                                          >
                                            Cancelar
                                          </Button>
                                        </div>
                                      </div>
                                    ) : (
                                      <div className="flex items-start justify-between gap-2">
                                        <span className="font-semibold text-error-700">
                                          {formatCurrency(registro.valor)}
                                        </span>
                                        <Button
                                          type="button"
                                          variant="secondary"
                                          size="sm"
                                          onClick={() => {
                                            setEmEdicaoPagamentoBanco(prev => new Set(prev).add(registro.id));
                                            setPagamentosBancoEdicao((prev) => ({
                                              ...prev,
                                              [registro.id]: formatarValorParaInput(registro.valor),
                                            }));
                                          }}
                                          disabled={!edicaoLiberada}
                                        >
                                          Editar
                                        </Button>
                                      </div>
                                    )}
                                  </div>
                                ) : (
                                  <span className="text-sm text-gray-400">Nenhum valor registrado</span>
                                )}
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>

                {mensagens.banco && (
                  <div
                    className={`rounded-md border px-4 py-2 text-sm ${
                      mensagens.banco.tipo === 'sucesso'
                        ? 'border-success-200 bg-success-50 text-success-700'
                        : mensagens.banco.tipo === 'erro'
                        ? 'border-error-200 bg-error-50 text-error-700'
                        : 'border-primary-200 bg-primary-50 text-primary-800'
                    }`}
                  >
                    {mensagens.banco.texto}
                  </div>
                )}
              </form>

            </div>
          </Card>
          <Card title="Receitas" subtitle={`Total registrado: ${formatCurrency(totalReceitas)}`} variant="success">
            <div className="space-y-5">
              <form className="space-y-4" onSubmit={handleRegistrarReceitas}>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setReceitasForm(sincronizarMapa(contaOptions, {}));
                        limparMensagem('receita');
                      }}
                      disabled={processando.receita || contaOptions.length === 0}
                    >
                      Limpar campos
                    </Button>
                    <Button
                      type="submit"
                      variant="primary"
                      size="sm"
                      loading={processando.receita}
                      disabled={contaOptions.length === 0 || !edicaoLiberada}
                    >
                      Registrar receitas
                    </Button>
                  </div>
                  <div className="rounded-md border border-dashed border-success-200 bg-success-50/40 px-4 py-2 text-sm text-success-800">
                    <span>Total a registrar: </span>
                    <strong>{formatCurrency(totalFormReceita)}</strong>
                  </div>
                </div>

                <div className="overflow-x-auto rounded-lg border border-gray-200">
                  <table className="min-w-full divide-y divide-gray-200 text-sm">
                    <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                      <tr>
                        <th className="px-4 py-3 text-center font-semibold w-12">
                          <input
                            type="checkbox"
                            checked={receitas.length > 0 && itensSelecionadosReceita.size === receitas.length}
                            onChange={(e) => {
                              if (e.target.checked) {
                                setItensSelecionadosReceita(new Set(receitas.map(r => r.id)));
                              } else {
                                setItensSelecionadosReceita(new Set());
                              }
                            }}
                            className="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                            disabled={!edicaoLiberada || receitas.length === 0}
                          />
                        </th>
                        <th className="px-4 py-3 text-left font-semibold">Conta de receita</th>
                        <th className="px-4 py-3 text-left font-semibold w-52">Valor / Expressão</th>
                        <th className="px-4 py-3 text-left font-semibold min-w-[280px]">Registrado</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 bg-white/80">
                      {contaOptions.length === 0 ? (
                        <tr>
                          <td colSpan={4} className="px-4 py-6 text-center text-sm text-gray-500">
                            Cadastre contas em Cadastros &gt; Contas de Receita para liberar esta seção.
                          </td>
                        </tr>
                      ) : (
                        contaOptions.map((conta) => {
                          const registro = receitasPorContaId.get(conta.id);
                          return (
                            <tr key={conta.id}>
                              <td className="px-4 py-3 text-center">
                                {registro && (
                                  <input
                                    type="checkbox"
                                    checked={itensSelecionadosReceita.has(registro.id)}
                                    onChange={(e) => {
                                      const novoSet = new Set(itensSelecionadosReceita);
                                      if (e.target.checked) {
                                        novoSet.add(registro.id);
                                      } else {
                                        novoSet.delete(registro.id);
                                      }
                                      setItensSelecionadosReceita(novoSet);
                                    }}
                                    className="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                                    disabled={!edicaoLiberada || emEdicaoReceita.has(registro.id)}
                                  />
                                )}
                              </td>
                              <td className="px-4 py-3 font-medium text-gray-700">{conta.nome}</td>
                              <td className="px-4 py-3 align-top">
                                <Input
                                  type="text"
                                  inputMode="decimal"
                                  placeholder={registro ? "Clique em editar" : "Ex.: 500-125"}
                                  value={receitasForm[conta.id] ?? ''}
                                  onChange={(event) =>
                                    setReceitasForm((prev) => ({
                                      ...prev,
                                      [conta.id]: event.target.value,
                                    }))
                                  }
                                  disabled={processando.receita || !edicaoLiberada || !!registro}
                                  helperText={!registro ? helperValor(receitasForm[conta.id]) : undefined}
                                  fullWidth
                                />
                              </td>
                              <td className="px-4 py-3 align-top">
                                {registro ? (
                                  <div className="space-y-2">
                                    {emEdicaoReceita.has(registro.id) ? (
                                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                                        <Input
                                          type="text"
                                          inputMode="decimal"
                                          value={receitasEdicao[registro.id] ?? ''}
                                          onChange={(event) =>
                                            setReceitasEdicao((prev) => ({
                                              ...prev,
                                              [registro.id]: event.target.value,
                                            }))
                                          }
                                          disabled={
                                            !edicaoLiberada ||
                                            registroEditando.receita === registro.id ||
                                            registroExcluindo.receita === registro.id
                                          }
                                          helperText={helperValor(receitasEdicao[registro.id])}
                                          className="sm:w-44"
                                        />
                                        <div className="flex gap-2">
                                          <Button
                                            type="button"
                                            variant="secondary"
                                            size="sm"
                                            onClick={() => handleAtualizarReceitaExistente(registro)}
                                            disabled={!edicaoLiberada}
                                            loading={registroEditando.receita === registro.id}
                                          >
                                            Salvar edição
                                          </Button>
                                          <Button
                                            type="button"
                                            variant="ghost"
                                            size="sm"
                                            onClick={() => {
                                              setEmEdicaoReceita(prev => {
                                                const novo = new Set(prev);
                                                novo.delete(registro.id);
                                                return novo;
                                              });
                                              setReceitasEdicao((prev) => {
                                                const novo = { ...prev };
                                                delete novo[registro.id];
                                                return novo;
                                              });
                                            }}
                                            disabled={registroEditando.receita === registro.id}
                                          >
                                            Cancelar
                                          </Button>
                                        </div>
                                      </div>
                                    ) : (
                                      <div className="flex items-start justify-between gap-2">
                                        <span className="font-semibold text-success-700">
                                          {formatCurrency(registro.valor)}
                                        </span>
                                        <Button
                                          type="button"
                                          variant="secondary"
                                          size="sm"
                                          onClick={() => {
                                            setEmEdicaoReceita(prev => new Set(prev).add(registro.id));
                                            setReceitasEdicao((prev) => ({
                                              ...prev,
                                              [registro.id]: formatarValorParaInput(registro.valor),
                                            }));
                                          }}
                                          disabled={!edicaoLiberada}
                                        >
                                          Editar
                                        </Button>
                                      </div>
                                    )}
                                  </div>
                                ) : (
                                  <span className="text-sm text-gray-400">Nenhum valor registrado</span>
                                )}
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>

                {mensagens.receita && (
                  <div
                    className={`rounded-md border px-4 py-2 text-sm ${
                      mensagens.receita.tipo === 'sucesso'
                        ? 'border-success-200 bg-success-50 text-success-700'
                        : mensagens.receita.tipo === 'erro'
                        ? 'border-error-200 bg-error-50 text-error-700'
                        : 'border-primary-200 bg-primary-50 text-primary-800'
                    }`}
                  >
                    {mensagens.receita.texto}
                  </div>
                )}
              </form>

            </div>
          </Card>

          <Card title="Saldo por Banco" subtitle={`Total registrado: ${formatCurrency(totalSaldos)}`} variant="default">
            <div className="space-y-5">
              <form className="space-y-4" onSubmit={handleRegistrarSaldosBanco}>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setSaldosBancoForm(sincronizarMapa(bancoOptions, {}));
                        limparMensagem('saldo');
                      }}
                      disabled={processando.saldo || bancoOptions.length === 0}
                    >
                      Limpar campos
                    </Button>
                    <Button
                      type="submit"
                      variant="primary"
                      size="sm"
                      loading={processando.saldo}
                      disabled={bancoOptions.length === 0 || !edicaoLiberada}
                    >
                      Atualizar saldos
                    </Button>
                  </div>
                  <div className="rounded-md border border-dashed border-gray-300 bg-gray-50 px-4 py-2 text-sm text-gray-700">
                    <span>Total informado: </span>
                    <strong>{formatCurrency(totalFormSaldoBanco)}</strong>
                  </div>
                </div>

                <div className="overflow-x-auto rounded-lg border border-gray-200">
                  <table className="min-w-full divide-y divide-gray-200 text-sm">
                    <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                      <tr>
                        <th className="px-4 py-3 text-center font-semibold w-12">
                          <input
                            type="checkbox"
                            checked={saldosBanco.length > 0 && itensSelecionadosSaldo.size === saldosBanco.length}
                            onChange={(e) => {
                              if (e.target.checked) {
                                setItensSelecionadosSaldo(new Set(saldosBanco.map(s => s.id)));
                              } else {
                                setItensSelecionadosSaldo(new Set());
                              }
                            }}
                            className="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                            disabled={!edicaoLiberada || saldosBanco.length === 0}
                          />
                        </th>
                        <th className="px-4 py-3 text-left font-semibold">Banco</th>
                        <th className="px-4 py-3 text-left font-semibold w-52">Saldo / Expressão</th>
                        <th className="px-4 py-3 text-left font-semibold min-w-[280px]">Registrado</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 bg-white/80">
                      {bancoOptions.length === 0 ? (
                        <tr>
                          <td colSpan={4} className="px-4 py-6 text-center text-sm text-gray-500">
                            Cadastre bancos no menu Cadastros &gt; Bancos para liberar esta seção.
                          </td>
                        </tr>
                      ) : (
                        bancoOptions.map((banco) => {
                          const registro = saldosBancoPorBancoId.get(banco.id);
                          return (
                            <tr key={banco.id}>
                              <td className="px-4 py-3 text-center">
                                {registro && (
                                  <input
                                    type="checkbox"
                                    checked={itensSelecionadosSaldo.has(registro.id)}
                                    onChange={(e) => {
                                      const novoSet = new Set(itensSelecionadosSaldo);
                                      if (e.target.checked) {
                                        novoSet.add(registro.id);
                                      } else {
                                        novoSet.delete(registro.id);
                                      }
                                      setItensSelecionadosSaldo(novoSet);
                                    }}
                                    className="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                                    disabled={!edicaoLiberada || emEdicaoSaldoBanco.has(registro.id)}
                                  />
                                )}
                              </td>
                              <td className="px-4 py-3 font-medium text-gray-700">{banco.nome}</td>
                              <td className="px-4 py-3 align-top">
                                <Input
                                  type="text"
                                  inputMode="decimal"
                                  placeholder={registro ? "Clique em editar" : "Ex.: 1000-250"}
                                  value={saldosBancoForm[banco.id] ?? ''}
                                  onChange={(event) =>
                                    setSaldosBancoForm((prev) => ({
                                      ...prev,
                                      [banco.id]: event.target.value,
                                    }))
                                  }
                                  disabled={processando.saldo || !edicaoLiberada || !!registro}
                                  helperText={!registro ? helperValor(saldosBancoForm[banco.id]) : undefined}
                                  fullWidth
                                />
                              </td>
                              <td className="px-4 py-3 align-top">
                                {registro ? (
                                  <div className="space-y-2">
                                    {emEdicaoSaldoBanco.has(registro.id) ? (
                                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                                        <Input
                                          type="text"
                                          inputMode="decimal"
                                          value={saldosBancoEdicao[registro.id] ?? ''}
                                          onChange={(event) =>
                                            setSaldosBancoEdicao((prev) => ({
                                              ...prev,
                                              [registro.id]: event.target.value,
                                            }))
                                          }
                                          disabled={
                                            !edicaoLiberada ||
                                            registroEditando.saldo === registro.id ||
                                            registroExcluindo.saldo === registro.id
                                          }
                                          helperText={helperValor(saldosBancoEdicao[registro.id])}
                                          className="sm:w-44"
                                        />
                                        <div className="flex gap-2">
                                          <Button
                                            type="button"
                                            variant="secondary"
                                            size="sm"
                                            onClick={() => handleAtualizarSaldoBancoExistente(registro)}
                                            disabled={!edicaoLiberada}
                                            loading={registroEditando.saldo === registro.id}
                                          >
                                            Salvar edição
                                          </Button>
                                          <Button
                                            type="button"
                                            variant="ghost"
                                            size="sm"
                                            onClick={() => {
                                              setEmEdicaoSaldoBanco(prev => {
                                                const novo = new Set(prev);
                                                novo.delete(registro.id);
                                                return novo;
                                              });
                                              setSaldosBancoEdicao((prev) => {
                                                const novo = { ...prev };
                                                delete novo[registro.id];
                                                return novo;
                                              });
                                            }}
                                            disabled={registroEditando.saldo === registro.id}
                                          >
                                            Cancelar
                                          </Button>
                                        </div>
                                      </div>
                                    ) : (
                                      <div className="flex items-start justify-between gap-2">
                                        <span
                                          className={`font-semibold ${
                                            registro.valor >= 0 ? 'text-success-700' : 'text-error-700'
                                          }`}
                                        >
                                          {formatCurrency(registro.valor)}
                                        </span>
                                        <Button
                                          type="button"
                                          variant="secondary"
                                          size="sm"
                                          onClick={() => {
                                            setEmEdicaoSaldoBanco(prev => new Set(prev).add(registro.id));
                                            setSaldosBancoEdicao((prev) => ({
                                              ...prev,
                                              [registro.id]: formatarValorParaInput(registro.valor),
                                            }));
                                          }}
                                          disabled={!edicaoLiberada}
                                        >
                                          Editar
                                        </Button>
                                      </div>
                                    )}
                                  </div>
                                ) : (
                                  <span className="text-sm text-gray-400">Nenhum saldo registrado</span>
                                )}
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>

                {mensagens.saldo && (
                  <div
                    className={`rounded-md border px-4 py-2 text-sm ${
                      mensagens.saldo.tipo === 'sucesso'
                        ? 'border-success-200 bg-success-50 text-success-700'
                        : mensagens.saldo.tipo === 'erro'
                        ? 'border-error-200 bg-error-50 text-error-700'
                        : 'border-primary-200 bg-primary-50 text-primary-800'
                    }`}
                  >
                    {mensagens.saldo.texto}
                  </div>
                )}
              </form>

            </div>
          </Card>
        </div>
      </div>

      <ConfirmModal
        isOpen={modalConfirmacao.aberto}
        onClose={() => setModalConfirmacao({ aberto: false, processo: null, quantidade: 0 })}
        onConfirm={confirmarExclusaoLote}
        title="Confirmar exclusão em lote"
        message={`Tem certeza que deseja excluir ${modalConfirmacao.quantidade} registro(s) selecionado(s)? Esta ação não pode ser desfeita.`}
        confirmText="Excluir"
        cancelText="Cancelar"
        variant="danger"
      />
    </>
  );
};

export default SaldoDiarioPage;
