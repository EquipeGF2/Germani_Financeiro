'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

import { Header } from '@/components/layout';
import { Button, Card, Input, Loading, Modal, Textarea } from '@/components/ui';
import { formatCurrency } from '@/lib/mathParser';
import {
  getOrCreateUser,
  getSupabaseClient,
  type UsuarioRow,
} from '@/lib/supabaseClient';
import { traduzirErroSupabase } from '@/lib/supabaseErrors';
import { getUserSession } from '@/lib/userSession';

const formatarData = (iso: string): string => {
  if (!iso) return '';
  const [ano, mes, dia] = iso.split('-');
  return `${dia}/${mes}/${ano}`;
};

const formatarIntervaloSemana = (inicio: string, fim: string): string => {
  if (!inicio) {
    return '';
  }
  const inicioFmt = formatarData(inicio);
  const fimFmt = fim ? formatarData(fim) : '';
  return fimFmt ? `${inicioFmt} a ${fimFmt}` : inicioFmt;
};

type SemanaOption = {
  id: number;
  inicio: string;
  fim: string;
  status: string | null;
};

type PrevisaoItem = {
  id: number;
  data: string;
  tipo: string;
  categoria: string;
  valor: number;
  ordem: number;
  areaCodigo?: string;
};

type ReportRow = {
  categoria: string;
  valores: Record<string, number>;
  total: number;
};

type RelatorioDados = {
  datas: string[];
  datasFormatadas: string[];
  receitas: ReportRow[];
  despesas: ReportRow[];
  totalReceitasPorData: Record<string, number>;
  totalDespesasPorData: Record<string, number>;
  totalReceitasGeral: number;
  totalDespesasGeral: number;
  saldoInicial: ReportRow | null;
  saldoDiario: ReportRow | null;
  saldoAcumulado: ReportRow | null;
};

const agruparPorCategoria = (itens: PrevisaoItem[], datas: string[]): ReportRow[] => {
  const mapa = new Map<string, { ordem: number; valores: Record<string, number>; areaCodigo: string }>();

  itens.forEach((item) => {
    const chave = item.categoria || 'Sem categoria';
    const existente = mapa.get(chave);
    if (existente) {
      existente.ordem = Math.min(existente.ordem, item.ordem ?? existente.ordem);
      existente.valores[item.data] = (existente.valores[item.data] ?? 0) + item.valor;
      // Mantém o menor areaCodigo (se disponível)
      if (item.areaCodigo && (!existente.areaCodigo || item.areaCodigo < existente.areaCodigo)) {
        existente.areaCodigo = item.areaCodigo;
      }
    } else {
      mapa.set(chave, {
        ordem: item.ordem ?? 0,
        valores: { [item.data]: item.valor },
        areaCodigo: item.areaCodigo || '',
      });
    }
  });

  return Array.from(mapa.entries())
    .sort((a, b) => {
      // Priorizar ordenação por areaCodigo se disponível
      const areaCodigoA = a[1].areaCodigo;
      const areaCodigoB = b[1].areaCodigo;

      if (areaCodigoA && areaCodigoB) {
        const codigoCompare = areaCodigoA.localeCompare(areaCodigoB, 'pt-BR', { numeric: true });
        if (codigoCompare !== 0) return codigoCompare;
      } else if (areaCodigoA && !areaCodigoB) {
        return -1; // Itens com código de área vêm primeiro
      } else if (!areaCodigoA && areaCodigoB) {
        return 1;
      }

      // Fallback para ordem original
      const ordemDiff = a[1].ordem - b[1].ordem;
      if (ordemDiff !== 0) return ordemDiff;

      return a[0].localeCompare(b[0], 'pt-BR');
    })
    .map(([categoria, info]) => {
      const valores = datas.reduce<Record<string, number>>((acc, data) => {
        const valor = info.valores[data] ?? 0;
        acc[data] = Math.round(valor * 100) / 100;
        return acc;
      }, {});
      const total = Object.values(valores).reduce((sum, valor) => sum + valor, 0);
      return { categoria, valores, total };
    })
    .filter((row) => row.total !== 0 || datas.some((data) => row.valores[data] !== 0));
};

const construirLinha = (
  itens: PrevisaoItem[],
  datas: string[],
  nomePadrao: string,
): ReportRow | null => {
  if (itens.length === 0) {
    return null;
  }
  const valores = datas.reduce<Record<string, number>>((acc, data) => {
    const totalData = itens
      .filter((item) => item.data === data)
      .reduce((sum, item) => sum + item.valor, 0);
    acc[data] = Math.round(totalData * 100) / 100;
    return acc;
  }, {});
  const total = Object.values(valores).reduce((sum, valor) => sum + valor, 0);
  if (total === 0) {
    return null;
  }
  return {
    categoria: itens[0]?.categoria || nomePadrao,
    valores,
    total,
  };
};

const RelatorioPrevisaoSemanalPage: React.FC = () => {
  const [usuario, setUsuario] = useState<UsuarioRow | null>(null);
  const [semanas, setSemanas] = useState<SemanaOption[]>([]);
  const [semanaSelecionada, setSemanaSelecionada] = useState<string | null>(null);
  const [carregandoUsuario, setCarregandoUsuario] = useState(true);
  const [carregandoDados, setCarregandoDados] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [relatorio, setRelatorio] = useState<RelatorioDados | null>(null);

  const [emailModalAberto, setEmailModalAberto] = useState(false);
  const [emailDestino, setEmailDestino] = useState('');
  const [emailMensagem, setEmailMensagem] = useState('');
  const [enviandoEmail, setEnviandoEmail] = useState(false);
  const [feedbackEmail, setFeedbackEmail] = useState<string | null>(null);

  const reportRef = useRef<HTMLDivElement | null>(null);

  const carregarUsuario = useCallback(async () => {
    try {
      setCarregandoUsuario(true);
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
        setErro('Não foi possível identificar o usuário autenticado.');
        return;
      }
      setUsuario(data);
      setErro(null);
    } catch (error) {
      console.error('Erro ao carregar usuário para o relatório:', error);
      setErro(
        traduzirErroSupabase(
          error,
          'Não foi possível carregar as informações do usuário. Tente novamente mais tarde.',
        ),
      );
    } finally {
      setCarregandoUsuario(false);
    }
  }, []);

  useEffect(() => {
    carregarUsuario();
  }, [carregarUsuario]);

  const carregarSemanas = useCallback(
    async (usuarioAtual: UsuarioRow) => {
      try {
        const supabase = getSupabaseClient();
        // Todos os usuários podem visualizar todas as semanas
        const { data, error } = await supabase
          .from('pvs_semanas')
          .select('pvs_id, pvs_semana_inicio, pvs_semana_fim, pvs_status')
          .order('pvs_semana_inicio', { ascending: false });

        if (error) throw error;

        const opcoes = (data ?? []).map((semana) => ({
          id: Number(semana.pvs_id),
          inicio: String(semana.pvs_semana_inicio ?? ''),
          fim: String(semana.pvs_semana_fim ?? ''),
          status: semana.pvs_status ?? null,
        }));

        setSemanas(opcoes);
        if (!semanaSelecionada && opcoes.length > 0) {
          setSemanaSelecionada(opcoes[0].inicio);
        }
        if (opcoes.length === 0) {
          setAviso('Nenhuma previsão semanal foi importada até o momento.');
        } else {
          setAviso(null);
        }
      } catch (error) {
        console.error('Erro ao carregar semanas disponíveis:', error);
        setErro(
          traduzirErroSupabase(
            error,
            'Não foi possível carregar as semanas importadas. Atualize a página e tente novamente.',
          ),
        );
      }
    },
    [semanaSelecionada],
  );

  useEffect(() => {
    if (!usuario) {
      return;
    }
    carregarSemanas(usuario);
  }, [usuario, carregarSemanas]);

  const carregarRelatorio = useCallback(
    async (usuarioAtual: UsuarioRow, semana: SemanaOption) => {
      try {
        setCarregandoDados(true);
        setErro(null);
        const supabase = getSupabaseClient();
        const { data, error } = await supabase
          .from('pvi_previsao_itens')
          .select('pvi_id, pvi_data, pvi_tipo, pvi_categoria, pvi_valor, pvi_ordem, pvi_pvs_id, pvi_are_id, are_areas(are_codigo)')
          .eq('pvi_pvs_id', semana.id)
          .order('pvi_data', { ascending: true });

        if (error) throw error;

        const itensBrutos: PrevisaoItem[] = (data ?? []).map((item: any) => {
          const areaRel = item.are_areas;
          const areaCodigo = Array.isArray(areaRel)
            ? (areaRel[0]?.are_codigo ?? '')
            : (areaRel?.are_codigo ?? '');

          return {
            id: Number(item.pvi_id),
            data: String(item.pvi_data ?? ''),
            tipo: String(item.pvi_tipo ?? ''),
            categoria: String(item.pvi_categoria ?? ''),
            valor: Math.round(Number(item.pvi_valor ?? 0) * 100) / 100,
            ordem: item.pvi_ordem !== null ? Number(item.pvi_ordem) : 0,
            areaCodigo: areaCodigo,
          };
        });

        // Filtra apenas itens com datas dentro do período da semana selecionada
        const dataInicio = new Date(`${semana.inicio}T00:00:00`);
        const dataFim = new Date(`${semana.fim}T00:00:00`);
        const itens = itensBrutos.filter((item) => {
          const dataItem = new Date(`${item.data}T00:00:00`);
          return dataItem >= dataInicio && dataItem <= dataFim;
        });

        if (itens.length === 0) {
          setRelatorio(null);
          setAviso('Não existem lançamentos importados para a semana selecionada dentro do período correto.');
          return;
        }

        const datasOrdenadas = Array.from(new Set(itens.map((item) => item.data)))
          .filter(Boolean)
          .sort((a, b) => a.localeCompare(b));

        const receitasItens = itens.filter((item) => item.tipo === 'receita');
        const despesasItens = itens.filter((item) => item.tipo === 'gasto');
        const saldoInicialItens = itens.filter((item) => item.tipo === 'saldo_inicial');
        const saldoDiarioItens = itens.filter((item) => item.tipo === 'saldo_diario');

        const receitas = agruparPorCategoria(receitasItens, datasOrdenadas);
        const despesas = agruparPorCategoria(despesasItens, datasOrdenadas);

        let saldoInicial = construirLinha(saldoInicialItens, datasOrdenadas, 'Saldo inicial');

        // Se não houver saldo inicial cadastrado, buscar do último dia anterior com saldos bancários
        if (!saldoInicial || Object.keys(saldoInicial.valores).length === 0) {
          const primeiraData = datasOrdenadas[0];
          if (primeiraData) {
            // Buscar saldos bancários do dia anterior
            const dataBusca = new Date(`${primeiraData}T00:00:00`);
            let saldoEncontrado = 0;
            let encontrou = false;

            // Buscar até 30 dias antes
            for (let i = 1; i <= 30 && !encontrou; i++) {
              const dataAnterior = new Date(dataBusca);
              dataAnterior.setDate(dataAnterior.getDate() - i);
              const dataAnteriorISO = dataAnterior.toISOString().split('T')[0];

              const { data: saldosBancarios, error: erroSaldos } = await supabase
                .from('sdb_saldo_banco')
                .select('sdb_saldo')
                .eq('sdb_data', dataAnteriorISO);

              if (!erroSaldos && saldosBancarios && saldosBancarios.length > 0) {
                saldoEncontrado = saldosBancarios.reduce((sum, item) => sum + Number(item.sdb_saldo || 0), 0);
                encontrou = true;
              }
            }

            if (encontrou) {
              // Criar saldo inicial com o valor encontrado
              saldoInicial = {
                categoria: 'Saldo inicial',
                valores: { [primeiraData]: Math.round(saldoEncontrado * 100) / 100 },
                total: Math.round(saldoEncontrado * 100) / 100,
              };
            }
          }
        }

        let saldoDiario = construirLinha(saldoDiarioItens, datasOrdenadas, 'Saldo diário previsto');

        // Se não houver saldo diário importado, calcular automaticamente (receitas - despesas por dia)
        if (!saldoDiario || Object.keys(saldoDiario.valores).length === 0) {
          const valores: Record<string, number> = {};
          let totalSaldoDiario = 0;

          datasOrdenadas.forEach((data) => {
            const receitasDia = receitas.reduce((sum, row) => sum + (row.valores[data] ?? 0), 0);
            const despesasDia = despesas.reduce((sum, row) => sum + (row.valores[data] ?? 0), 0);
            const saldoDia = Math.round((receitasDia - despesasDia) * 100) / 100;
            valores[data] = saldoDia;
            totalSaldoDiario += saldoDia;
          });

          saldoDiario = {
            categoria: 'Saldo diário previsto',
            valores,
            total: Math.round(totalSaldoDiario * 100) / 100,
          };
        }

        // Calcula saldo acumulado corretamente:
        // Primeiro dia: saldo inicial + saldo diário calculado
        // Demais dias: saldo acumulado anterior + saldo diário calculado
        let saldoAcumulado: ReportRow | null = null;
        if (saldoInicial && saldoDiario) {
          // Referência estável para o saldo inicial importado (a variável é reatribuída adiante).
          const saldoInicialBase = saldoInicial;
          const valores: Record<string, number> = {};
          let saldoAnterior = 0;

          datasOrdenadas.forEach((data, index) => {
            const saldoDiarioCalculado = saldoDiario.valores[data] ?? 0;

            if (index === 0) {
              // Primeiro dia: saldo inicial + saldo diário calculado
              const saldoInicialDia = saldoInicialBase.valores[data] ?? 0;
              valores[data] = Math.round((saldoInicialDia + saldoDiarioCalculado) * 100) / 100;
            } else {
              // Demais dias: saldo acumulado anterior + saldo diário calculado
              valores[data] = Math.round((saldoAnterior + saldoDiarioCalculado) * 100) / 100;
            }
            saldoAnterior = valores[data];
          });

          // Total: saldo inicial do primeiro registro + soma de todos os saldos diários
          const primeiraData = datasOrdenadas[0];
          const saldoInicialPrimeiro = primeiraData ? (saldoInicialBase.valores[primeiraData] ?? 0) : 0;
          const somaSaldosDiarios = datasOrdenadas.reduce((sum, data) =>
            sum + (saldoDiario.valores[data] ?? 0), 0
          );
          const total = Math.round((saldoInicialPrimeiro + somaSaldosDiarios) * 100) / 100;

          saldoAcumulado = {
            categoria: 'Saldo acumulado previsto',
            valores,
            total,
          };
        }

        // Saldo inicial exibido dia a dia:
        // - Primeiro dia: saldo inicial importado da planilha (ou saldo bancário do fallback)
        // - Demais dias: saldo final (acumulado) do dia anterior
        if (saldoInicial && saldoAcumulado) {
          const primeiraData = datasOrdenadas[0];
          const aberturaSemana = primeiraData ? (saldoInicial.valores[primeiraData] ?? 0) : 0;

          const valoresAbertura = datasOrdenadas.reduce<Record<string, number>>((acc, data, index) => {
            if (index === 0) {
              acc[data] = aberturaSemana;
            } else {
              const dataAnterior = datasOrdenadas[index - 1];
              acc[data] = saldoAcumulado?.valores[dataAnterior] ?? 0;
            }
            return acc;
          }, {});

          saldoInicial = {
            categoria: saldoInicial.categoria,
            valores: valoresAbertura,
            // Total da linha permanece sendo a abertura da semana: somar as aberturas
            // diárias não teria significado financeiro e alimentaria o card "Saldo Inicial".
            total: aberturaSemana,
          };
        }

        const totalReceitasPorData = datasOrdenadas.reduce<Record<string, number>>((acc, data) => {
          acc[data] = receitas.reduce((sum, row) => sum + (row.valores[data] ?? 0), 0);
          return acc;
        }, {});

        const totalDespesasPorData = datasOrdenadas.reduce<Record<string, number>>((acc, data) => {
          acc[data] = despesas.reduce((sum, row) => sum + (row.valores[data] ?? 0), 0);
          return acc;
        }, {});

        const totalReceitasGeral = receitas.reduce((sum, row) => sum + row.total, 0);
        const totalDespesasGeral = despesas.reduce((sum, row) => sum + row.total, 0);

        setRelatorio({
          datas: datasOrdenadas,
          datasFormatadas: datasOrdenadas.map(formatarData),
          receitas,
          despesas,
          totalReceitasPorData,
          totalDespesasPorData,
          totalReceitasGeral,
          totalDespesasGeral,
          saldoInicial,
          saldoDiario,
          saldoAcumulado,
        });
        setAviso(null);
      } catch (error) {
        console.error('Erro ao carregar itens da previsão semanal:', error);
        setErro(
          traduzirErroSupabase(
            error,
            'Não foi possível carregar os itens da previsão para a semana selecionada.',
          ),
        );
        setRelatorio(null);
      } finally {
        setCarregandoDados(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (!usuario) return;
    if (!semanaSelecionada) {
      setRelatorio(null);
      return;
    }
    const semana = semanas.find((item) => item.inicio === semanaSelecionada);
    if (!semana) {
      setRelatorio(null);
      return;
    }
    carregarRelatorio(usuario, semana);
  }, [usuario, semanas, semanaSelecionada, carregarRelatorio]);

  const semanaAtual = useMemo(() => semanas.find((item) => item.inicio === semanaSelecionada) ?? null, [semanas, semanaSelecionada]);

  const totalReceitas = relatorio?.totalReceitasGeral ?? 0;
  const totalDespesas = relatorio?.totalDespesasGeral ?? 0;
  const resultadoSemana = totalReceitas - totalDespesas;
  const saldoInicialTotal = relatorio?.saldoInicial?.total ?? 0;
  const saldoFinalPrevisto = useMemo(() => {
    if (!relatorio) return saldoInicialTotal + resultadoSemana;
    if (relatorio.saldoAcumulado) {
      const ultimaData = relatorio.datas[relatorio.datas.length - 1];
      if (ultimaData) {
        const valor = relatorio.saldoAcumulado.valores[ultimaData];
        if (typeof valor === 'number') {
          return valor;
        }
      }
    }
    return saldoInicialTotal + resultadoSemana;
  }, [relatorio, saldoInicialTotal, resultadoSemana]);

  const obterNomeArquivoPdf = useCallback(() => {
    if (semanaAtual) {
      return `Previsao_Semanal_${semanaAtual.inicio}_${semanaAtual.fim}.pdf`;
    }
    return 'Previsao_Semanal.pdf';
  }, [semanaAtual]);

  const gerarDocumentoPdf = useCallback(() => {
    if (!relatorio) {
      return null;
    }

    try {
      const doc = new jsPDF('landscape', 'mm', 'a4');

      doc.setFontSize(14);
      doc.setFont('helvetica', 'bold');
      doc.text('Relatório - Previsão Semanal', 14, 12);

      doc.setFontSize(9);
      doc.setFont('helvetica', 'normal');
      if (semanaAtual) {
        const dataInicio = formatarData(semanaAtual.inicio);
        const dataFim = formatarData(semanaAtual.fim);
        doc.text(`Período: ${dataInicio} a ${dataFim}`, 14, 18);
      }

      let yPos = 24;

      doc.setFontSize(8);
      doc.setFont('helvetica', 'bold');
      doc.text('Resumo:', 14, yPos);
      doc.setFont('helvetica', 'normal');
      const resumoTexto = `Receitas: ${formatCurrency(totalReceitas)}  |  Despesas: ${formatCurrency(totalDespesas)}  |  Resultado: ${formatCurrency(resultadoSemana)}  |  Saldo Final: ${formatCurrency(saldoFinalPrevisto)}`;
      doc.text(resumoTexto, 35, yPos);
      yPos += 6;

      const datasOrdenadas = [...relatorio.datas].sort((a, b) => a.localeCompare(b));
      const headers = ['Categoria', ...datasOrdenadas.map((d) => formatarData(d)), 'Total'];

      const receitasData = relatorio.receitas.map((row) => [
        row.categoria,
        ...datasOrdenadas.map((d) => formatCurrency(row.valores[d] || 0)),
        formatCurrency(row.total),
      ]);

      const totalReceitaPorData = datasOrdenadas.map((data) =>
        relatorio.receitas.reduce((sum, row) => sum + (row.valores[data] || 0), 0),
      );
      const totalReceitaGeral = relatorio.receitas.reduce((sum, row) => sum + row.total, 0);
      receitasData.push([
        'TOTAL RECEITAS',
        ...totalReceitaPorData.map((valor) => formatCurrency(valor)),
        formatCurrency(totalReceitaGeral),
      ]);

      const despesasData = relatorio.despesas.map((row) => [
        row.categoria,
        ...datasOrdenadas.map((d) => formatCurrency(row.valores[d] || 0)),
        formatCurrency(row.total),
      ]);

      const totalDespesaPorData = datasOrdenadas.map((data) =>
        relatorio.despesas.reduce((sum, row) => sum + (row.valores[data] || 0), 0),
      );
      const totalDespesaGeral = relatorio.despesas.reduce((sum, row) => sum + row.total, 0);
      despesasData.push([
        'TOTAL DESPESAS',
        ...totalDespesaPorData.map((valor) => formatCurrency(valor)),
        formatCurrency(totalDespesaGeral),
      ]);

      const saldosData: string[][] = [];
      if (relatorio.saldoInicial) {
        saldosData.push([
          'Saldo inicial',
          ...datasOrdenadas.map((d) => formatCurrency(relatorio.saldoInicial!.valores[d] || 0)),
          formatCurrency(relatorio.saldoInicial.total),
        ]);
      }
      if (relatorio.saldoDiario) {
        saldosData.push([
          'Saldo diário previsto',
          ...datasOrdenadas.map((d) => formatCurrency(relatorio.saldoDiario!.valores[d] || 0)),
          formatCurrency(relatorio.saldoDiario.total),
        ]);
      }
      if (relatorio.saldoAcumulado) {
        saldosData.push([
          'Saldo acumulado previsto',
          ...datasOrdenadas.map((d) => formatCurrency(relatorio.saldoAcumulado!.valores[d] || 0)),
          formatCurrency(relatorio.saldoAcumulado.total),
        ]);
      }

      if (receitasData.length > 0) {
        // Título da seção RECEITAS
        doc.setFontSize(10);
        doc.setFont('helvetica', 'bold');
        doc.text('RECEITAS', 14, yPos);
        yPos += 5;

        // Configurar estilos de coluna para centralizar datas e total
        const columnStylesReceitas: any = {
          0: { halign: 'left' },
        };
        // Centralizar todas as colunas de data e total
        for (let i = 1; i < headers.length; i++) {
          columnStylesReceitas[i] = { halign: 'center' };
          if (i === headers.length - 1) {
            columnStylesReceitas[i].fontStyle = 'bold';
          }
        }

        autoTable(doc, {
          startY: yPos,
          head: [headers],
          body: receitasData,
          headStyles: { fillColor: [34, 197, 94], textColor: 255, fontStyle: 'bold', fontSize: 9, halign: 'center' },
          bodyStyles: { fontSize: 8 },
          margin: { left: 10, right: 10 },
          tableWidth: 'auto',
          theme: 'grid',
          styles: { cellPadding: 1, lineWidth: 0.1, lineColor: [0, 0, 0], overflow: 'linebreak', minCellWidth: 10 },
          columnStyles: columnStylesReceitas,
          tableLineWidth: 0.5,
          tableLineColor: [0, 0, 0],
          didParseCell: (data) => {
            // Primeira coluna (categoria) sempre à esquerda
            if (data.column.index === 0) {
              data.cell.styles.halign = 'left';
            }
            if (data.row.index === receitasData.length - 1) {
              data.cell.styles.fontStyle = 'bold';
              data.cell.styles.fillColor = [220, 252, 231];
            }
          },
        });
        yPos = (doc as any).lastAutoTable.finalY + 3;
      }

      if (despesasData.length > 0) {
        // Título da seção GASTOS
        doc.setFontSize(10);
        doc.setFont('helvetica', 'bold');
        doc.text('GASTOS', 14, yPos);
        yPos += 5;

        // Configurar estilos de coluna para centralizar datas e total
        const columnStylesDespesas: any = {
          0: { halign: 'left' },
        };
        // Centralizar todas as colunas de data e total
        for (let i = 1; i < headers.length; i++) {
          columnStylesDespesas[i] = { halign: 'center' };
          if (i === headers.length - 1) {
            columnStylesDespesas[i].fontStyle = 'bold';
          }
        }

        autoTable(doc, {
          startY: yPos,
          head: [headers],
          body: despesasData,
          headStyles: { fillColor: [239, 68, 68], textColor: 255, fontStyle: 'bold', fontSize: 9, halign: 'center' },
          bodyStyles: { fontSize: 8 },
          margin: { left: 10, right: 10 },
          tableWidth: 'auto',
          theme: 'grid',
          styles: { cellPadding: 1, lineWidth: 0.1, lineColor: [0, 0, 0], overflow: 'linebreak', minCellWidth: 10 },
          columnStyles: columnStylesDespesas,
          tableLineWidth: 0.5,
          tableLineColor: [0, 0, 0],
          didParseCell: (data) => {
            // Primeira coluna (categoria) sempre à esquerda
            if (data.column.index === 0) {
              data.cell.styles.halign = 'left';
            }
            if (data.row.index === despesasData.length - 1) {
              data.cell.styles.fontStyle = 'bold';
              data.cell.styles.fillColor = [254, 226, 226];
            }
          },
        });
        yPos = (doc as any).lastAutoTable.finalY + 3;
      }

      if (saldosData.length > 0) {
        // Título da seção SALDOS
        doc.setFontSize(10);
        doc.setFont('helvetica', 'bold');
        doc.text('SALDOS', 14, yPos);
        yPos += 5;

        // Configurar estilos de coluna para centralizar datas e total
        const columnStylesSaldos: any = {
          0: { halign: 'left' },
        };
        // Centralizar todas as colunas de data e total
        for (let i = 1; i < headers.length; i++) {
          columnStylesSaldos[i] = { halign: 'center' };
          if (i === headers.length - 1) {
            columnStylesSaldos[i].fontStyle = 'bold';
          }
        }

        autoTable(doc, {
          startY: yPos,
          head: [headers],
          body: saldosData,
          headStyles: { fillColor: [100, 116, 139], textColor: 255, fontStyle: 'bold', fontSize: 9, halign: 'center' },
          bodyStyles: { fontSize: 8 },
          margin: { left: 10, right: 10 },
          tableWidth: 'auto',
          theme: 'grid',
          styles: { cellPadding: 1, lineWidth: 0.1, lineColor: [0, 0, 0], overflow: 'linebreak', minCellWidth: 10 },
          columnStyles: columnStylesSaldos,
          tableLineWidth: 0.5,
          tableLineColor: [0, 0, 0],
          didParseCell: (data) => {
            // Primeira coluna (categoria) sempre à esquerda
            if (data.column.index === 0) {
              data.cell.styles.halign = 'left';
            }
          },
        });
      }

      return doc;
    } catch (error) {
      console.error('Erro ao gerar PDF:', error);
      return null;
    }
  }, [relatorio, semanaAtual, totalReceitas, totalDespesas, resultadoSemana, saldoFinalPrevisto]);

  const handleExportPdf = useCallback(() => {
    if (!relatorio) {
      alert('Nenhum relatório disponível para exportar.');
      return;
    }

    const doc = gerarDocumentoPdf();
    if (!doc) {
      alert('Não foi possível gerar o PDF. Verifique os dados e tente novamente.');
      return;
    }

    doc.save(obterNomeArquivoPdf());
  }, [gerarDocumentoPdf, obterNomeArquivoPdf, relatorio]);

  const handleAbrirModalEmail = () => {
    setFeedbackEmail(null);
    if (!emailDestino && usuario?.usr_email) {
      setEmailDestino(usuario.usr_email);
    }
    setEmailModalAberto(true);
  };

  const handleEnviarEmail = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!relatorio) {
      setFeedbackEmail('Nenhum relatório disponível para envio.');
      return;
    }
    if (!emailDestino.trim()) {
      setFeedbackEmail('Informe um destinatário para continuar.');
      return;
    }

    try {
      setEnviandoEmail(true);
      setFeedbackEmail(null);

      const doc = gerarDocumentoPdf();
      if (!doc) {
        throw new Error('Não foi possível gerar o documento.');
      }

      const nomeArquivo = obterNomeArquivoPdf();
      const blob = doc.output('blob');
      const arquivo = new File([blob], nomeArquivo, { type: 'application/pdf' });

      const nav = navigator as Navigator & {
        canShare?: (data: { files?: File[] }) => boolean;
        share?: (data: { files?: File[]; title?: string; text?: string }) => Promise<void>;
      };

      if (nav.canShare && nav.share && nav.canShare({ files: [arquivo] })) {
        await nav.share({
          files: [arquivo],
          title: 'Relatório - Previsão Semanal',
          text: emailMensagem || 'Segue relatório de previsão semanal atualizado.',
        });
        setEmailModalAberto(false);
        return;
      }

      doc.save(nomeArquivo);

      const assunto = encodeURIComponent('Relatório - Previsão Semanal');
      const corpo = encodeURIComponent(
        `${emailMensagem || 'Segue relatório de previsão semanal atualizado.'}\n\nO arquivo foi baixado automaticamente e pode ser anexado ao e-mail.`,
      );
      window.location.href = `mailto:${encodeURIComponent(emailDestino)}?subject=${assunto}&body=${corpo}`;

      setEmailModalAberto(false);
    } catch (error) {
      console.error('Erro ao preparar envio por e-mail:', error);
      setFeedbackEmail('Não foi possível preparar o envio. Tente novamente em instantes.');
    } finally {
      setEnviandoEmail(false);
    }
  };

  if (carregandoUsuario) {
    return (
      <>
        <Header title="Relatório - Previsão Semanal" />
        <div className="page-content flex h-80 items-center justify-center">
          <Loading text="Carregando informações do relatório..." />
        </div>
      </>
    );
  }

  return (
    <>
      <Header
        title="Relatório - Previsão Semanal"
        subtitle={
          semanaAtual
            ? `Semana de ${formatarIntervaloSemana(semanaAtual.inicio, semanaAtual.fim)}`
            : 'Selecione uma semana importada para visualizar o relatório'
        }
        actions={
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <select
              value={semanaSelecionada ?? ''}
              onChange={(event) => setSemanaSelecionada(event.target.value || null)}
              className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500"
              disabled={semanas.length === 0}
            >
              {semanas.length === 0 ? (
                <option value="">Nenhuma semana importada</option>
              ) : (
                semanas.map((semana) => (
                  <option key={semana.id} value={semana.inicio}>
                    {formatarIntervaloSemana(semana.inicio, semana.fim)}
                    {semana.status ? ` • ${semana.status}` : ''}
                  </option>
                ))
              )}
            </select>
            <Button
              variant="secondary"
              onClick={handleAbrirModalEmail}
              disabled={!relatorio || carregandoDados}
            >
              Enviar por e-mail
            </Button>
            <Button
              variant="primary"
              onClick={handleExportPdf}
              disabled={!relatorio || carregandoDados}
            >
              Exportar PDF
            </Button>
          </div>
        }
      />

      <div className="page-content space-y-6">
        {erro && (
          <div className="rounded-md border border-error-200 bg-error-50 px-4 py-3 text-error-700">{erro}</div>
        )}

        {aviso && !erro && (
          <div className="rounded-md border border-warning-200 bg-warning-50 px-4 py-3 text-warning-800">{aviso}</div>
        )}

        {carregandoDados && (
          <div className="flex h-40 items-center justify-center">
            <Loading text="Carregando dados da previsão..." />
          </div>
        )}

        {relatorio && !carregandoDados && (
          <>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 shadow-sm">
                <p className="text-xs font-semibold uppercase tracking-wide text-blue-700">Saldo Inicial</p>
                <p className="mt-2 text-2xl font-semibold text-blue-900">{formatCurrency(saldoInicialTotal)}</p>
              </div>
              <div className="rounded-lg border border-success-200 bg-success-50/60 p-4 shadow-sm">
                <p className="text-xs font-semibold uppercase tracking-wide text-success-700">Total de Receitas</p>
                <p className={`mt-2 text-2xl font-semibold ${totalReceitas >= 0 ? 'text-success-800' : 'text-error-700'}`}>
                  {formatCurrency(totalReceitas)}
                </p>
              </div>
              <div className="rounded-lg border border-error-200 bg-error-50/70 p-4 shadow-sm">
                <p className="text-xs font-semibold uppercase tracking-wide text-error-700">Total de Despesas</p>
                <p className={`mt-2 text-2xl font-semibold ${totalDespesas >= 0 ? 'text-error-800' : 'text-success-700'}`}>
                  {formatCurrency(totalDespesas)}
                </p>
              </div>
              <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 shadow-sm">
                <p className="text-xs font-semibold uppercase tracking-wide text-blue-700">Saldo Final</p>
                <p className="mt-2 text-2xl font-semibold text-blue-900">{formatCurrency(saldoFinalPrevisto)}</p>
              </div>
            </div>

            <div ref={reportRef}>
              <Card
                title="Previsão de Pagamentos (Fluxo de Caixa)"
                subtitle={
                  semanaAtual
                    ? `Período: ${formatarIntervaloSemana(semanaAtual.inicio, semanaAtual.fim)}${semanaAtual.status ? ` • Status: ${semanaAtual.status}` : ''}`
                    : undefined
                }
                variant="default"
              >
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-gray-200 text-sm">
                    <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                      <tr>
                        <th className="px-4 py-3 text-left font-semibold">Categoria</th>
                        {relatorio.datasFormatadas.map((data) => (
                          <th key={data} className="px-4 py-3 text-right font-semibold">
                            {data}
                          </th>
                        ))}
                        <th className="px-4 py-3 text-right font-semibold">Total</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 bg-white/80">
                      <tr className="bg-green-100 text-green-900">
                        <td colSpan={relatorio.datas.length + 2} className="px-4 py-3 font-bold text-base">RECEITAS</td>
                      </tr>
                      {relatorio.receitas.map((row) => (
                        <tr key={`receita-${row.categoria}`}>
                          <td className="px-4 py-3 text-gray-700">{row.categoria}</td>
                          {relatorio.datas.map((data) => (
                            <td key={data} className="px-4 py-3 text-right text-gray-700">
                              {formatCurrency(row.valores[data] ?? 0)}
                            </td>
                          ))}
                          <td className="px-4 py-3 text-right font-semibold text-gray-900">
                            {formatCurrency(row.total)}
                          </td>
                        </tr>
                      ))}
                      <tr className="bg-green-50 font-bold text-green-900 border-t-2 border-green-200">
                        <td className="px-4 py-3">Total de Receitas</td>
                        {relatorio.datas.map((data) => (
                          <td key={data} className="px-4 py-3 text-right">
                            {formatCurrency(relatorio.totalReceitasPorData[data] ?? 0)}
                          </td>
                        ))}
                        <td className="px-4 py-3 text-right">{formatCurrency(totalReceitas)}</td>
                      </tr>

                      {/* Separador visual entre receitas e despesas */}
                      <tr className="h-4">
                        <td colSpan={relatorio.datas.length + 2} className="bg-gray-100"></td>
                      </tr>

                      <tr className="bg-red-100 text-red-900">
                        <td colSpan={relatorio.datas.length + 2} className="px-4 py-3 font-bold text-base">DESPESAS</td>
                      </tr>
                      {relatorio.despesas.map((row) => (
                        <tr key={`despesa-${row.categoria}`}>
                          <td className="px-4 py-3 text-gray-700">{row.categoria}</td>
                          {relatorio.datas.map((data) => (
                            <td key={data} className="px-4 py-3 text-right text-gray-700">
                              {formatCurrency(row.valores[data] ?? 0)}
                            </td>
                          ))}
                          <td className="px-4 py-3 text-right font-semibold text-gray-900">
                            {formatCurrency(row.total)}
                          </td>
                        </tr>
                      ))}
                      <tr className="bg-red-50 font-bold text-red-900 border-t-2 border-red-200">
                        <td className="px-4 py-3">Total de Despesas</td>
                        {relatorio.datas.map((data) => (
                          <td key={data} className="px-4 py-3 text-right">
                            {formatCurrency(relatorio.totalDespesasPorData[data] ?? 0)}
                          </td>
                        ))}
                        <td className="px-4 py-3 text-right">{formatCurrency(totalDespesas)}</td>
                      </tr>

                      {/* Separador visual entre despesas e saldos */}
                      <tr className="h-6">
                        <td colSpan={relatorio.datas.length + 2} className="bg-gray-100"></td>
                      </tr>

                      {/* Cabeçalho do grupo de saldos */}
                      <tr className="bg-blue-100 text-blue-900">
                        <td colSpan={relatorio.datas.length + 2} className="px-4 py-3 font-bold text-base">SALDOS</td>
                      </tr>

                      {relatorio.saldoInicial && (
                        <tr className="bg-blue-50 font-bold text-blue-900">
                          <td className="px-4 py-3">Saldo Inicial</td>
                          {relatorio.datas.map((data) => (
                            <td key={data} className="px-4 py-3 text-right">
                              {formatCurrency(relatorio.saldoInicial?.valores[data] ?? 0)}
                            </td>
                          ))}
                          <td className="px-4 py-3 text-right">{formatCurrency(relatorio.saldoInicial.total)}</td>
                        </tr>
                      )}

                      {relatorio.saldoDiario && (
                        <tr className="bg-blue-50 font-bold text-blue-900">
                          <td className="px-4 py-3">Saldo do Dia</td>
                          {relatorio.datas.map((data) => (
                            <td key={data} className="px-4 py-3 text-right">
                              {formatCurrency(relatorio.saldoDiario?.valores[data] ?? 0)}
                            </td>
                          ))}
                          <td className="px-4 py-3 text-right">{formatCurrency(relatorio.saldoDiario.total)}</td>
                        </tr>
                      )}

                      {relatorio.saldoAcumulado && (
                        <tr className="bg-blue-100 font-bold text-blue-900 border-t-2 border-blue-300">
                          <td className="px-4 py-3">Saldo Final</td>
                          {relatorio.datas.map((data) => (
                            <td key={data} className="px-4 py-3 text-right">
                              {formatCurrency(relatorio.saldoAcumulado?.valores[data] ?? 0)}
                            </td>
                          ))}
                          <td className="px-4 py-3 text-right">{formatCurrency(relatorio.saldoAcumulado.total)}</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </Card>
            </div>
          </>
        )}
      </div>

      <Modal
        isOpen={emailModalAberto}
        onClose={() => {
          if (!enviandoEmail) {
            setEmailModalAberto(false);
          }
        }}
        title="Enviar relatório por e-mail"
        size="lg"
        footer={
          <div className="flex justify-end gap-3">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setEmailModalAberto(false)}
              disabled={enviandoEmail}
            >
              Cancelar
            </Button>
            <Button
              type="submit"
              form="previsao-semanal-email-form"
              variant="primary"
              loading={enviandoEmail}
              disabled={enviandoEmail}
            >
              Preparar envio
            </Button>
          </div>
        }
      >
        <form id="previsao-semanal-email-form" onSubmit={handleEnviarEmail} className="space-y-4">
          <Input
            label="Destinatário"
            type="email"
            value={emailDestino}
            onChange={(event) => setEmailDestino(event.target.value)}
            placeholder="usuario@empresa.com.br"
            required
          />
          <Textarea
            label="Mensagem"
            value={emailMensagem}
            onChange={(event) => setEmailMensagem(event.target.value)}
            placeholder="Mensagem opcional para acompanhar o relatório."
            rows={4}
          />
          <p className="text-xs text-gray-500">
            O relatório será gerado em PDF. Caso o compartilhamento direto não esteja disponível, o arquivo será baixado
            automaticamente para anexar ao e-mail.
          </p>
          {feedbackEmail && <p className="text-sm text-error-600">{feedbackEmail}</p>}
        </form>
      </Modal>
    </>
  );
};

export default RelatorioPrevisaoSemanalPage;
