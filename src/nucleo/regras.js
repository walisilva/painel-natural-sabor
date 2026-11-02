/* Regras de negócio do MVP: funções puras, sem tela.
   Fonte da verdade das regras no protótipo. Roda no navegador (FP.regras)
   e no Node (testes/regras.test.js). Dinheiro sempre em centavos. */
(function (raiz, fabrica) {
  const api = fabrica();
  if (typeof module === "object" && module.exports) module.exports = api;
  else {
    raiz.FP = raiz.FP || {};
    raiz.FP.regras = api;
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const MINUTO = 60000;
  const HORA = 60 * MINUTO;
  const DIA = 24 * HORA;

  /* ---------- Regras fixas (não editáveis no MVP) ---------- */
  const LIMITE_PESO_KG = 100;
  const PRAZO_AGENDAMENTO_DIAS = 30;
  const CIDADES_COBERTAS = Object.freeze(["João Pessoa", "Cabedelo", "Bayeux"]);

  /* Feriados nacionais + estadual da Paraíba (05/08). Lista a confirmar com o dono. */
  const FERIADOS = Object.freeze({
    "2026-01-01": "Confraternização Universal",
    "2026-04-03": "Sexta-feira Santa",
    "2026-04-21": "Tiradentes",
    "2026-05-01": "Dia do Trabalho",
    "2026-08-05": "Fundação da Paraíba",
    "2026-09-07": "Independência do Brasil",
    "2026-10-12": "Nossa Senhora Aparecida",
    "2026-11-02": "Finados",
    "2026-11-15": "Proclamação da República",
    "2026-11-20": "Consciência Negra",
    "2026-12-25": "Natal",
    "2027-01-01": "Confraternização Universal",
    "2027-03-26": "Sexta-feira Santa",
    "2027-04-21": "Tiradentes",
    "2027-05-01": "Dia do Trabalho",
  });

  /* Feriados em uso: começam com a lista acima e são trocados pelos do banco (tabela feriados). */
  let feriadosAtuais = FERIADOS;
  function definirFeriados(mapa) { feriadosAtuais = Object.freeze(Object.assign({}, mapa)); }
  const listaFeriados = () => feriadosAtuais;

  /* ---------- Etapas do pedido ---------- */
  const ETAPAS = Object.freeze({
    conversa: { rotulo: "Conversa iniciada", kanban: true },
    nao_pago: { rotulo: "Não pago", kanban: true },
    pago: { rotulo: "Pago", kanban: true },
    entrega: { rotulo: "Em entrega", kanban: true },
    concluido: { rotulo: "Concluído", kanban: false },
    cancelado: { rotulo: "Cancelado", kanban: false },
    abandonada: { rotulo: "Abandonada", kanban: false },
  });
  const COLUNAS_KANBAN = Object.freeze(["conversa", "nao_pago", "pago", "entrega"]);

  /* Únicas mudanças que o operador faz na mão. O resto é automático. */
  const TRANSICOES_MANUAIS = Object.freeze({ pago: ["entrega"], entrega: ["concluido"] });

  function podeMoverManual(de, para) {
    return (TRANSICOES_MANUAIS[de] || []).includes(para);
  }

  const ORDEM_FLUXO = Object.freeze(["conversa", "nao_pago", "pago", "entrega", "concluido"]);

  function motivoBloqueioMovimento(de, para) {
    if (de === para || podeMoverManual(de, para)) return null;
    if (ORDEM_FLUXO.indexOf(para) < ORDEM_FLUXO.indexOf(de)) return "Pedido não volta de etapa.";
    if (para === "pago") return "Só o Mercado Pago move para Pago, quando confirma o pagamento.";
    if (para === "nao_pago") return "O pedido vai para Não pago sozinho, quando o bot gera o link.";
    if (para === "entrega") return "Só pedido pago pode sair para entrega.";
    if (para === "concluido") return "Só pedido em entrega pode ser concluído.";
    return "Esse movimento não existe no fluxo do pedido.";
  }

  /* ---------- Texto ---------- */
  function normalizar(texto) {
    return String(texto || "")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .trim();
  }

  /* ---------- Cobertura ---------- */
  /* cidadesAtivas pode desligar uma das 3 cidades, mas nunca incluir outra. */
  function cidadeAtendida(cidade, cidadesAtivas) {
    const base = CIDADES_COBERTAS.map(normalizar);
    const ativas = (cidadesAtivas || CIDADES_COBERTAS).map(normalizar).filter((c) => base.includes(c));
    return ativas.includes(normalizar(cidade));
  }

  function cepValido(cep) {
    return /^\d{8}$/.test(String(cep || "").replace(/\D/g, ""));
  }

  /* ---------- Frete (fórmula tipo Uber Envios) ----------
     frete = max(frete_minimo, tarifa_base + valor_por_km × km) × multiplicador */
  function validarConfigFrete(cfg) {
    const erros = [];
    const inteiroNaoNegativo = (v) => Number.isInteger(v) && v >= 0;
    if (!inteiroNaoNegativo(cfg.freteMinimoCent) || cfg.freteMinimoCent <= 0)
      erros.push("Frete mínimo precisa ser maior que zero (frete nunca é grátis).");
    if (!inteiroNaoNegativo(cfg.tarifaBaseCent)) erros.push("Tarifa base inválida.");
    if (!inteiroNaoNegativo(cfg.valorPorKmCent)) erros.push("Valor por km inválido.");
    if (!(typeof cfg.multiplicador === "number" && cfg.multiplicador >= 1 && cfg.multiplicador <= 3))
      erros.push("Multiplicador precisa ficar entre 1,00 e 3,00.");
    return erros;
  }

  function calcularFrete(km, cfg) {
    if (!(typeof km === "number" && isFinite(km) && km >= 0)) {
      throw new Error("Distância inválida para o frete.");
    }
    const kmRota = Math.round(km * 10) / 10;
    const variavelCent = cfg.tarifaBaseCent + Math.round(cfg.valorPorKmCent * kmRota);
    const aplicouMinimo = cfg.freteMinimoCent > variavelCent;
    const baseCent = Math.max(cfg.freteMinimoCent, variavelCent);
    return {
      km: kmRota,
      variavelCent,
      aplicouMinimo,
      baseCent,
      multiplicador: cfg.multiplicador,
      totalCent: Math.round(baseCent * cfg.multiplicador),
    };
  }

  /* ---------- Datas e dia útil (AAAA-MM-DD, hora local) ---------- */
  const pad = (n) => String(n).padStart(2, "0");

  function isoLocal(ts) {
    const d = new Date(ts);
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  function somarDias(iso, dias) {
    const d = new Date(iso + "T12:00:00");
    d.setDate(d.getDate() + dias);
    return isoLocal(d.getTime());
  }

  function diasEntre(isoA, isoB) {
    return Math.round((new Date(isoB + "T12:00:00") - new Date(isoA + "T12:00:00")) / DIA);
  }

  function dataBr(iso) {
    const [a, m, d] = String(iso).split("-");
    return d + "/" + m + "/" + a;
  }

  function motivoNaoUtil(iso, feriados) {
    const lista = feriados || feriadosAtuais;
    const dow = new Date(iso + "T12:00:00").getDay();
    if (dow === 0) return "domingo";
    if (dow === 6) return "sábado";
    if (lista[iso]) return "feriado (" + lista[iso] + ")";
    return null;
  }

  function eDiaUtil(iso, feriados) {
    return motivoNaoUtil(iso, feriados) === null;
  }

  function proximoDiaUtil(iso, feriados) {
    let d = iso;
    for (let i = 0; i < 20; i += 1) {
      if (eDiaUtil(d, feriados)) return d;
      d = somarDias(d, 1);
    }
    return d;
  }

  /* tipo: "hoje" | "agendada". Devolve { ok, data } ou { ok:false, motivo, sugestao }. */
  function validarEntrega(tipo, iso, agoraTs, feriados) {
    const hoje = isoLocal(agoraTs);
    const limite = somarDias(hoje, PRAZO_AGENDAMENTO_DIAS);

    if (tipo === "hoje") {
      const m = motivoNaoUtil(hoje, feriados);
      if (m) {
        return {
          ok: false,
          motivo: "Hoje é " + m + ". Só entregamos em dia útil.",
          sugestao: proximoDiaUtil(somarDias(hoje, 1), feriados),
        };
      }
      return { ok: true, tipo: "hoje", data: hoje };
    }

    if (!iso) return { ok: false, motivo: "Não entendi a data. Use o formato dd/mm." };
    const dist = diasEntre(hoje, iso);
    if (dist < 1) return { ok: false, motivo: "Para agendar, escolha uma data a partir de amanhã." };
    if (dist > PRAZO_AGENDAMENTO_DIAS) {
      return {
        ok: false,
        motivo: "Agendamos no máximo " + PRAZO_AGENDAMENTO_DIAS + " dias à frente, até " + dataBr(limite) + ".",
      };
    }
    const m = motivoNaoUtil(iso, feriados);
    if (m) {
      const s = proximoDiaUtil(iso, feriados);
      return {
        ok: false,
        motivo: dataBr(iso) + " é " + m + ". Só entregamos em dia útil.",
        sugestao: diasEntre(hoje, s) <= PRAZO_AGENDAMENTO_DIAS ? s : null,
      };
    }
    return { ok: true, tipo: "agendada", data: iso };
  }

  /* Entende "05/11", "5/11/2026", "05-11-26". Sem ano: o próximo que ainda não passou. */
  function interpretarDataBr(texto, agoraTs) {
    const m = String(texto || "").trim().match(/^(\d{1,2})[/\-.](\d{1,2})(?:[/\-.](\d{2}|\d{4}))?$/);
    if (!m) return null;
    const dia = Number(m[1]);
    const mes = Number(m[2]);
    const hoje = isoLocal(agoraTs);
    let ano = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : Number(hoje.slice(0, 4));
    const real = new Date(ano, mes - 1, dia);
    if (real.getMonth() !== mes - 1 || real.getDate() !== dia) return null;
    let iso = ano + "-" + pad(mes) + "-" + pad(dia);
    if (!m[3] && iso < hoje) {
      ano += 1;
      iso = ano + "-" + pad(mes) + "-" + pad(dia);
    }
    return iso;
  }

  /* ---------- Catálogo (produto > sabor > variante) ---------- */
  function variantesDisponiveis(catalogo) {
    const saida = [];
    catalogo.forEach((prod) => {
      if (!prod.ativo) return;
      prod.sabores.forEach((sab) => {
        if (!sab.ativo) return;
        sab.variantes.forEach((v) => {
          if (!v.ativo) return;
          saida.push({
            produtoId: prod.id,
            saborId: sab.id,
            varianteId: v.id,
            nome: prod.nome + " de " + sab.nome,
            sabor: sab.nome,
            rotulo: v.rotulo,
            pesoG: v.pesoG,
            precoCent: v.precoCent,
          });
        });
      });
    });
    return saida;
  }

  function saboresDisponiveis(catalogo) {
    const vistos = new Map();
    variantesDisponiveis(catalogo).forEach((v) => {
      if (!vistos.has(v.saborId)) vistos.set(v.saborId, { saborId: v.saborId, nome: v.nome, variantes: [] });
      vistos.get(v.saborId).variantes.push(v);
    });
    return Array.from(vistos.values());
  }

  /* Só dá para ligar um sabor quando algum tamanho tem preço > 0 (nada é de graça). */
  function saborTemPreco(sabor) {
    return !!sabor && (sabor.variantes || []).some((v) => v.precoCent > 0);
  }

  /* Peso em gramas a partir do rótulo do tamanho: "1 kg" -> 1000, "500 g" -> 500,
     "1,5kg" -> 1500. Devolve null quando não dá para ler a unidade. */
  function pesoDeRotulo(rotulo) {
    const m = String(rotulo || "").toLowerCase().replace(",", ".").match(/([\d.]+)\s*(kg|g)\b/);
    if (!m) return null;
    const n = parseFloat(m[1]);
    if (!(n > 0)) return null;
    return Math.round(m[2] === "kg" ? n * 1000 : n);
  }

  /* Valor digitado pelo operador -> centavos. Aceita "12", "12,5", "R$ 12,00",
     "1.250,00" e "12.50". Devolve NaN quando não há número. */
  function centavosDeTexto(texto) {
    let s = String(texto == null ? "" : texto).replace(/[^\d,.]/g, "");
    if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
    else if (!/^\d+\.\d{1,2}$/.test(s)) s = s.replace(/\./g, "");
    if (!s) return NaN;
    return Math.round(Number(s) * 100);
  }

  /* Na hora de gerar o link: tira o que foi desligado e atualiza preço que mudou. */
  function revalidarCarrinho(itens, catalogo) {
    const disp = new Map(variantesDisponiveis(catalogo).map((v) => [v.varianteId, v]));
    const validos = [];
    const removidos = [];
    const precoMudou = [];
    itens.forEach((i) => {
      const v = disp.get(i.varianteId);
      if (!v) {
        removidos.push(i);
      } else if (v.precoCent !== i.precoCent) {
        precoMudou.push({ item: i, novoPrecoCent: v.precoCent });
        validos.push(Object.assign({}, i, { precoCent: v.precoCent }));
      } else {
        validos.push(i);
      }
    });
    return { validos, removidos, precoMudou };
  }

  /* ---------- Carrinho ---------- */
  const subtotalCent = (itens) => itens.reduce((s, i) => s + i.precoCent * i.qtd, 0);
  const pesoTotalG = (itens) => itens.reduce((s, i) => s + i.pesoG * i.qtd, 0);
  const excedeLimitePeso = (itens) => pesoTotalG(itens) > LIMITE_PESO_KG * 1000;

  /* ---------- Pagamento (webhook idempotente) ---------- */
  function avaliarPagamento(pedido, pagamentoId) {
    if ((pedido.pagamentos || []).some((p) => p.id === pagamentoId)) return "duplicado";
    if (pedido.status === "nao_pago") return "confirmar";
    if (pedido.status === "cancelado") return "tardio";
    return "ignorar";
  }

  /* ---------- Prazos ---------- */
  function linkExpirado(pedido, agoraTs) {
    return pedido.status === "nao_pago" && !!pedido.link && pedido.link.expiraEm <= agoraTs;
  }

  function conversaAbandonada(pedido, agoraTs, horas) {
    return pedido.status === "conversa" && agoraTs - pedido.ultimaMsgEm >= horas * HORA;
  }

  return {
    MINUTO, HORA, DIA, LIMITE_PESO_KG, PRAZO_AGENDAMENTO_DIAS, CIDADES_COBERTAS, FERIADOS, definirFeriados, listaFeriados,
    ETAPAS, COLUNAS_KANBAN, TRANSICOES_MANUAIS,
    podeMoverManual, motivoBloqueioMovimento, normalizar, cidadeAtendida, cepValido,
    validarConfigFrete, calcularFrete,
    isoLocal, somarDias, diasEntre, dataBr, motivoNaoUtil, eDiaUtil, proximoDiaUtil,
    validarEntrega, interpretarDataBr,
    variantesDisponiveis, saboresDisponiveis, saborTemPreco, pesoDeRotulo, centavosDeTexto, revalidarCarrinho,
    subtotalCent, pesoTotalG, excedeLimitePeso,
    avaliarPagamento, linkExpirado, conversaAbandonada,
  };
});
