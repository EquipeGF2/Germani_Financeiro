'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Header } from '@/components/layout';
import { Button, Card, Loading } from '@/components/ui';
import { formatCurrency } from '@/lib/mathParser';
import { loadSheetJS } from '@/lib/sheetjsLoader';
import {
  getOrCreateUser,
  getSupabaseClient,
  type UsuarioRow,
} from '@/lib/supabaseClient';
import { traduzirErroSupabase } from '@/lib/supabaseErrors';
import { getUserSession } from '@/lib/userSession';

const RECEITA_CODIGOS: Record<string, string> = {
  'deposito e pix': '201',
  'antecipado': '201',
  'boleto': '200',
  'cartao debito': '202',
  'cartao débito': '202',
  'cartão debito': '202',
  'cartão débito': '202',
  'a vista': '202',
  'à vista': '202',
};

const RECEITA_PADROES: { padrao: RegExp; codigo: string }[] = [
  { padrao: /(deposito|depósito)/, codigo: '201' },
  { padrao: /pix/, codigo: '201' },
  { padrao: /antecipad/, codigo: '201' },
  { padrao: /boleto/, codigo: '200' },
  { padrao: /cartao|cartão|debito|débito/, codigo: '202' },
  { padrao: /\bvista\b/, codigo: '202' },
];

const TITULO_CORRECOES: Record<string, string> = {
  'com materail e consumo': 'material e consumo',
  'com material e consumo': 'material e consumo',
  'gasto com material e consumo': 'material e consumo',
  'materail e consumo': 'material e consumo',
  'materiail e consumo': 'material e consumo',
  'material consumo': 'material e consumo',
  'gastos material e consumo': 'material e consumo',
  'gastos com material e consumo': 'material e consumo',
};

const TIPO_RECEITA_PREFERENCIAS: Record<string, string> = {
  'deposito e pix': 'receita prevista',
  'deposito e pix vero varejo': 'receita prevista',
  'antecipado': 'receita prevista',
  'antecipado vero varejo': 'receita prevista',
  'boleto': 'receita prevista',
  'cartao debito vero varejo': 'outros',
  'cartao debito vero': 'outros',
  'cartao debito': 'outros',
  'a vista': 'outros',
  'vista': 'outros',
};

const TIPO_RECEITA_PADROES: { padrao: RegExp; nome: string }[] = [
  { padrao: /(deposito|depósito).*pix/, nome: 'receita prevista' },
  { padrao: /antecipad/, nome: 'receita prevista' },
  { padrao: /boleto/, nome: 'receita prevista' },
  { padrao: /cartao|cartão|debito|débito.*vero.*varejo/, nome: 'outros' },
  { padrao: /\ba vista\b|\bà vista\b|avista/, nome: 'outros' },
];

type AreaOption = { id: number; nome: string; normalizado: string };
type ContaOption = {
  id: number;
  nome: string;
  codigo: string;
  bancoId: number | null;
  bancoNome: string | null;
  normalizado: string;
};
type TipoReceitaOption = { id: number; nome: string; normalizado: string };
type BancoOption = { id: number; nome: string };

type DiaValor = { data: string; valor: number; texto: string };

type CabecalhoData = { coluna: number; data: string };

type LinhaImportada = {
  id: string;
  tipo: 'gasto' | 'receita' | 'saldo_inicial';
  titulo: string;
  valores: DiaValor[];
  selecionado: boolean;
  areaId: number | null;
  contaId: number | null;
  tipoReceitaId: number | null;
  bancoId: number | null;
  erros: string[];
};

type PrevisaoItemRegistrado = {
  id: number;
  data: string;
  tipo: string;
  categoria: string;
  valor: number;
  areaId: number | null;
  contaId: number | null;
  bancoId: number | null;
};

type SemanaResumo = {
  id: number;
  status: string;
  itens: PrevisaoItemRegistrado[];
};

type Mensagem = { tipo: 'sucesso' | 'erro' | 'info'; texto: string };

const gerarUUID = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

const normalizarTexto = (texto: string): string =>
  texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

const ajustarTituloNormalizado = (tituloNormalizado: string): string =>
  TITULO_CORRECOES[tituloNormalizado] ?? tituloNormalizado;

const encontrarTipoPreferido = (
  tituloNormalizado: string,
  mapaTipos: Map<string, TipoReceitaOption>,
): TipoReceitaOption | null => {
  const preferenciaDireta = TIPO_RECEITA_PREFERENCIAS[tituloNormalizado];
  if (preferenciaDireta) {
    const tipoDireto = mapaTipos.get(normalizarTexto(preferenciaDireta));
    if (tipoDireto) {
      return tipoDireto;
    }
  }

  for (const item of TIPO_RECEITA_PADROES) {
    if (item.padrao.test(tituloNormalizado)) {
      const tipo = mapaTipos.get(normalizarTexto(item.nome));
      if (tipo) {
        return tipo;
      }
    }
  }

  return null;
};

const toISODate = (date: Date): string => date.toISOString().split('T')[0];

const getMonday = (date: Date): Date => {
  const d = new Date(date);
  const day = d.getDay();
  const diff = (day + 6) % 7;
  d.setDate(d.getDate() - diff);
  d.setHours(0, 0, 0, 0);
  return d;
};

const addDays = (date: Date, days: number): Date => {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
};

const addWeeks = (date: Date, weeks: number): Date => addDays(date, weeks * 7);

const formatarDataPt = (iso: string): string => {
  if (!iso) return '';
  const [year, month, day] = iso.split('-');
  return `${day}/${month}/${year}`;
};

const formatarIntervaloSemana = (inicioIso: string): string => {
  if (!inicioIso) return '';
  const inicio = new Date(`${inicioIso}T00:00:00`);
  const fim = addDays(inicio, 4);
  return `${formatarDataPt(toISODate(inicio))} a ${formatarDataPt(toISODate(fim))}`;
};

const identificarCodigoReceita = (tituloNormalizado: string): string | null => {
  const codigoDireto = RECEITA_CODIGOS[tituloNormalizado];
  if (codigoDireto) {
    return codigoDireto;
  }

  for (const item of RECEITA_PADROES) {
    if (item.padrao.test(tituloNormalizado)) {
      return item.codigo;
    }
  }

  return null;
};

const parseNumero = (valor: unknown): number => {
  if (typeof valor === 'number') {
    return Math.round(valor * 100) / 100;
  }
  if (typeof valor === 'string') {
    const textoNormalizado = valor
      .replace(/\s+/g, '')
      .replace(/[−–—]/g, '-')
      .replace(/[^0-9.,-]/g, '');

    if (!textoNormalizado) {
      return 0;
    }

    const negativo = textoNormalizado.includes('-');
    const semSinal = textoNormalizado.replace(/-/g, '');

    const ultimoPonto = semSinal.lastIndexOf('.');
    const ultimaVirgula = semSinal.lastIndexOf(',');

    const construirNumero = (separadorIndex: number, separador: ',' | '.') => {
      const parteInteira = semSinal.slice(0, separadorIndex);
      const parteDecimal = semSinal.slice(separadorIndex + 1);
      const inteiroLimpo =
        separador === ',' ? parteInteira.replace(/\./g, '') : parteInteira.replace(/,/g, '');
      const decimalLimpo =
        separador === ',' ? parteDecimal.replace(/\./g, '') : parteDecimal.replace(/,/g, '');
      return `${inteiroLimpo}.${decimalLimpo}`;
    };

    let numeroTexto = '';

    if (ultimaVirgula !== -1 || ultimoPonto !== -1) {
      let separador: ',' | '.' | null = null;

      if (ultimaVirgula !== -1 && ultimoPonto !== -1) {
        separador = ultimaVirgula > ultimoPonto ? ',' : '.';
      } else if (ultimaVirgula !== -1) {
        const decimais = semSinal.length - ultimaVirgula - 1;
        separador = decimais > 0 && decimais <= 2 ? ',' : null;
      } else if (ultimoPonto !== -1) {
        const decimais = semSinal.length - ultimoPonto - 1;
        separador = decimais > 0 && decimais <= 2 ? '.' : null;
      }

      if (separador) {
        const indice = separador === ',' ? ultimaVirgula : ultimoPonto;
        numeroTexto = construirNumero(indice, separador);
      } else {
        numeroTexto = semSinal.replace(/[.,]/g, '');
      }
    } else {
      numeroTexto = semSinal;
    }

    if (!numeroTexto) {
      return 0;
    }

    const numero = Number(numeroTexto);
    if (!Number.isFinite(numero)) {
      return 0;
    }

    const resultado = negativo ? -numero : numero;
    return Math.round(resultado * 100) / 100;
  }
  return 0;
};

const validarLinha = (linha: LinhaImportada): string[] => {
  const erros: string[] = [];
  if (!linha.selecionado) {
    return erros;
  }

  if (linha.tipo === 'gasto' && !linha.areaId) {
    erros.push('Selecione uma área para este gasto.');
  }

  if (linha.tipo === 'receita') {
    if (!linha.contaId) {
      erros.push('Selecione uma conta de receita.');
    }
    if (!linha.tipoReceitaId) {
      erros.push('Informe o tipo de receita correspondente.');
    }
  }

  return erros;
};

const currentMondayIso = toISODate(getMonday(new Date()));
const defaultSemanaIso = toISODate(addWeeks(getMonday(new Date()), 1));

const formatarNumeroParaTexto = (valor: number): string =>
  valor.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const criarDiaValor = (data: string, valor: number): DiaValor => ({
  data,
  valor,
  texto: formatarNumeroParaTexto(valor),
});

const gerarSemanasDisponiveis = (): { value: string; label: string }[] => {
  const base = getMonday(new Date());
  return Array.from({ length: 8 }, (_, index) => {
    const data = addWeeks(base, index);
    const iso = toISODate(data);
    return { value: iso, label: formatarIntervaloSemana(iso) };
  });
};

const semanasDisponiveis = gerarSemanasDisponiveis();

const obterDatasDaSemana = (inicioIso: string): string[] => {
  const inicio = new Date(`${inicioIso}T00:00:00`);
  return Array.from({ length: 5 }, (_, index) => toISODate(addDays(inicio, index)));
};

const encontrarContaPorId = (contas: ContaOption[], id: number | null) =>
  contas.find((conta) => conta.id === id) ?? null;

const encontrarAreaPorId = (areas: AreaOption[], id: number | null) =>
  areas.find((area) => area.id === id) ?? null;

const encontrarTipoPorId = (tipos: TipoReceitaOption[], id: number | null) =>
  tipos.find((tipo) => tipo.id === id) ?? null;
const LancamentoPrevisaoSemanalPage: React.FC = () => {
  const [usuario, setUsuario] = useState<UsuarioRow | null>(null);
  const [carregandoInicial, setCarregandoInicial] = useState(true);
  const [erroInicial, setErroInicial] = useState<string | null>(null);

  const [areas, setAreas] = useState<AreaOption[]>([]);
  const [contas, setContas] = useState<ContaOption[]>([]);
  const [tiposReceita, setTiposReceita] = useState<TipoReceitaOption[]>([]);
  const [bancos, setBancos] = useState<BancoOption[]>([]);

  const [semanaSelecionada, setSemanaSelecionada] = useState<string>(defaultSemanaIso);
  const [linhas, setLinhas] = useState<LinhaImportada[]>([]);
  const [arquivoNome, setArquivoNome] = useState<string | null>(null);
  const [processandoArquivo, setProcessandoArquivo] = useState(false);
  const [mensagem, setMensagem] = useState<Mensagem | null>(null);
  const [importando, setImportando] = useState(false);

  const [previsaoExistente, setPrevisaoExistente] = useState<SemanaResumo | null>(null);
  const [carregandoPrevisao, setCarregandoPrevisao] = useState(false);
  const [saldoBancarioAnterior, setSaldoBancarioAnterior] = useState<number>(0);
  const [modalResumo, setModalResumo] = useState<{
    iguais: number;
    modificados: number;
    novos: number;
    removidos: number;
    itensNovosDetalhes: Array<{ data: string; tipo: string; categoria: string; valor: number }>;
    itensModificadosDetalhes: Array<{ data: string; tipo: string; categoria: string; valorAntigo: number; valorNovo: number }>;
    itensRemovidosDetalhes: Array<{ data: string; tipo: string; categoria: string; valor: number }>;
    onConfirm: () => Promise<void>;
    onCancel: () => void;
  } | null>(null);
  const [secoesExpandidas, setSecoesExpandidas] = useState<{ novos: boolean; modificados: boolean; removidos: boolean }>({
    novos: false,
    modificados: false,
    removidos: false
  });
  const [datasExpandidas, setDatasExpandidas] = useState<Set<string>>(new Set());
  const [modoEdicao, setModoEdicao] = useState(false);
  const [modoInclusao, setModoInclusao] = useState(false);
  const arquivoInputRef = useRef<HTMLInputElement | null>(null);

  const datasTabela = useMemo(() => {
    if (linhas.length > 0) {
      return linhas[0].valores.map((valor) => valor.data);
    }
    return obterDatasDaSemana(semanaSelecionada);
  }, [linhas, semanaSelecionada]);

  const edicaoPermitida = useMemo(() => {
    const selecionadaData = new Date(`${semanaSelecionada}T00:00:00`);
    const atual = new Date(`${currentMondayIso}T00:00:00`);
    return selecionadaData.getTime() >= atual.getTime();
  }, [semanaSelecionada]);

  const categoriasExistentes = useMemo(() => {
    const categs = new Set<string>();
    // Adiciona nomes de áreas
    areas.forEach(area => categs.add(area.nome));
    // Adiciona nomes de contas de receita
    contas.forEach(conta => categs.add(conta.nome));
    // Adiciona categorias das linhas existentes
    linhas.forEach(linha => {
      if (linha.titulo && linha.titulo.trim()) {
        categs.add(linha.titulo);
      }
    });
    return Array.from(categs).sort();
  }, [areas, contas, linhas]);

  const totaisReceita = useMemo(
    () =>
      datasTabela.map((data) =>
        linhas
          .filter((linha) => linha.tipo === 'receita' && linha.selecionado)
          .reduce((acc, linha) => {
            const encontrado = linha.valores.find((item) => item.data === data);
            return acc + (encontrado?.valor ?? 0);
          }, 0),
      ),
    [datasTabela, linhas],
  );

  const totaisGasto = useMemo(
    () =>
      datasTabela.map((data) =>
        linhas
          .filter((linha) => linha.tipo === 'gasto' && linha.selecionado)
          .reduce((acc, linha) => {
            const encontrado = linha.valores.find((item) => item.data === data);
            return acc + (encontrado?.valor ?? 0);
          }, 0),
      ),
    [datasTabela, linhas],
  );

  const saldoInicialValor = useMemo(() => {
    const linhaSaldo = linhas.find((linha) => linha.tipo === 'saldo_inicial');
    // Se houver linha saldo_inicial importada, usa esse valor
    // Senão, usa o saldo bancário anterior automaticamente
    return linhaSaldo?.valores[0]?.valor ?? saldoBancarioAnterior;
  }, [linhas, saldoBancarioAnterior]);

  const saldoDiarioPrevisto = useMemo(
    () => totaisReceita.map((receita, index) => receita - (totaisGasto[index] ?? 0)),
    [totaisReceita, totaisGasto],
  );

  const saldoAcumuladoPrevisto = useMemo(() => {
    const acumulado: number[] = [];
    saldoDiarioPrevisto.forEach((valor, index) => {
      if (index === 0) {
        acumulado.push(saldoInicialValor + valor);
      } else {
        acumulado.push(acumulado[index - 1] + valor);
      }
    });
    return acumulado;
  }, [saldoDiarioPrevisto, saldoInicialValor]);
  const carregarOpcoes = useCallback(async () => {
    try {
      const supabase = getSupabaseClient();
      const [areasRes, contasRes, tiposRes, bancosRes] = await Promise.all([
        supabase
          .from('are_areas')
          .select('are_id, are_nome')
          .eq('are_ativo', true)
          .order('are_nome', { ascending: true }),
        supabase
          .from('ctr_contas_receita')
          .select('ctr_id, ctr_nome, ctr_codigo, ctr_ban_id, ban_bancos(ban_nome)')
          .eq('ctr_ativo', true)
          .order('ctr_nome', { ascending: true }),
        supabase
          .from('tpr_tipos_receita')
          .select('tpr_id, tpr_nome')
          .eq('tpr_ativo', true)
          .order('tpr_nome', { ascending: true }),
        supabase
          .from('ban_bancos')
          .select('ban_id, ban_nome')
          .eq('ban_ativo', true)
          .order('ban_nome', { ascending: true }),
      ]);

      if (areasRes.error) throw areasRes.error;
      if (contasRes.error) throw contasRes.error;
      if (tiposRes.error) throw tiposRes.error;
      if (bancosRes.error) throw bancosRes.error;

      setAreas(
        (areasRes.data ?? []).map((area) => ({
          id: Number(area.are_id),
          nome: area.are_nome ?? 'Área sem nome',
          normalizado: normalizarTexto(area.are_nome ?? ''),
        })),
      );

      setContas(
        (contasRes.data ?? []).map((conta) => {
          const bancoRelacionado = Array.isArray(conta.ban_bancos)
            ? conta.ban_bancos[0]
            : (conta.ban_bancos as { ban_nome?: string | null } | null);
          const bancoNome = bancoRelacionado?.ban_nome ?? 'Sem banco vinculado';
          return {
            id: Number(conta.ctr_id),
            nome: conta.ctr_nome ?? 'Conta sem nome',
            codigo: (conta.ctr_codigo ?? '').trim(),
            bancoId: conta.ctr_ban_id !== null ? Number(conta.ctr_ban_id) : null,
            bancoNome,
            normalizado: normalizarTexto(conta.ctr_nome ?? ''),
          } satisfies ContaOption;
        }),
      );

      setTiposReceita(
        (tiposRes.data ?? []).map((tipo) => ({
          id: Number(tipo.tpr_id),
          nome: tipo.tpr_nome ?? 'Tipo sem nome',
          normalizado: normalizarTexto(tipo.tpr_nome ?? ''),
        })),
      );

      setBancos(
        (bancosRes.data ?? []).map((banco) => ({
          id: Number(banco.ban_id),
          nome: banco.ban_nome ?? 'Banco sem nome',
        })),
      );
    } catch (error) {
      console.error('Erro ao carregar opções da previsão semanal:', error);
      setMensagem({
        tipo: 'erro',
        texto: 'Não foi possível carregar cadastros auxiliares para a previsão semanal.',
      });
    }
  }, []);

  const carregarUsuario = useCallback(async () => {
    try {
      setCarregandoInicial(true);
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
        setErroInicial('Não foi possível identificar o usuário atual.');
        return;
      }

      setUsuario(data);
      setErroInicial(null);
      await carregarOpcoes();
    } catch (error) {
      console.error('Erro ao carregar usuário ou cadastros:', error);
      setErroInicial('Falha ao carregar dados iniciais para a previsão semanal.');
    } finally {
      setCarregandoInicial(false);
    }
  }, [carregarOpcoes]);

  const carregarPrevisaoExistente = useCallback(
    async (semanaInicio: string, usuarioId: string) => {
      try {
        setCarregandoPrevisao(true);
        const supabase = getSupabaseClient();
        // Todos os usuários podem visualizar todas as semanas
        const { data: semana, error: semanaErro } = await supabase
          .from('pvs_semanas')
          .select('pvs_id, pvs_status')
          .eq('pvs_semana_inicio', semanaInicio)
          .maybeSingle();

        if (semanaErro) throw semanaErro;
        if (!semana) {
          setPrevisaoExistente(null);
          return;
        }

        const { data: itens, error: itensErro } = await supabase
          .from('pvi_previsao_itens')
          .select('pvi_id, pvi_data, pvi_tipo, pvi_categoria, pvi_valor, pvi_are_id, pvi_ctr_id, pvi_ban_id')
          .eq('pvi_pvs_id', semana.pvs_id)
          .order('pvi_data', { ascending: true })
          .order('pvi_ordem', { ascending: true });

        if (itensErro) throw itensErro;

        const itensFormatados = (itens ?? []).map((item) => ({
          id: Number(item.pvi_id),
          data: String(item.pvi_data ?? ''),
          tipo: String(item.pvi_tipo ?? ''),
          categoria: String(item.pvi_categoria ?? ''),
          valor: parseNumero(item.pvi_valor),
          areaId: item.pvi_are_id !== null ? Number(item.pvi_are_id) : null,
          contaId: item.pvi_ctr_id !== null ? Number(item.pvi_ctr_id) : null,
          bancoId: item.pvi_ban_id !== null ? Number(item.pvi_ban_id) : null,
        }));

        setPrevisaoExistente({
          id: Number(semana.pvs_id),
          status: semana.pvs_status ?? 'rascunho',
          itens: itensFormatados,
        });
      } catch (error) {
        console.error('Erro ao carregar previsão existente:', error);
        setPrevisaoExistente(null);
      } finally {
        setCarregandoPrevisao(false);
      }
    },
    [],
  );

  useEffect(() => {
    carregarUsuario();
  }, [carregarUsuario]);

  useEffect(() => {
    if (usuario) {
      carregarPrevisaoExistente(semanaSelecionada, usuario.usr_id);
    }
  }, [carregarPrevisaoExistente, semanaSelecionada, usuario]);

  useEffect(() => {
    const buscarSaldoBancarioAnterior = async () => {
      try {
        const datas = obterDatasDaSemana(semanaSelecionada);
        if (datas.length === 0) return;

        // Primeiro dia da semana selecionada
        const dataInicio = datas[0];

        const supabase = getSupabaseClient();

        // Buscar os saldos mais recentes ANTES do início da semana
        // Agrupamos por banco e pegamos a data mais recente de cada um
        const { data: saldos, error } = await supabase
          .from('sdb_saldo_banco')
          .select('sdb_ban_id, sdb_saldo, sdb_data')
          .lt('sdb_data', dataInicio)
          .order('sdb_data', { ascending: false });

        if (error) {
          console.error('Erro ao buscar saldo bancário anterior:', error);
          setSaldoBancarioAnterior(0);
          return;
        }

        // Pegar o saldo mais recente de cada banco
        const saldosPorBanco = new Map<number, number>();
        (saldos || []).forEach((item: any) => {
          const bancoId = Number(item.sdb_ban_id);
          if (!saldosPorBanco.has(bancoId)) {
            // Primeiro registro deste banco (o mais recente por causa da ordenação)
            saldosPorBanco.set(bancoId, Number(item.sdb_saldo) || 0);
          }
        });

        // Somar todos os saldos bancários mais recentes
        const totalSaldo = Array.from(saldosPorBanco.values()).reduce((acc, saldo) => acc + saldo, 0);
        setSaldoBancarioAnterior(totalSaldo);
      } catch (erro) {
        console.error('Erro ao calcular saldo bancário anterior:', erro);
        setSaldoBancarioAnterior(0);
      }
    };

    buscarSaldoBancarioAnterior();
  }, [semanaSelecionada]);

  const atualizarLinha = useCallback(
    (id: string, atualizador: (linha: LinhaImportada) => LinhaImportada) => {
      setLinhas((prev) => prev.map((linha) => (linha.id === id ? atualizador(linha) : linha)));
    },
  []);
  const parsePlanilha = useCallback(
    async (file: File) => {
      if (!areas.length && !contas.length) {
        setMensagem({
          tipo: 'erro',
          texto: 'Cadastre áreas e contas de receita antes de importar a previsão.',
        });
        return;
      }

      setMensagem(null);
      setLinhas([]);
      setProcessandoArquivo(true);
      try {
        const XLSX = await loadSheetJS();
        const buffer = await file.arrayBuffer();
        const workbook = XLSX.read(buffer, { type: 'array', cellDates: true });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const rows: any[][] = XLSX.utils.sheet_to_json(sheet, {
          header: 1,
          raw: false,
          blankrows: false,
        });

        if (!rows || rows.length === 0) {
          throw new Error('A planilha está vazia.');
        }

        const semanaSelecionadaData = new Date(`${semanaSelecionada}T00:00:00`);
        const anoReferenciaSemana = semanaSelecionadaData.getFullYear();
        const mesReferenciaSemana = semanaSelecionadaData.getMonth() + 1;

        const ajustarAnoPorMes = (mes: number, anoPadrao: number): number => {
          if (!Number.isFinite(mes) || mes < 1 || mes > 12) {
            return anoPadrao;
          }

          if (mes < mesReferenciaSemana && mesReferenciaSemana - mes > 6) {
            return anoPadrao + 1;
          }

          if (mes > mesReferenciaSemana && mes - mesReferenciaSemana > 6) {
            return anoPadrao - 1;
          }

          return anoPadrao;
        };

        const parseData = (valor: any): string | null => {
          if (!valor) {
            return null;
          }
          if (valor instanceof Date) {
            return toISODate(valor);
          }
          if (typeof valor === 'number') {
            const parsed = XLSX.SSF.parse_date_code(valor);
            if (!parsed) return null;
            const data = new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d));
            return toISODate(data);
          }
          if (typeof valor === 'string') {
            const texto = valor.replace(/\s+/g, ' ').trim().toLowerCase();
            if (!texto) return null;

            // Mapa de meses por extenso
            const meses: Record<string, number> = {
              'jan': 1, 'janeiro': 1,
              'fev': 2, 'fevereiro': 2,
              'mar': 3, 'março': 3, 'marco': 3,
              'abr': 4, 'abril': 4,
              'mai': 5, 'maio': 5,
              'jun': 6, 'junho': 6,
              'jul': 7, 'julho': 7,
              'ago': 8, 'agosto': 8,
              'set': 9, 'setembro': 9,
              'out': 10, 'outubro': 10,
              'nov': 11, 'novembro': 11,
              'dez': 12, 'dezembro': 12
            };

            // Formato com mês por extenso: 17/nov/25, 17-nov-2025, 17.nov.25
            const comMesExtenso = texto.match(/^(\d{1,2})[\/.\-]([a-z]+)[\/.\-]?(\d{2,4})?$/i);
            if (comMesExtenso) {
              const dia = Number(comMesExtenso[1]);
              const mesTexto = comMesExtenso[2].toLowerCase();
              const mes = meses[mesTexto];
              if (mes) {
                let ano = comMesExtenso[3] ? Number(comMesExtenso[3]) : anoReferenciaSemana;
                if (ano < 100) {
                  ano += ano < 50 ? 2000 : 1900;
                }
                if (dia < 1 || dia > 31) {
                  return null;
                }
                const data = new Date(Date.UTC(ano, mes - 1, dia));
                return toISODate(data);
              }
            }

            // Formato completo com separadores variados: 17/11/25, 17.11.2025, 17-11-25
            const completo = texto.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/);
            if (completo) {
              const dia = Number(completo[1]);
              const mes = Number(completo[2]);
              let ano = Number(completo[3]);
              if (ano < 100) {
                ano += ano < 50 ? 2000 : 1900;
              }
              if (mes < 1 || mes > 12 || dia < 1 || dia > 31) {
                return null;
              }
              const data = new Date(Date.UTC(ano, mes - 1, dia));
              return toISODate(data);
            }

            // Formato sem ano: 17/11, 17.11, 17-11
            const semAno = texto.match(/^(\d{1,2})[\/.\-](\d{1,2})$/);
            if (semAno) {
              const dia = Number(semAno[1]);
              const mes = Number(semAno[2]);
              if (mes < 1 || mes > 12 || dia < 1 || dia > 31) {
                return null;
              }
              const anoAjustado = ajustarAnoPorMes(mes, anoReferenciaSemana);
              const data = new Date(Date.UTC(anoAjustado, mes - 1, dia));
              return toISODate(data);
            }

            // Tentar parse padrão
            const parsed = new Date(texto);
            if (Number.isNaN(parsed.valueOf())) {
              return null;
            }
            return toISODate(parsed);
          }
          return null;
        };

        let headerIndex = -1;
        let datasDetectadas: CabecalhoData[] = [];

        for (let index = 0; index < rows.length; index += 1) {
          const row = rows[index];
          if (!row || row.length < 2) continue;
          const datas = row
            .slice(1)
            .map((cell: unknown, idx: number) => {
              const data = parseData(cell);
              return data ? { coluna: idx + 1, data } : null;
            })
            .filter((item): item is CabecalhoData => item !== null);
          if (datas.length >= 2) {
            headerIndex = index;
            datasDetectadas = datas;
            break;
          }
        }

        if (headerIndex === -1) {
          throw new Error('Não foi possível identificar a linha de datas na planilha.');
        }

        if (datasDetectadas.length === 0) {
          throw new Error('Nenhuma data válida foi encontrada na planilha.');
        }

        const datasSemanaSelecionada = obterDatasDaSemana(semanaSelecionada);
        const dataInicio = datasSemanaSelecionada[0];
        const dataFim = datasSemanaSelecionada[datasSemanaSelecionada.length - 1];

        // Filtra apenas as datas detectadas que estão dentro do período da semana
        const colunasDentroDoPeriodo = datasDetectadas.filter((cabecalho) => {
          const dataDetectada = cabecalho.data;
          return dataDetectada >= dataInicio && dataDetectada <= dataFim;
        });

        if (colunasDentroDoPeriodo.length === 0) {
          throw new Error(
            `Nenhuma data da planilha está dentro do período selecionado (${formatarDataPt(dataInicio)} a ${formatarDataPt(dataFim)}). Verifique o arquivo e tente novamente.`,
          );
        }

        // Ordena as colunas por data
        colunasDentroDoPeriodo.sort((a, b) => a.data.localeCompare(b.data));

        // Usa as datas detectadas que estão dentro do período
        datasDetectadas = colunasDentroDoPeriodo;

        const mapaAreas = new Map(areas.map((area) => [area.normalizado, area]));
        const mapaContasCodigo = new Map(contas.map((conta) => [conta.codigo, conta]));
        const mapaContasNome = new Map(contas.map((conta) => [conta.normalizado, conta]));
        const mapaTipos = new Map(tiposReceita.map((tipo) => [tipo.normalizado, tipo]));

        mapaContasNome.forEach((conta, chave) => {
          const correcao = TITULO_CORRECOES[chave];
          if (correcao && !mapaContasNome.has(correcao)) {
            mapaContasNome.set(correcao, conta);
          }
        });

        Object.entries(TITULO_CORRECOES).forEach(([alias, destino]) => {
          const contaCorrigida = mapaContasNome.get(destino);
          if (contaCorrigida) {
            mapaContasNome.set(alias, contaCorrigida);
          }
        });

        const novasLinhas: LinhaImportada[] = [];
        let saldoInicialLinha: LinhaImportada | null = null;

        for (let index = headerIndex + 1; index < rows.length; index += 1) {
          const row = rows[index];
          if (!row) continue;

          const tituloBruto = row[0];
          if (!tituloBruto) continue;

          const tituloOriginal = String(tituloBruto).trim();
          if (!tituloOriginal) continue;

          const tituloNormalizadoOriginal = normalizarTexto(tituloOriginal);
          const tituloNormalizado = ajustarTituloNormalizado(tituloNormalizadoOriginal);

          if (tituloNormalizado === 'receitas') continue;
          if (tituloNormalizadoOriginal.startsWith('total despesa')) continue;
          if (
            tituloNormalizadoOriginal.startsWith('saldo diario') ||
            tituloNormalizadoOriginal.startsWith('saldo diário')
          ) {
            continue;
          }
          if (tituloNormalizadoOriginal.startsWith('saldo acumulado')) {
            continue;
          }

          const valores = datasDetectadas.map((cabecalho) =>
            criarDiaValor(cabecalho.data, parseNumero(row[cabecalho.coluna])),
          );

          if (tituloNormalizado.startsWith('saldo inicial')) {
            saldoInicialLinha = {
              id: gerarUUID(),
              tipo: 'saldo_inicial',
              titulo: 'Saldo inicial',
              valores: valores.map((item, idx) =>
                idx === 0 ? item : criarDiaValor(item.data, 0),
              ),
              selecionado: true,
              areaId: null,
              contaId: null,
              tipoReceitaId: null,
              bancoId: null,
              erros: [],
            };
            continue;
          }

          if (tituloNormalizadoOriginal.startsWith('gasto')) {
            const nomeArea = tituloOriginal.replace(/^gastos?\s*[:\-]?/i, '').trim();
            const nomeAreaNormalizado = normalizarTexto(nomeArea);
            // Aplica correções de título para encontrar a área correta
            const nomeAreaCorrigido = ajustarTituloNormalizado(nomeAreaNormalizado);
            const area = mapaAreas.get(nomeAreaCorrigido) || mapaAreas.get(nomeAreaNormalizado);
            const linha: LinhaImportada = {
              id: gerarUUID(),
              tipo: 'gasto',
              titulo: nomeArea || tituloOriginal,
              valores,
              selecionado: Boolean(area),
              areaId: area?.id ?? null,
              contaId: null,
              tipoReceitaId: null,
              bancoId: null,
              erros: area ? [] : ['Área não encontrada para este gasto.'],
            };
            novasLinhas.push(linha);
            continue;
          }

          const contaCodigo = identificarCodigoReceita(tituloNormalizado);
          let conta = contaCodigo ? mapaContasCodigo.get(contaCodigo) : undefined;
          if (!conta) {
            conta = mapaContasNome.get(tituloNormalizado);
          }

          const tipoReceitaPreferido = encontrarTipoPreferido(tituloNormalizado, mapaTipos);
          const tipoReceitaSugerido = Array.from(mapaTipos.values()).find((tipo) =>
            tipo.normalizado.includes(tituloNormalizado),
          );

          const linhaReceita: LinhaImportada = {
            id: gerarUUID(),
            tipo: 'receita',
            titulo: tituloOriginal,
            valores,
            selecionado: Boolean(conta),
            areaId: null,
            contaId: conta?.id ?? null,
            tipoReceitaId: tipoReceitaPreferido?.id ?? tipoReceitaSugerido?.id ?? null,
            bancoId: conta?.bancoId ?? null,
            erros: [],
          };

          linhaReceita.erros = validarLinha(linhaReceita);
          if (linhaReceita.erros.length > 0) {
            linhaReceita.selecionado = false;
          }

          novasLinhas.push(linhaReceita);
        }

        const resultado = saldoInicialLinha ? [saldoInicialLinha, ...novasLinhas] : novasLinhas;
        setLinhas(resultado);
        setMensagem({
          tipo: 'info',
          texto: 'Planilha carregada com sucesso. Revise os dados antes de importar.',
        });
      } catch (error) {
        console.error('Erro ao processar planilha da previsão semanal:', error);
        setLinhas([]);
        setArquivoNome(null);
        setMensagem({
          tipo: 'erro',
          texto:
            error instanceof Error
              ? error.message
              : 'Não foi possível interpretar o arquivo informado.',
        });
      } finally {
        setProcessandoArquivo(false);
      }
    },
    [areas, contas, tiposReceita, semanaSelecionada],
  );

  const handleArquivoChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setArquivoNome(file.name);
    await parsePlanilha(file);
    if (arquivoInputRef.current) {
      arquivoInputRef.current.value = '';
    }
  };
  const handleCancelarArquivo = () => {
    if (processandoArquivo) {
      return;
    }
    setArquivoNome(null);
    setLinhas([]);
    setMensagem(null);
    if (arquivoInputRef.current) {
      arquivoInputRef.current.value = '';
    }
  };
  const handleToggleLinha = (id: string, selecionado: boolean) => {
    atualizarLinha(id, (linha) => {
      const proximo = {
        ...linha,
        selecionado,
      };
      return {
        ...proximo,
        erros: validarLinha(proximo),
      };
    });
  };

  const handleValorChange = (linhaId: string, data: string, texto: string) => {
    atualizarLinha(linhaId, (linha) => {
      const valoresAtualizados = linha.valores.map((item) => {
        if (item.data !== data) {
          return item;
        }

        const numero = parseNumero(texto);
        return {
          ...item,
          valor: numero,
          texto,
        };
      });
      return {
        ...linha,
        valores: valoresAtualizados,
      };
    });
  };

  const handleValorBlur = (linhaId: string, data: string) => {
    atualizarLinha(linhaId, (linha) => {
      const valoresAtualizados = linha.valores.map((item) => {
        if (item.data !== data) {
          return item;
        }

        if (item.texto.trim() === '') {
          return { ...item, valor: 0, texto: '' };
        }

        return {
          ...item,
          texto: formatarNumeroParaTexto(item.valor),
        };
      });
      return {
        ...linha,
        valores: valoresAtualizados,
      };
    });
  };

  const handleAreaChange = (linhaId: string, areaId: number | null) => {
    atualizarLinha(linhaId, (linha) => {
      const proximo = {
        ...linha,
        areaId,
        selecionado: areaId !== null ? true : linha.selecionado,
      };
      return {
        ...proximo,
        erros: validarLinha(proximo),
      };
    });
  };

  const handleContaChange = (linhaId: string, contaId: number | null) => {
    atualizarLinha(linhaId, (linha) => {
      const conta = contaId !== null ? encontrarContaPorId(contas, contaId) : null;
      const tituloNormalizado = ajustarTituloNormalizado(normalizarTexto(linha.titulo));
      const mapaTipos = new Map(tiposReceita.map((tipo) => [tipo.normalizado, tipo]));
      const tipoPreferido = encontrarTipoPreferido(tituloNormalizado, mapaTipos);
      const tipoReceitaSugestao = conta
        ? tiposReceita.find((tipo) => tipo.normalizado.includes(normalizarTexto(linha.titulo)))
        : null;
      const proximo = {
        ...linha,
        contaId,
        bancoId: conta?.bancoId ?? null,
        tipoReceitaId: linha.tipoReceitaId ?? tipoPreferido?.id ?? tipoReceitaSugestao?.id ?? null,
        selecionado: contaId !== null ? true : linha.selecionado,
      };
      return {
        ...proximo,
        erros: validarLinha(proximo),
      };
    });
  };

  const handleTipoReceitaChange = (linhaId: string, tipoId: number | null) => {
    atualizarLinha(linhaId, (linha) => {
      const proximo = {
        ...linha,
        tipoReceitaId: tipoId,
      };
      return {
        ...proximo,
        erros: validarLinha(proximo),
      };
    });
  };

  const handleIniciarEdicao = () => {
    if (!previsaoExistente || !previsaoExistente.itens.length) {
      setMensagem({ tipo: 'erro', texto: 'Não há dados para editar.' });
      return;
    }

    // Agrupa itens por categoria e tipo
    const itensPorCategoria = new Map<string, PrevisaoItemRegistrado[]>();

    previsaoExistente.itens.forEach(item => {
      // Ignora saldo_diario e saldo_acumulado (são calculados)
      if (item.tipo === 'saldo_diario' || item.tipo === 'saldo_acumulado') {
        return;
      }

      const chave = `${item.tipo}|${item.categoria}`;
      const grupo = itensPorCategoria.get(chave) || [];
      grupo.push(item);
      itensPorCategoria.set(chave, grupo);
    });

    // Converte grupos em LinhaImportada
    const linhasEditaveis: LinhaImportada[] = [];
    const datasSemanaSelecionada = obterDatasDaSemana(semanaSelecionada);

    itensPorCategoria.forEach((itens, chave) => {
      const primeiroItem = itens[0];

      // Cria valores para cada data da semana
      const valores = datasSemanaSelecionada.map(data => {
        const itemNaData = itens.find(i => i.data === data);
        const valor = itemNaData?.valor ?? 0;
        return criarDiaValor(data, valor);
      });

      const linha: LinhaImportada = {
        id: gerarUUID(),
        tipo: primeiroItem.tipo as 'gasto' | 'receita' | 'saldo_inicial',
        titulo: primeiroItem.categoria,
        valores,
        selecionado: true,
        areaId: primeiroItem.areaId,
        contaId: primeiroItem.contaId,
        tipoReceitaId: null, // Precisamos buscar do primeiro item se for receita
        bancoId: primeiroItem.bancoId,
        erros: [],
      };

      // Se for receita, tenta identificar o tipo de receita
      if (linha.tipo === 'receita' && linha.contaId) {
        const conta = encontrarContaPorId(contas, linha.contaId);
        const tituloNormalizado = ajustarTituloNormalizado(normalizarTexto(linha.titulo));
        const mapaTipos = new Map(tiposReceita.map((tipo) => [tipo.normalizado, tipo]));
        const tipoPreferido = encontrarTipoPreferido(tituloNormalizado, mapaTipos);
        linha.tipoReceitaId = tipoPreferido?.id ?? null;
      }

      linha.erros = validarLinha(linha);
      linhasEditaveis.push(linha);
    });

    // Ordena: saldo_inicial primeiro, depois receitas, depois gastos
    linhasEditaveis.sort((a, b) => {
      const ordem = { saldo_inicial: 0, receita: 1, gasto: 2 };
      const ordemA = ordem[a.tipo] ?? 3;
      const ordemB = ordem[b.tipo] ?? 3;
      if (ordemA !== ordemB) return ordemA - ordemB;
      return a.titulo.localeCompare(b.titulo);
    });

    setLinhas(linhasEditaveis);
    setModoEdicao(true);
    setMensagem({ tipo: 'info', texto: 'Modo de edição ativado. Ajuste os valores e clique em "Salvar alterações".' });
  };

  const handleCancelarEdicao = () => {
    setModoEdicao(false);
    setLinhas([]);
    setMensagem(null);
  };

  const handleIniciarInclusao = () => {
    if (!previsaoExistente) {
      setMensagem({ tipo: 'erro', texto: 'Não há previsão registrada para incluir novos itens.' });
      return;
    }

    const datasSemanaSelecionada = obterDatasDaSemana(semanaSelecionada);

    // Cria uma linha vazia de gasto
    const novaLinhaGasto: LinhaImportada = {
      id: gerarUUID(),
      tipo: 'gasto',
      titulo: '',
      valores: datasSemanaSelecionada.map(data => criarDiaValor(data, 0)),
      selecionado: true,
      areaId: null,
      contaId: null,
      tipoReceitaId: null,
      bancoId: null,
      erros: ['Selecione uma área para este gasto.'],
    };

    // Cria uma linha vazia de receita
    const novaLinhaReceita: LinhaImportada = {
      id: gerarUUID(),
      tipo: 'receita',
      titulo: '',
      valores: datasSemanaSelecionada.map(data => criarDiaValor(data, 0)),
      selecionado: true,
      areaId: null,
      contaId: null,
      tipoReceitaId: null,
      bancoId: null,
      erros: ['Selecione uma conta de receita.', 'Informe o tipo de receita correspondente.'],
    };

    setLinhas([novaLinhaReceita, novaLinhaGasto]);
    setModoInclusao(true);
    setMensagem({
      tipo: 'info',
      texto: 'Modo de inclusão ativado. Preencha os dados da nova categoria e clique em "Salvar inclusão".'
    });
  };

  const handleCancelarInclusao = () => {
    setModoInclusao(false);
    setLinhas([]);
    setMensagem(null);
  };

  const handleAdicionarLinha = (tipo: 'gasto' | 'receita') => {
    const datasSemanaSelecionada = obterDatasDaSemana(semanaSelecionada);

    if (tipo === 'gasto') {
      const novaLinha: LinhaImportada = {
        id: gerarUUID(),
        tipo: 'gasto',
        titulo: 'Despesas',
        valores: datasSemanaSelecionada.map(data => criarDiaValor(data, 0)),
        selecionado: true,
        areaId: null,
        contaId: null,
        tipoReceitaId: null,
        bancoId: null,
        erros: ['Selecione uma área para este gasto.'],
      };
      setLinhas(prev => [...prev, novaLinha]);
    } else {
      const novaLinha: LinhaImportada = {
        id: gerarUUID(),
        tipo: 'receita',
        titulo: 'Receita',
        valores: datasSemanaSelecionada.map(data => criarDiaValor(data, 0)),
        selecionado: true,
        areaId: null,
        contaId: null,
        tipoReceitaId: null,
        bancoId: null,
        erros: ['Selecione uma conta de receita.', 'Informe o tipo de receita correspondente.'],
      };
      setLinhas(prev => [novaLinha, ...prev]);
    }
  };

  const handleTituloChange = (linhaId: string, novoTitulo: string) => {
    atualizarLinha(linhaId, (linha) => ({
      ...linha,
      titulo: novoTitulo,
    }));
  };

  const handleRemoverLinha = (linhaId: string) => {
    setLinhas(prev => prev.filter(linha => linha.id !== linhaId));
  };

  const handleBaixarTemplate = async () => {
    try {
      const XLSX = await loadSheetJS();

      // Cria dados de exemplo para a semana selecionada
      const datasSemanaSelecionada = obterDatasDaSemana(semanaSelecionada);

      // Cria cabeçalho com as datas
      const header = ['Categoria', ...datasSemanaSelecionada.map(data => {
        const [year, month, day] = data.split('-');
        return `${day}/${month}`;
      })];

      // Dados de exemplo
      const dadosExemplo = [
        header,
        ['Saldo Inicial', 50000, '', '', '', ''],
        [''],
        ['RECEITAS', '', '', '', '', ''],
        ['Depósito e PIX', 10000, 8000, 12000, 9000, 11000],
        ['Boleto', 5000, 4500, 6000, 5500, 5000],
        ['Cartão Débito', 2000, 1800, 2200, 1900, 2100],
        [''],
        ['Gasto - Folha de Pagamento', 15000, '', '', '', ''],
        ['Gasto - Material e Consumo', 3000, 2500, 3500, 2800, 3200],
        ['Gasto - Serviços Terceiros', 2000, 1500, 2500, 1800, 2200],
        ['Gasto - Impostos e Taxas', 1000, 800, 1200, 900, 1100],
        [''],
        ['', '', '', '', '', ''],
        ['INSTRUÇÕES:', '', '', '', '', ''],
        ['1. Preencha as datas no formato DD/MM ou DD/MM/AAAA', '', '', '', '', ''],
        ['2. Receitas: use nomes como "Depósito e PIX", "Boleto", "Cartão Débito"', '', '', '', '', ''],
        ['3. Gastos: comece com "Gasto -" ou "Gastos:" seguido do nome da área', '', '', '', '', ''],
        ['4. Valores podem usar vírgula ou ponto como separador decimal', '', '', '', '', ''],
        ['5. Células vazias serão interpretadas como valor zero', '', '', '', '', ''],
      ];

      // Cria planilha
      const ws = XLSX.utils.aoa_to_sheet(dadosExemplo);

      // Define larguras das colunas
      const colWidths = [{ wch: 30 }, ...datasSemanaSelecionada.map(() => ({ wch: 12 }))];
      ws['!cols'] = colWidths;

      // Cria workbook
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Previsão Semanal');

      // Gera arquivo
      const nomeArquivo = `template_previsao_${semanaSelecionada}.xlsx`;
      XLSX.writeFile(wb, nomeArquivo);

      setMensagem({
        tipo: 'sucesso',
        texto: `Template baixado: ${nomeArquivo}`,
      });
    } catch (error) {
      console.error('Erro ao gerar template:', error);
      setMensagem({
        tipo: 'erro',
        texto: 'Não foi possível gerar o template. Tente novamente.',
      });
    }
  };
  const handleImportar = async () => {
    if (!usuario) {
      setMensagem({ tipo: 'erro', texto: 'Usuário não identificado para importar a previsão.' });
      return;
    }

    const linhasSelecionadas = linhas.filter((linha) => linha.selecionado);
    if (linhasSelecionadas.length === 0) {
      setMensagem({ tipo: 'erro', texto: 'Selecione pelo menos uma linha para importação.' });
      return;
    }

    const linhasInvalidas = linhasSelecionadas.filter((linha) => validarLinha(linha).length > 0);
    if (linhasInvalidas.length > 0) {
      setMensagem({
        tipo: 'erro',
        texto: 'Existem linhas selecionadas sem associação obrigatória. Ajuste antes de prosseguir.',
      });
      return;
    }

    const itensParaInserir: {
      tipo: 'receita' | 'gasto' | 'saldo_inicial' | 'saldo_diario' | 'saldo_acumulado';
      data: string;
      categoria: string;
      valor: number;
      areaId: number | null;
      contaId: number | null;
      tipoReceitaId: number | null;
      bancoId: number | null;
      ordem: number;
    }[] = [];

    linhasSelecionadas.forEach((linha, linhaIndex) => {
      linha.valores.forEach((valor, valorIndex) => {
        const valorNumerico = Number.isFinite(valor.valor) ? Number(valor.valor) : 0;
        if (linha.tipo === 'saldo_inicial') {
          if (valorIndex === 0 && valorNumerico !== 0) {
            itensParaInserir.push({
              tipo: 'saldo_inicial',
              data: valor.data,
              categoria: linha.titulo,
              valor: Math.round(valorNumerico * 100) / 100,
              areaId: null,
              contaId: null,
              tipoReceitaId: null,
              bancoId: null,
              ordem: linhaIndex * 10,
            });
          }
          return;
        }

        if (valorNumerico === 0) {
          return;
        }

        itensParaInserir.push({
          tipo: linha.tipo,
          data: valor.data,
          categoria: linha.titulo,
          valor: Math.round(valorNumerico * 100) / 100,
          areaId: linha.areaId,
          contaId: linha.contaId,
          tipoReceitaId: linha.tipoReceitaId,
          bancoId: linha.bancoId,
          ordem: linhaIndex * 10 + valorIndex,
        });
      });
    });

    // Adicionar saldo diário e saldo acumulado (1 registro por dia)
    datasTabela.forEach((data, index) => {
      const saldoDia = saldoDiarioPrevisto[index] ?? 0;
      const saldoAcum = saldoAcumuladoPrevisto[index] ?? 0;

      // Saldo do dia (apenas se diferente de zero)
      if (saldoDia !== 0) {
        itensParaInserir.push({
          tipo: 'saldo_diario',
          data,
          categoria: 'Saldo diário calculado',
          valor: Math.round(saldoDia * 100) / 100,
          areaId: null,
          contaId: null,
          tipoReceitaId: null,
          bancoId: null,
          ordem: 9000 + index, // Ordem alta para aparecer após receitas e gastos
        });
      }

      // Saldo acumulado
      itensParaInserir.push({
        tipo: 'saldo_acumulado',
        data,
        categoria: 'Saldo acumulado calculado',
        valor: Math.round(saldoAcum * 100) / 100,
        areaId: null,
        contaId: null,
        tipoReceitaId: null,
        bancoId: null,
        ordem: 9500 + index, // Ordem ainda maior
      });
    });

    if (itensParaInserir.length === 0) {
      setMensagem({ tipo: 'erro', texto: 'Nenhum valor válido foi encontrado para importação.' });
      return;
    }
    try {
      setImportando(true);
      setMensagem(null);
      const supabase = getSupabaseClient();
      // Todos os usuários podem visualizar e importar semanas (dados compartilhados)
      const { data: semanaExistente, error: semanaErro } = await supabase
        .from('pvs_semanas')
        .select('pvs_id')
        .eq('pvs_semana_inicio', semanaSelecionada)
        .maybeSingle();

      if (semanaErro) throw semanaErro;

      let semanaId = semanaExistente?.pvs_id as number | undefined;
      const semanaFim = toISODate(addDays(new Date(`${semanaSelecionada}T00:00:00`), 4));
      let chavesParaInserir = new Set<string>(); // Chaves dos itens que devem ser inseridos

      // Se estamos em modo de edição, remove todos os itens existentes e insere os novos
      if (modoEdicao && semanaId) {
        // Deleta todos os itens da semana
        const { error: deletarErro } = await supabase
          .from('pvi_previsao_itens')
          .delete()
          .eq('pvi_pvs_id', semanaId);

        if (deletarErro) throw deletarErro;

        // Verifica se todos os itens foram realmente deletados
        const { data: itensRestantes, error: verificarErro } = await supabase
          .from('pvi_previsao_itens')
          .select('pvi_id')
          .eq('pvi_pvs_id', semanaId);

        if (verificarErro) throw verificarErro;

        if (itensRestantes && itensRestantes.length > 0) {
          throw new Error(`Falha ao deletar todos os itens. ${itensRestantes.length} item(ns) ainda existe(m).`);
        }

        // Atualiza status da semana
        const { error: atualizarErro } = await supabase
          .from('pvs_semanas')
          .update({ pvs_semana_fim: semanaFim, pvs_status: 'editado' })
          .eq('pvs_id', semanaId);
        if (atualizarErro) throw atualizarErro;

        // Marca todos os itens para inserção
        itensParaInserir.forEach(item => {
          const chave = `${item.data}|${item.tipo}|${item.categoria}`;
          chavesParaInserir.add(chave);
        });
      } else if (modoInclusao && semanaId) {
        // Modo de inclusão: apenas adiciona novos itens sem deletar existentes
        // Atualiza status da semana
        const { error: atualizarErro } = await supabase
          .from('pvs_semanas')
          .update({ pvs_semana_fim: semanaFim, pvs_status: 'complementado' })
          .eq('pvs_id', semanaId);
        if (atualizarErro) throw atualizarErro;

        // Marca todos os itens para inserção
        itensParaInserir.forEach(item => {
          const chave = `${item.data}|${item.tipo}|${item.categoria}`;
          chavesParaInserir.add(chave);
        });
      } else if (!semanaId) {
        const { data: criada, error: criarErro } = await supabase
          .from('pvs_semanas')
          .insert({
            pvs_usr_id: usuario.usr_id,
            pvs_semana_inicio: semanaSelecionada,
            pvs_semana_fim: semanaFim,
            pvs_status: 'importado',
          })
          .select('pvs_id')
          .single();

        if (criarErro) throw criarErro;
        semanaId = criada?.pvs_id as number | undefined;

        // Semana nova - todos os itens devem ser inseridos
        itensParaInserir.forEach(item => {
          const chave = `${item.data}|${item.tipo}|${item.categoria}`;
          chavesParaInserir.add(chave);
        });
      } else {
        // Semana já existe - carregar itens existentes para comparação
        const { data: itensExistentes, error: carregarErro } = await supabase
          .from('pvi_previsao_itens')
          .select('pvi_id, pvi_data, pvi_tipo, pvi_categoria, pvi_valor')
          .eq('pvi_pvs_id', semanaId);

        if (carregarErro) throw carregarErro;

        // Compara valores e identifica diferenças
        const itensExistentesMap = new Map<string, any>();
        (itensExistentes || []).forEach(item => {
          const chave = `${item.pvi_data}|${item.pvi_tipo}|${item.pvi_categoria}`;
          itensExistentesMap.set(chave, item);
        });

        const idsParaDeletar: number[] = [];
        const itensNovos: typeof itensParaInserir = [];
        const itensModificados: Array<{ existente: number; novo: number }> = [];
        let totalIguais = 0;

        itensParaInserir.forEach(itemNovo => {
          const chave = `${itemNovo.data}|${itemNovo.tipo}|${itemNovo.categoria}`;
          const itemExistente = itensExistentesMap.get(chave);

          if (itemExistente) {
            // Item existe - verifica se valor mudou
            const valorExistente = Math.round(Number(itemExistente.pvi_valor) * 100) / 100;
            const valorNovo = Math.round(itemNovo.valor * 100) / 100;

            if (Math.abs(valorExistente - valorNovo) > 0.01) {
              // Valor diferente - marca para deletar e reinserir
              idsParaDeletar.push(itemExistente.pvi_id);
              chavesParaInserir.add(chave);
              itensModificados.push({ existente: valorExistente, novo: valorNovo });
            } else {
              // Valor igual - ignora completamente (não insere novamente)
              totalIguais++;
              itensExistentesMap.delete(chave);
            }
          } else {
            // Item novo - marca para inserir
            chavesParaInserir.add(chave);
            itensNovos.push(itemNovo);
          }
        });

        // Itens removidos (estão no banco mas não no arquivo)
        const itensRemovidos = Array.from(itensExistentesMap.values());
        itensRemovidos.forEach(item => {
          idsParaDeletar.push(item.pvi_id);
        });

        // Se há diferenças, pede confirmação via modal
        const totalDiferencas = itensModificados.length + itensNovos.length + itensRemovidos.length;

        if (totalDiferencas > 0) {
          // Mostra modal e aguarda confirmação
          await new Promise<void>((resolve, reject) => {
            setModalResumo({
              iguais: totalIguais,
              modificados: itensModificados.length,
              novos: itensNovos.length,
              removidos: itensRemovidos.length,
              itensNovosDetalhes: itensNovos.map(item => ({
                data: item.data,
                tipo: item.tipo,
                categoria: item.categoria,
                valor: item.valor
              })),
              itensModificadosDetalhes: itensModificados.map((mod, idx) => {
                const itemNovo = itensParaInserir.find(it => {
                  const chave = `${it.data}|${it.tipo}|${it.categoria}`;
                  return chavesParaInserir.has(chave) && Math.abs(it.valor - mod.novo) < 0.01;
                });
                return {
                  data: itemNovo?.data || '',
                  tipo: itemNovo?.tipo || '',
                  categoria: itemNovo?.categoria || '',
                  valorAntigo: mod.existente,
                  valorNovo: mod.novo
                };
              }),
              itensRemovidosDetalhes: itensRemovidos.map(item => ({
                data: item.pvi_data,
                tipo: item.pvi_tipo,
                categoria: item.pvi_categoria,
                valor: Number(item.pvi_valor)
              })),
              onConfirm: async () => {
                setModalResumo(null);
                resolve();
              },
              onCancel: () => {
                setModalResumo(null);
                reject(new Error('Importação cancelada pelo usuário'));
              }
            });
          });
        }

        // Atualiza status da semana
        const { error: atualizarErro } = await supabase
          .from('pvs_semanas')
          .update({ pvs_semana_fim: semanaFim, pvs_status: 'importado' })
          .eq('pvs_id', semanaId);
        if (atualizarErro) throw atualizarErro;

        // Deleta apenas os itens que mudaram ou não existem mais
        if (idsParaDeletar.length > 0) {
          const { error: deletarErro } = await supabase
            .from('pvi_previsao_itens')
            .delete()
            .in('pvi_id', idsParaDeletar);
          if (deletarErro) throw deletarErro;
        }
      }

      if (!semanaId) {
        throw new Error('Semana não pôde ser determinada para importação.');
      }

      // Prepara payload apenas com itens novos ou modificados (ignora duplicados)
      const payload = itensParaInserir
        .filter(item => {
          const chave = `${item.data}|${item.tipo}|${item.categoria}`;
          // Insere apenas itens marcados para inserção (novos ou modificados)
          return chavesParaInserir.has(chave);
        })
        .map((item) => ({
          pvi_pvs_id: semanaId,
          pvi_usr_id: usuario.usr_id,
          pvi_data: item.data,
          pvi_tipo: item.tipo,
          pvi_categoria: item.categoria,
          pvi_valor: item.valor,
          pvi_are_id: item.areaId,
          pvi_ctr_id: item.contaId,
          pvi_tpr_id: item.tipoReceitaId,
          pvi_ban_id: item.bancoId,
          pvi_ordem: item.ordem,
          pvi_importado: true,
        }));

      // Insere apenas itens novos ou que foram deletados para atualização
      if (payload.length > 0) {
        const { error: inserirErro } = await supabase.from('pvi_previsao_itens').insert(payload);
        if (inserirErro) throw inserirErro;
      }

      const mensagemSucesso = modoEdicao
        ? 'Alterações salvas com sucesso.'
        : modoInclusao
        ? 'Novos itens incluídos com sucesso.'
        : 'Previsão semanal importada com sucesso.';

      setMensagem({ tipo: 'sucesso', texto: mensagemSucesso });

      // Limpa modo de edição ou inclusão se estava ativo
      if (modoEdicao) {
        setModoEdicao(false);
        setLinhas([]);
      }
      if (modoInclusao) {
        setModoInclusao(false);
        setLinhas([]);
      }

      await carregarPrevisaoExistente(semanaSelecionada, usuario.usr_id);
    } catch (error: any) {
      console.error('Erro ao importar previsão semanal:', error);

      // Se foi cancelamento pelo usuário, mostra mensagem diferente
      if (error.message === 'Importação cancelada pelo usuário') {
        setMensagem({
          tipo: 'info',
          texto: 'Importação cancelada pelo usuário.',
        });
      } else {
        setMensagem({
          tipo: 'erro',
          texto: traduzirErroSupabase(
            error,
            'Falha ao importar a previsão semanal. Verifique os dados e tente novamente.',
          ),
        });
      }
    } finally {
      setImportando(false);
    }
  };
  if (carregandoInicial) {
    return (
      <>
        <Header title="Previsão Semanal" />
        <div className="page-content flex h-96 items-center justify-center">
          <Loading text="Carregando informações iniciais..." />
        </div>
      </>
    );
  }

  if (erroInicial) {
    return (
      <>
        <Header title="Previsão Semanal" />
        <div className="page-content">
          <Card>
            <p className="text-sm text-error-700">{erroInicial}</p>
          </Card>
        </div>
      </>
    );
  }
  return (
    <>
      <Header
        title="Previsão Semanal"
        subtitle="Importe os dados previstos de recebimentos e gastos para a próxima semana"
      />

      <div className="page-content space-y-6">
        <Card>
          <div className="space-y-4">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
              <label className="text-sm font-medium text-gray-700">
                Semana de referência
                <select
                  className="mt-1 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                  value={semanaSelecionada}
                  onChange={(event) => {
                    setSemanaSelecionada(event.target.value);
                  }}
                >
                  {semanasDisponiveis.map((semana) => (
                    <option key={semana.value} value={semana.value}>
                      {semana.label}
                    </option>
                  ))}
                </select>
              </label>

              <div className="flex flex-col gap-3">
                {!modoEdicao && !modoInclusao && (
                  <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                    {/* Bloco: Arquivo Excel */}
                    <div className="flex flex-col gap-3 rounded-md border border-gray-200 bg-white p-4">
                      <p className="text-xs font-semibold uppercase tracking-wide text-gray-600">
                        Arquivo Excel
                      </p>
                      <input
                        type="file"
                        accept=".xlsx,.xls"
                        className="hidden"
                        ref={arquivoInputRef}
                        onChange={handleArquivoChange}
                        disabled={processandoArquivo || !edicaoPermitida}
                        id="arquivo-excel-input"
                      />
                      <label htmlFor="arquivo-excel-input" className="cursor-pointer">
                        <span
                          className={`inline-flex items-center justify-center rounded-md border px-4 py-2 text-sm font-medium transition-colors ${
                            processandoArquivo || !edicaoPermitida
                              ? 'cursor-not-allowed border-gray-200 bg-gray-100 text-gray-400'
                              : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
                          }`}
                        >
                          Escolher arquivo
                        </span>
                      </label>
                      {arquivoNome && (
                        <p className="text-xs text-gray-600">
                          <span className="font-medium">Arquivo:</span> {arquivoNome}
                        </p>
                      )}
                      <div className="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={handleCancelarArquivo}
                          disabled={!arquivoNome || processandoArquivo}
                        >
                          Cancelar seleção
                        </Button>
                        <Button
                          type="button"
                          variant="primary"
                          size="sm"
                          onClick={handleImportar}
                          disabled={
                            !edicaoPermitida || importando || linhas.length === 0 || processandoArquivo
                          }
                          loading={importando}
                        >
                          Importar previsão
                        </Button>
                      </div>
                    </div>

                    {/* Bloco: Ações sobre o arquivo existente */}
                    {previsaoExistente && (
                      <div className="flex flex-col gap-3 rounded-md border border-primary-200 bg-primary-50/30 p-4">
                        <p className="text-xs font-semibold uppercase tracking-wide text-primary-800">
                          Ações sobre a previsão existente
                        </p>
                        <p className="text-xs text-primary-700">
                          Status atual: <span className="font-semibold">{previsaoExistente.status}</span>
                        </p>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            onClick={handleIniciarEdicao}
                            disabled={!edicaoPermitida}
                          >
                            Editar lançamentos
                          </Button>
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            onClick={handleIniciarInclusao}
                            disabled={!edicaoPermitida}
                          >
                            + Categorias
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Modo de edição ativo */}
                {modoEdicao && (
                  <div className="flex flex-col gap-2 rounded-md border border-warning-200 bg-warning-50/30 p-3">
                    <p className="text-xs font-medium text-warning-800">
                      Modo de edição ativo
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={handleCancelarEdicao}
                        disabled={importando}
                      >
                        Cancelar edição
                      </Button>
                      <Button
                        type="button"
                        variant="primary"
                        size="sm"
                        onClick={handleImportar}
                        disabled={importando || linhas.length === 0}
                        loading={importando}
                      >
                        Salvar alterações
                      </Button>
                    </div>
                  </div>
                )}

                {/* Modo de inclusão ativo */}
                {modoInclusao && (
                  <div className="flex flex-col gap-2 rounded-md border border-primary-200 bg-primary-50/30 p-3">
                    <p className="text-xs font-medium text-primary-800">
                      Modo de inclusão ativo - Adicione novas categorias
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={handleCancelarInclusao}
                        disabled={importando}
                      >
                        Cancelar inclusão
                      </Button>
                      <Button
                        type="button"
                        variant="primary"
                        size="sm"
                        onClick={handleImportar}
                        disabled={importando || linhas.length === 0}
                        loading={importando}
                      >
                        Salvar inclusão
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {!edicaoPermitida && (
              <div className="rounded-md border border-warning-200 bg-warning-50 px-4 py-3 text-sm text-warning-800">
                A edição está bloqueada para semanas passadas. Somente a semana corrente e semanas futuras podem ser importadas.
              </div>
            )}

            {arquivoNome && (
              <p className="text-xs text-gray-500">Arquivo selecionado: {arquivoNome}</p>
            )}

            {!modoEdicao && !modoInclusao && (
              <div className="rounded-md border border-gray-200 bg-gray-50 px-4 py-3">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1">
                    <p className="text-sm font-medium text-gray-700">Precisa de um template?</p>
                    <p className="mt-1 text-xs text-gray-600">
                      Baixe um modelo de planilha pré-formatado com as datas da semana selecionada e exemplos de lançamentos.
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={handleBaixarTemplate}
                  >
                    Baixar template
                  </Button>
                </div>
              </div>
            )}

            {mensagem && (
              <div
                className={`rounded-md border px-4 py-3 text-sm ${
                  mensagem.tipo === 'sucesso'
                    ? 'border-success-200 bg-success-50 text-success-700'
                    : mensagem.tipo === 'erro'
                    ? 'border-error-200 bg-error-50 text-error-700'
                    : 'border-primary-200 bg-primary-50 text-primary-800'
                }`}
              >
                {mensagem.texto}
              </div>
            )}
          </div>
        </Card>
        {processandoArquivo && (
          <Card>
            <div className="py-6">
              <Loading text="Processando planilha..." />
            </div>
          </Card>
        )}
        {linhas.length > 0 && (
          <div className="space-y-4">
            {/* Bloco: Receitas */}
            {linhas.some((l) => l.tipo === 'receita' || l.tipo === 'saldo_inicial') && (
              <Card
                title="Receitas"
                headerAction={
                  modoInclusao ? (
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => handleAdicionarLinha('receita')}
                      disabled={importando}
                    >
                      + Receita
                    </Button>
                  ) : undefined
                }
              >
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-gray-200 text-sm">
                    <thead className="bg-success-50">
                      <tr>
                        <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-success-700">
                          Incluir
                        </th>
                        <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-success-700">
                          Conta de Receita
                        </th>
                        <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-success-700">
                          Tipo de Receita
                        </th>
                        {datasTabela.map((data) => (
                          <th
                            key={data}
                            className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-success-700"
                          >
                            {formatarDataPt(data)}
                          </th>
                        ))}
                        {(modoInclusao || modoEdicao) && (
                          <th className="px-3 py-2 text-center text-xs font-semibold uppercase tracking-wide text-success-700">
                            Ações
                          </th>
                        )}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 bg-white/80">
                      {linhas.filter((l) => l.tipo === 'receita' || l.tipo === 'saldo_inicial').map((linha) => {
                      const contaRelacionada = encontrarContaPorId(contas, linha.contaId);
                      const tipoRelacionado = encontrarTipoPorId(tiposReceita, linha.tipoReceitaId);
                      return (
                        <React.Fragment key={linha.id}>
                          <tr>
                            <td className="px-3 py-2 align-top">
                              <input
                                type="checkbox"
                                className="h-4 w-4 text-success-600 focus:ring-success-500"
                                checked={linha.selecionado}
                                onChange={(event) => handleToggleLinha(linha.id, event.target.checked)}
                              />
                            </td>
                            <td className="px-3 py-2 align-top">
                              {linha.tipo === 'saldo_inicial' ? (
                                <span className="text-sm text-gray-500">Saldo inicial</span>
                              ) : (
                                <select
                                  className="w-64 rounded-md border border-gray-300 bg-white px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-success-500"
                                  value={linha.contaId ?? ''}
                                  onChange={(event) =>
                                    handleContaChange(
                                      linha.id,
                                      event.target.value ? Number(event.target.value) : null,
                                    )
                                  }
                                >
                                  <option value="">Selecione uma conta</option>
                                  {contas.map((conta) => (
                                    <option key={conta.id} value={conta.id}>
                                      {conta.nome}
                                      {conta.bancoNome ? ` • ${conta.bancoNome}` : ''}
                                    </option>
                                  ))}
                                </select>
                              )}
                            </td>
                            <td className="px-3 py-2 align-top">
                              {linha.tipo === 'saldo_inicial' ? (
                                <span className="text-sm text-gray-500">—</span>
                              ) : (
                                <select
                                  className="w-56 rounded-md border border-gray-300 bg-white px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-success-500"
                                  value={linha.tipoReceitaId ?? ''}
                                  onChange={(event) =>
                                    handleTipoReceitaChange(
                                      linha.id,
                                      event.target.value ? Number(event.target.value) : null,
                                    )
                                  }
                                >
                                  <option value="">Tipo de receita</option>
                                  {tiposReceita.map((tipo) => (
                                    <option key={tipo.id} value={tipo.id}>
                                      {tipo.nome}
                                    </option>
                                  ))}
                                </select>
                              )}
                            </td>
                            {linha.valores.map((valor) => (
                              <td key={valor.data} className="px-3 py-2 align-top text-right">
                                <input
                                  type="text"
                                  inputMode="decimal"
                                  pattern="[0-9.,-]*"
                                  placeholder="0,00"
                                  autoComplete="off"
                                  className="w-28 rounded-md border border-gray-300 px-2 py-1 text-right text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                                  value={valor.texto}
                                  onChange={(event) =>
                                    handleValorChange(linha.id, valor.data, event.target.value)
                                  }
                                  onBlur={() => handleValorBlur(linha.id, valor.data)}
                                  disabled={linha.tipo === 'saldo_inicial' && valor.data !== datasTabela[0]}
                                />
                              </td>
                            ))}
                            {(modoInclusao || modoEdicao) && (
                              <td className="px-3 py-2 align-top text-center">
                                <button
                                  type="button"
                                  className="rounded-md px-2 py-1 text-xs text-error-600 hover:bg-error-50 hover:text-error-700 focus:outline-none focus:ring-2 focus:ring-error-500"
                                  onClick={() => handleRemoverLinha(linha.id)}
                                  title="Remover linha"
                                >
                                  ✕
                                </button>
                              </td>
                            )}
                          </tr>
                          {linha.erros.length > 0 && (
                            <tr>
                              <td colSpan={3 + datasTabela.length + (modoInclusao || modoEdicao ? 1 : 0)} className="bg-error-50 px-3 py-2 text-xs text-error-700">
                                {linha.erros.join(' ')}
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          {/* Bloco: Despesas */}
          {linhas.some((l) => l.tipo === 'gasto') && (
            <Card
              title="Despesas"
              headerAction={
                modoInclusao ? (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => handleAdicionarLinha('gasto')}
                    disabled={importando}
                  >
                    + Gasto
                  </Button>
                ) : undefined
              }
            >
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200 text-sm">
                  <thead className="bg-error-50">
                    <tr>
                      <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-error-700">
                        Incluir
                      </th>
                      <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-error-700">
                        Área
                      </th>
                      {datasTabela.map((data) => (
                        <th
                          key={data}
                          className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-error-700"
                        >
                          {formatarDataPt(data)}
                        </th>
                      ))}
                      {(modoInclusao || modoEdicao) && (
                        <th className="px-3 py-2 text-center text-xs font-semibold uppercase tracking-wide text-error-700">
                          Ações
                        </th>
                      )}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 bg-white/80">
                    {linhas.filter((l) => l.tipo === 'gasto').map((linha) => {
                      const areaRelacionada = encontrarAreaPorId(areas, linha.areaId);
                      return (
                        <React.Fragment key={linha.id}>
                          <tr>
                            <td className="px-3 py-2 align-top">
                              <input
                                type="checkbox"
                                className="h-4 w-4 text-error-600 focus:ring-error-500"
                                checked={linha.selecionado}
                                onChange={(event) => handleToggleLinha(linha.id, event.target.checked)}
                              />
                            </td>
                            <td className="px-3 py-2 align-top">
                              <select
                                className="w-64 rounded-md border border-gray-300 bg-white px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-error-500"
                                value={linha.areaId ?? ''}
                                onChange={(event) =>
                                  handleAreaChange(
                                    linha.id,
                                    event.target.value ? Number(event.target.value) : null,
                                  )
                                }
                              >
                                <option value="">Selecione uma área</option>
                                {areas.map((area) => (
                                  <option key={area.id} value={area.id}>
                                    {area.nome}
                                  </option>
                                ))}
                              </select>
                            </td>
                            {linha.valores.map((valor) => (
                              <td key={valor.data} className="px-3 py-2 align-top text-right">
                                <input
                                  type="text"
                                  inputMode="decimal"
                                  pattern="[0-9.,-]*"
                                  placeholder="0,00"
                                  autoComplete="off"
                                  className="w-28 rounded-md border border-gray-300 px-2 py-1 text-right text-sm focus:outline-none focus:ring-2 focus:ring-error-500"
                                  value={valor.texto}
                                  onChange={(event) =>
                                    handleValorChange(linha.id, valor.data, event.target.value)
                                  }
                                  onBlur={() => handleValorBlur(linha.id, valor.data)}
                                />
                              </td>
                            ))}
                            {(modoInclusao || modoEdicao) && (
                              <td className="px-3 py-2 align-top text-center">
                                <button
                                  type="button"
                                  className="rounded-md px-2 py-1 text-xs text-error-600 hover:bg-error-50 hover:text-error-700 focus:outline-none focus:ring-2 focus:ring-error-500"
                                  onClick={() => handleRemoverLinha(linha.id)}
                                  title="Remover linha"
                                >
                                  ✕
                                </button>
                              </td>
                            )}
                          </tr>
                          {linha.erros.length > 0 && (
                            <tr>
                              <td colSpan={2 + datasTabela.length + (modoInclusao || modoEdicao ? 1 : 0)} className="bg-error-50 px-3 py-2 text-xs text-error-700">
                                {linha.erros.join(' ')}
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          {/* Resumo financeiro */}
          <Card title="Resumo Financeiro">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 shadow-sm">
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-600">Saldo inicial</p>
                <p className="mt-2 text-2xl font-semibold text-gray-900">{formatCurrency(saldoInicialValor)}</p>
              </div>
              <div className="rounded-lg border border-success-200 bg-success-50/60 p-4 shadow-sm">
                <p className="text-xs font-semibold uppercase tracking-wide text-success-700">Total de receitas</p>
                <p className="mt-2 text-2xl font-semibold text-success-800">
                  {formatCurrency(totaisReceita.reduce((acc, valor) => acc + valor, 0))}
                </p>
              </div>
              <div className="rounded-lg border border-error-200 bg-error-50/70 p-4 shadow-sm">
                <p className="text-xs font-semibold uppercase tracking-wide text-error-700">Total de despesas</p>
                <p className="mt-2 text-2xl font-semibold text-error-800">
                  {formatCurrency(totaisGasto.reduce((acc, valor) => acc + valor, 0))}
                </p>
              </div>
              <div className="rounded-lg border border-primary-200 bg-primary-50 p-4 shadow-sm">
                <p className="text-xs font-semibold uppercase tracking-wide text-primary-700">Saldo final</p>
                <p className="mt-2 text-2xl font-semibold text-primary-900">
                  {formatCurrency(saldoAcumuladoPrevisto[saldoAcumuladoPrevisto.length - 1] ?? 0)}
                </p>
              </div>
            </div>
          </Card>
        </div>
        )}
        <Card title="Previsão registrada">
          {carregandoPrevisao ? (
            <div className="py-6">
              <Loading text="Buscando dados registrados..." />
            </div>
          ) : !previsaoExistente ? (
            <p className="text-sm text-gray-500">
              Nenhum dado foi importado para a semana selecionada até o momento.
            </p>
          ) : previsaoExistente.itens.length === 0 ? (
            <p className="text-sm text-gray-500">
              A semana selecionada está cadastrada, mas ainda não possui itens importados.
            </p>
          ) : (() => {
              // Agrupar itens por data
              const itensPorData = previsaoExistente.itens.reduce((acc, item) => {
                if (!acc[item.data]) {
                  acc[item.data] = [];
                }
                acc[item.data].push(item);
                return acc;
              }, {} as Record<string, typeof previsaoExistente.itens>);

              // Calcular saldo acumulado
              const datas = Object.keys(itensPorData).sort();
              let saldoAcumulado = 0;
              const saldosPorData: Record<string, number> = {};

              datas.forEach(data => {
                const itensData = itensPorData[data];
                // Não considerar saldo_diario e saldo_acumulado nos totais
                const totalReceitas = itensData.filter(i => i.tipo === 'receita').reduce((sum, i) => sum + i.valor, 0);
                const totalGastos = itensData.filter(i => i.tipo === 'gasto').reduce((sum, i) => sum + i.valor, 0);
                saldoAcumulado += (totalReceitas - totalGastos);
                saldosPorData[data] = saldoAcumulado;
              });

              const toggleData = (data: string) => {
                setDatasExpandidas(prev => {
                  const novo = new Set(prev);
                  if (novo.has(data)) {
                    novo.delete(data);
                  } else {
                    novo.add(data);
                  }
                  return novo;
                });
              };

              return (
                <div className="space-y-4">
                  <p className="text-sm text-gray-500">
                    Status atual: <span className="font-semibold text-gray-900">{previsaoExistente.status}</span>
                  </p>
                  <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-gray-200 text-sm">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-3 py-2 text-left font-semibold text-gray-600 w-8"></th>
                          <th className="px-3 py-2 text-left font-semibold text-gray-600">Data</th>
                          <th className="px-3 py-2 text-left font-semibold text-gray-600">Tipo</th>
                          <th className="px-3 py-2 text-left font-semibold text-gray-600">Categoria</th>
                          <th className="px-3 py-2 text-left font-semibold text-gray-600">Associação</th>
                          <th className="px-3 py-2 text-right font-semibold text-gray-600">Valor</th>
                          <th className="px-3 py-2 text-right font-semibold text-gray-600">Saldo</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100 bg-white/80">
                        {datas.map((data) => {
                          const itensData = itensPorData[data];
                          const expandido = datasExpandidas.has(data);
                          const totalReceitas = itensData.filter(i => i.tipo === 'receita').reduce((sum, i) => sum + i.valor, 0);
                          const totalGastos = itensData.filter(i => i.tipo === 'gasto').reduce((sum, i) => sum + i.valor, 0);
                          const saldoDia = totalReceitas - totalGastos;

                          return (
                            <React.Fragment key={data}>
                              {/* Linha de resumo da data */}
                              <tr className="bg-primary-50/50 hover:bg-primary-50 cursor-pointer font-medium" onClick={() => toggleData(data)}>
                                <td className="px-3 py-2 text-center text-primary-600">
                                  <span className="inline-block w-4">{expandido ? '−' : '+'}</span>
                                </td>
                                <td className="px-3 py-2 text-gray-900">{formatarDataPt(data)}</td>
                                <td className="px-3 py-2 text-gray-600" colSpan={2}>
                                  {itensData.length} {itensData.length === 1 ? 'lançamento' : 'lançamentos'}
                                </td>
                                <td className="px-3 py-2 text-right text-gray-700">
                                  <span className="text-xs text-gray-500">Receitas: </span>
                                  <span className="text-success-700">{formatCurrency(totalReceitas)}</span>
                                </td>
                                <td className="px-3 py-2 text-right text-gray-700">
                                  <span className="text-xs text-gray-500">Despesas: </span>
                                  <span className="text-error-700">{formatCurrency(totalGastos)}</span>
                                </td>
                                <td className={`px-3 py-2 text-right font-bold ${saldoDia >= 0 ? 'text-success-700' : 'text-error-700'}`}>
                                  {formatCurrency(saldoDia)}
                                </td>
                              </tr>

                              {/* Itens expandidos */}
                              {expandido && itensData.map((item) => {
                                const conta = encontrarContaPorId(contas, item.contaId);
                                const area = encontrarAreaPorId(areas, item.areaId);
                                const banco = bancos.find((b) => b.id === item.bancoId) ?? null;
                                return (
                                  <tr key={item.id} className="bg-white/60">
                                    <td className="px-3 py-2"></td>
                                    <td className="px-3 py-2 text-gray-400 text-xs">↳</td>
                                    <td className="px-3 py-2 text-gray-700">{item.tipo}</td>
                                    <td className="px-3 py-2 text-gray-700">{item.categoria}</td>
                                    <td className="px-3 py-2 text-gray-500">
                                      {item.tipo === 'receita' && conta
                                        ? `${conta.nome}${conta.bancoNome ? ` • ${conta.bancoNome}` : ''}`
                                        : item.tipo === 'gasto' && area
                                        ? area.nome
                                        : banco
                                        ? banco.nome
                                        : '—'}
                                    </td>
                                    <td className="px-3 py-2 text-right font-semibold text-gray-900" colSpan={2}>
                                      {formatCurrency(item.valor)}
                                    </td>
                                  </tr>
                                );
                              })}
                            </React.Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })()}
        </Card>
      </div>

      {/* Modal de confirmação de reimportação */}
      {modalResumo && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 overflow-y-auto">
          <div className="w-full max-w-3xl rounded-lg border border-gray-200 bg-white shadow-xl my-8">
            <div className="border-b border-gray-200 px-6 py-4">
              <h3 className="text-lg font-semibold text-gray-900">Reimportação Detectada</h3>
              <p className="mt-1 text-sm text-gray-500">
                A previsão desta semana já possui dados registrados. Revise as alterações abaixo:
              </p>
            </div>

            <div className="space-y-3 px-6 py-4 max-h-[60vh] overflow-y-auto">
              {/* Itens iguais */}
              <div className="flex items-center justify-between rounded-md border border-success-200 bg-success-50/40 px-4 py-3">
                <div className="flex items-center gap-2">
                  <span className="text-success-700">✓</span>
                  <span className="text-sm font-medium text-success-900">Itens iguais</span>
                </div>
                <span className="text-lg font-bold text-success-700">{modalResumo.iguais}</span>
              </div>

              {/* Itens modificados */}
              {modalResumo.modificados > 0 && (
                <div className="space-y-2">
                  <div
                    className="flex items-center justify-between rounded-md border border-warning-200 bg-warning-50/40 px-4 py-3 cursor-pointer hover:bg-warning-50"
                    onClick={() => setSecoesExpandidas(prev => ({ ...prev, modificados: !prev.modificados }))}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-warning-700">⚠</span>
                      <span className="text-sm font-medium text-warning-900">Itens modificados</span>
                      <span className="text-xs text-warning-600">(clique para {secoesExpandidas.modificados ? 'ocultar' : 'ver detalhes'})</span>
                    </div>
                    <span className="text-lg font-bold text-warning-700">{modalResumo.modificados}</span>
                  </div>
                  {secoesExpandidas.modificados && (
                    <div className="ml-4 rounded border border-warning-200 bg-white p-3">
                      <table className="w-full text-xs">
                        <thead className="bg-gray-50">
                          <tr>
                            <th className="px-2 py-1 text-left font-medium text-gray-600">Data</th>
                            <th className="px-2 py-1 text-left font-medium text-gray-600">Tipo</th>
                            <th className="px-2 py-1 text-left font-medium text-gray-600">Categoria</th>
                            <th className="px-2 py-1 text-right font-medium text-gray-600">Valor Antigo</th>
                            <th className="px-2 py-1 text-center font-medium text-gray-600">→</th>
                            <th className="px-2 py-1 text-right font-medium text-gray-600">Valor Novo</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                          {modalResumo.itensModificadosDetalhes.map((item, idx) => (
                            <tr key={idx} className="hover:bg-gray-50">
                              <td className="px-2 py-1 text-gray-700">{formatarDataPt(item.data)}</td>
                              <td className="px-2 py-1 text-gray-700">{item.tipo}</td>
                              <td className="px-2 py-1 text-gray-700">{item.categoria}</td>
                              <td className="px-2 py-1 text-right text-gray-500 line-through">{formatCurrency(item.valorAntigo)}</td>
                              <td className="px-2 py-1 text-center text-warning-600">→</td>
                              <td className="px-2 py-1 text-right font-semibold text-warning-700">{formatCurrency(item.valorNovo)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

              {/* Itens novos */}
              {modalResumo.novos > 0 && (
                <div className="space-y-2">
                  <div
                    className="flex items-center justify-between rounded-md border border-primary-200 bg-primary-50/40 px-4 py-3 cursor-pointer hover:bg-primary-50"
                    onClick={() => setSecoesExpandidas(prev => ({ ...prev, novos: !prev.novos }))}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-primary-700">+</span>
                      <span className="text-sm font-medium text-primary-900">Itens novos</span>
                      <span className="text-xs text-primary-600">(clique para {secoesExpandidas.novos ? 'ocultar' : 'ver detalhes'})</span>
                    </div>
                    <span className="text-lg font-bold text-primary-700">{modalResumo.novos}</span>
                  </div>
                  {secoesExpandidas.novos && (
                    <div className="ml-4 rounded border border-primary-200 bg-white p-3">
                      <table className="w-full text-xs">
                        <thead className="bg-gray-50">
                          <tr>
                            <th className="px-2 py-1 text-left font-medium text-gray-600">Data</th>
                            <th className="px-2 py-1 text-left font-medium text-gray-600">Tipo</th>
                            <th className="px-2 py-1 text-left font-medium text-gray-600">Categoria</th>
                            <th className="px-2 py-1 text-right font-medium text-gray-600">Valor</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                          {modalResumo.itensNovosDetalhes.map((item, idx) => (
                            <tr key={idx} className="hover:bg-gray-50">
                              <td className="px-2 py-1 text-gray-700">{formatarDataPt(item.data)}</td>
                              <td className="px-2 py-1 text-gray-700">{item.tipo}</td>
                              <td className="px-2 py-1 text-gray-700">{item.categoria}</td>
                              <td className="px-2 py-1 text-right font-semibold text-primary-700">{formatCurrency(item.valor)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

              {/* Itens removidos */}
              {modalResumo.removidos > 0 && (
                <div className="space-y-2">
                  <div
                    className="flex items-center justify-between rounded-md border border-error-200 bg-error-50/40 px-4 py-3 cursor-pointer hover:bg-error-50"
                    onClick={() => setSecoesExpandidas(prev => ({ ...prev, removidos: !prev.removidos }))}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-error-700">−</span>
                      <span className="text-sm font-medium text-error-900">Itens removidos</span>
                      <span className="text-xs text-error-600">(clique para {secoesExpandidas.removidos ? 'ocultar' : 'ver detalhes'})</span>
                    </div>
                    <span className="text-lg font-bold text-error-700">{modalResumo.removidos}</span>
                  </div>
                  {secoesExpandidas.removidos && (
                    <div className="ml-4 rounded border border-error-200 bg-white p-3">
                      <table className="w-full text-xs">
                        <thead className="bg-gray-50">
                          <tr>
                            <th className="px-2 py-1 text-left font-medium text-gray-600">Data</th>
                            <th className="px-2 py-1 text-left font-medium text-gray-600">Tipo</th>
                            <th className="px-2 py-1 text-left font-medium text-gray-600">Categoria</th>
                            <th className="px-2 py-1 text-right font-medium text-gray-600">Valor</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                          {modalResumo.itensRemovidosDetalhes.map((item, idx) => (
                            <tr key={idx} className="hover:bg-gray-50">
                              <td className="px-2 py-1 text-gray-700">{formatarDataPt(item.data)}</td>
                              <td className="px-2 py-1 text-gray-700">{item.tipo}</td>
                              <td className="px-2 py-1 text-gray-700">{item.categoria}</td>
                              <td className="px-2 py-1 text-right font-semibold text-error-700">{formatCurrency(item.valor)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

              <div className="mt-4 rounded-md border border-gray-200 bg-gray-50 px-4 py-3">
                <p className="text-xs text-gray-600">
                  <strong>Atenção:</strong> Itens iguais serão ignorados. Itens modificados e removidos serão excluídos do banco e substituídos pelos novos valores. Itens novos serão inseridos.
                </p>
              </div>
            </div>

            <div className="flex gap-3 border-t border-gray-200 px-6 py-4">
              <Button
                type="button"
                variant="ghost"
                onClick={modalResumo.onCancel}
                className="flex-1"
              >
                Cancelar
              </Button>
              <Button
                type="button"
                variant="primary"
                onClick={modalResumo.onConfirm}
                className="flex-1"
              >
                Confirmar Importação
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default LancamentoPrevisaoSemanalPage;
