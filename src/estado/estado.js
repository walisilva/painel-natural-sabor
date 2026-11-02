/* Estado do painel: cache em memória com leitura síncrona para as telas e bot,
   e persistência no Supabase.
   - Toda mudança passa por commit(): o diff entre o estado antigo e o novo (os objetos são
     imutáveis, então basta comparar referências) vira gravações numa fila serializada.
   - Mudanças feitas por outros (outra aba, rotina de prazos do servidor) chegam por Realtime
     e recarregam o cache quando não há gravação pendente.
   - O bot e o webhook de pagamento ainda são SIMULADOS no navegador (simulador). Em produção
     eles devem virar Edge Functions (ver supabase/README.md). */
(function (FP) {
  "use strict";
  const R = FP.regras;
  const T = FP.textos;
  const sb = () => FP.sb;

  const estadoVazio = () => ({ offsetMs: 0, config: null, catalogo: [], pedidos: [], chats: {} });
  let st = estadoVazio();
  const ouvintes = new Set();

  const agora = () => Date.now() + st.offsetMs;
  const iso = (ms) => new Date(ms).toISOString();
  const ms = (s) => new Date(s).getTime();
  const novoId = () => (window.crypto && crypto.randomUUID
    ? crypto.randomUUID()
    : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 3) | 8).toString(16);
    }));

  function emitir(evento) {
    ouvintes.forEach((fn) => {
      try { fn(evento); } catch (erro) { console.error("[estado] ouvinte falhou", erro); }
    });
  }

  /* ---------- persistência (Supabase) ---------- */
  /* Em vez de uma gravação por commit, marcamos o que ficou "sujo" e um único laço grava o estado
     MAIS RECENTE de cada item (várias mudanças seguidas viram uma gravação só). */
  const sujo = { pedidos: new Set(), chats: new Set(), config: false, catalogo: false };
  let gravando = false;
  let recargaPorErro = false; // recarga que veio de um erro de gravação: precisa redesenhar as telas de edição
  let mutacoes = 0; // sobe a cada commit: serve para descartar recarga que ficou velha
  const gravadoPedidos = new Map(); // id -> o que já está no banco (status, histórico, pagamentos, links, itens)
  const gravadoChats = new Map(); // telefone -> quantas mensagens já estão no banco
  const clienteIds = new Map(); // telefone -> uuid do cliente

  const haSujo = () => sujo.pedidos.size > 0 || sujo.chats.size > 0 || sujo.config || sujo.catalogo;
  const pendente = () => gravando || haSujo();
  const esperar = (t) => new Promise((r) => setTimeout(r, t));
  async function aguardarGravacao() { while (pendente()) await esperar(50); }

  function checar(res, onde) {
    if (res.error) throw new Error(onde + ": " + res.error.message);
    return res.data;
  }

  async function descarregar() {
    if (gravando) return;
    gravando = true;
    try {
      while (haSujo()) {
        if (sujo.config) { sujo.config = false; await gravarConfig(st.config); }
        if (sujo.catalogo) { sujo.catalogo = false; await gravarCatalogo(st.catalogo); }
        for (const id of Array.from(sujo.pedidos)) {
          sujo.pedidos.delete(id);
          const p = st.pedidos.find((x) => x.id === id);
          if (p) await gravarPedido(p);
        }
        for (const t of Array.from(sujo.chats)) {
          sujo.chats.delete(t);
          const c = st.chats[t];
          if (!c) continue;
          const ref = c.pedidoId && !gravadoPedidos.has(c.pedidoId) && st.pedidos.find((x) => x.id === c.pedidoId);
          if (ref) { sujo.pedidos.delete(ref.id); await gravarPedido(ref); } // FK: o pedido do chat precisa existir antes
          await gravarChat(t, c);
        }
      }
    } catch (erro) {
      console.error("[estado] falha ao gravar", erro);
      sujo.pedidos.clear(); sujo.chats.clear(); sujo.config = false; sujo.catalogo = false;
      emitir({ tipo: "erro", motivo: erro.message });
      recargaPorErro = true;
      agendarRecarga(); // volta ao que o banco aceitou
    } finally {
      gravando = false;
    }
  }

  async function garantirCliente(telefone, nome) {
    if (clienteIds.has(telefone)) return clienteIds.get(telefone);
    const r = await sb().from("clientes").upsert({ telefone, nome }, { onConflict: "telefone" }).select("id").single();
    const id = checar(r, "clientes").id;
    clienteIds.set(telefone, id);
    return id;
  }

  async function gravarPedido(p) {
    const novo = !gravadoPedidos.has(p.id);
    const g = gravadoPedidos.get(p.id) || { status: p.status, hist: 0, pag: new Set(), links: new Set(), itens: "[]", invalidou: false };
    const clienteId = await garantirCliente(p.telefone, p.cliente);

    const gravarItens = async () => {
      const assinatura = JSON.stringify(p.itens);
      if (assinatura === g.itens) return;
      checar(await sb().rpc("trocar_itens_pedido", {
        p_pedido: p.id,
        p_itens: p.itens.map((i, ordem) => ({
          variante_id: i.varianteId, nome: i.nome, rotulo: i.rotulo,
          peso_g: i.pesoG, preco_cent: i.precoCent, qtd: i.qtd, ordem,
        })),
      }), "trocar_itens_pedido");
      g.itens = assinatura;
    };

    if (!novo) await gravarItens(); // pedido existente: itens antes do status (RLS só deixa mexer em "conversa")
    const linha = {
      id: p.id, cliente_id: clienteId, status: g.status, passo_bot: p.passoBot,
      criado_em: iso(p.criadoEm), etapa_desde: iso(p.etapaDesde), ultima_msg_em: iso(p.ultimaMsgEm),
      endereco: p.endereco, frete: p.frete,
      subtotal_cent: p.subtotalCent, frete_cent: p.freteCent, total_cent: p.totalCent,
      entrega_tipo: p.entrega ? p.entrega.tipo : null, entrega_data: p.entrega ? p.entrega.data : null,
      acima_100kg: p.acima100kg, alerta_tardio: p.alertaTardio, motivo: p.motivo || "",
    };
    const salvo = checar(await sb().from("pedidos").upsert(linha).select("numero").single(), "pedidos");
    if (novo) await gravarItens();

    /* O banco só aceita transições válidas, uma de cada vez: reproduz o caminho pelo histórico. */
    for (const h of p.historico.slice(g.hist)) {
      if (h.para === g.status) continue;
      checar(await sb().from("pedidos").update({ status: h.para, etapa_desde: iso(h.em) }).eq("id", p.id), "pedidos (status)");
      g.status = h.para;
    }
    if (g.status !== p.status) {
      checar(await sb().from("pedidos").update({ status: p.status, etapa_desde: iso(p.etapaDesde) }).eq("id", p.id), "pedidos (status)");
      g.status = p.status;
    }

    if (p.link && !g.links.has(p.link.id)) {
      checar(await sb().from("links_pagamento").insert({
        pedido_id: p.id, mp_preference_id: p.link.id, url: p.link.url,
        criado_em: iso(p.link.criadoEm), expira_em: iso(p.link.expiraEm),
      }), "links_pagamento");
      g.links.add(p.link.id);
    }
    if (p.link && p.status === "cancelado" && !g.invalidou) {
      checar(await sb().from("links_pagamento").update({ invalidado_em: new Date().toISOString() })
        .eq("mp_preference_id", p.link.id).is("invalidado_em", null), "links_pagamento (invalidar)");
      g.invalidou = true;
    }
    for (const pg of p.pagamentos) {
      if (g.pag.has(pg.id)) continue;
      checar(await sb().from("pagamentos").insert({
        pedido_id: p.id, mp_payment_id: pg.id, metodo: pg.metodo, valor_cent: pg.valorCent,
        tardio: !!pg.tardio, pago_em: iso(pg.em),
      }), "pagamentos");
      g.pag.add(pg.id);
    }
    const novosHist = p.historico.slice(g.hist);
    if (novosHist.length) {
      checar(await sb().from("pedido_historico").insert(novosHist.map((h) => ({
        pedido_id: p.id, em: iso(h.em), de: h.de, para: h.para, autor: h.autor, obs: h.obs || "",
      }))), "pedido_historico");
      g.hist = p.historico.length;
    }
    gravadoPedidos.set(p.id, g);

    if (salvo.numero !== p.numero) { // número vem da sequência do banco
      st = trocarPedido(st, p.id, (x) => Object.assign({}, x, { numero: salvo.numero }));
      emitir({ tipo: "mudou" });
    }
  }

  async function gravarChat(telefone, c) {
    const clienteId = await garantirCliente(telefone, c.nome);
    checar(await sb().from("chats").upsert({ cliente_id: clienteId, pedido_id: c.pedidoId, bot: c.bot }), "chats");
    const ja = gravadoChats.get(telefone) || 0;
    const novas = c.mensagens.slice(ja);
    if (novas.length) {
      checar(await sb().from("mensagens").insert(novas.map((m) => ({
        cliente_id: clienteId, de: m.de, texto: m.texto, em: iso(m.em), link_pedido_id: m.linkPedidoId || null,
      }))), "mensagens");
    }
    gravadoChats.set(telefone, c.mensagens.length);
  }

  async function gravarConfig(c) {
    checar(await sb().from("configuracoes").upsert({
      id: true, frete_minimo_cent: c.freteMinimoCent, tarifa_base_cent: c.tarifaBaseCent,
      valor_por_km_cent: c.valorPorKmCent, multiplicador: c.multiplicador,
      janela_pagamento_min: c.janelaPagamentoMin, abandono_horas: c.abandonoHoras, cidades_ativas: c.cidadesAtivas,
    }), "configuracoes");
  }

  async function gravarCatalogo(cat) {
    checar(await sb().from("produtos").upsert(cat.map((p) => ({ id: p.id, nome: p.nome, ativo: p.ativo }))), "produtos");
    const sabores = cat.flatMap((p) => p.sabores.map((s) => ({ id: s.id, produto_id: p.id, nome: s.nome, ativo: s.ativo })));
    checar(await sb().from("sabores").upsert(sabores), "sabores");
    const variantes = cat.flatMap((p) => p.sabores.flatMap((s) => s.variantes.map((v) => ({
      id: v.id, sabor_id: s.id, rotulo: v.rotulo, peso_g: v.pesoG, preco_cent: v.precoCent, ativo: v.ativo,
    }))));
    checar(await sb().from("variantes").upsert(variantes), "variantes");
  }

  function marcarSujo(antes, depois) {
    const velhos = new Map(antes.pedidos.map((p) => [p.id, p]));
    depois.pedidos.filter((p) => velhos.get(p.id) !== p).forEach((p) => sujo.pedidos.add(p.id));
    Object.keys(depois.chats).filter((t) => antes.chats[t] !== depois.chats[t]).forEach((t) => sujo.chats.add(t));
    if (antes.config !== depois.config && depois.config) sujo.config = true;
    if (antes.catalogo !== depois.catalogo && antes.catalogo.length) sujo.catalogo = true;
    if (haSujo()) descarregar();
  }

  function commit(novo, evento) {
    const antes = st;
    st = novo;
    mutacoes += 1;
    marcarSujo(antes, novo);
    emitir(evento || { tipo: "mudou" });
  }

  /* ---------- leitura do banco ---------- */
  function lerPedido(r) {
    const link = (r.links_pagamento || []).slice().sort((a, b) => ms(b.criado_em) - ms(a.criado_em))[0];
    return {
      id: r.id, numero: r.numero, cliente: r.clientes.nome, telefone: r.clientes.telefone,
      criadoEm: ms(r.criado_em), ultimaMsgEm: ms(r.ultima_msg_em), etapaDesde: ms(r.etapa_desde),
      status: r.status, passoBot: r.passo_bot,
      itens: (r.pedido_itens || []).slice().sort((a, b) => a.ordem - b.ordem).map((i) => ({
        varianteId: i.variante_id, nome: i.nome, rotulo: i.rotulo, pesoG: i.peso_g, precoCent: i.preco_cent, qtd: i.qtd,
      })),
      endereco: r.endereco, frete: r.frete, freteCent: r.frete_cent, subtotalCent: r.subtotal_cent, totalCent: r.total_cent,
      entrega: r.entrega_tipo ? { tipo: r.entrega_tipo, data: r.entrega_data } : null,
      link: link ? { id: link.mp_preference_id, url: link.url, criadoEm: ms(link.criado_em), expiraEm: ms(link.expira_em) } : null,
      pagamentos: (r.pagamentos || []).slice().sort((a, b) => ms(a.pago_em) - ms(b.pago_em)).map((x) => ({
        id: x.mp_payment_id, metodo: x.metodo, valorCent: x.valor_cent, em: ms(x.pago_em), tardio: x.tardio,
      })),
      historico: (r.pedido_historico || []).slice().sort((a, b) => ms(a.em) - ms(b.em) || a.id - b.id).map((h) => ({
        em: ms(h.em), de: h.de, para: h.para, autor: h.autor, obs: h.obs,
      })),
      acima100kg: r.acima_100kg, alertaTardio: r.alerta_tardio, motivo: r.motivo,
    };
  }

  /* soSeLimpo: recarga disparada por Realtime só vale se nada mudou/pendente durante a busca. */
  async function carregar(soSeLimpo) {
    if (soSeLimpo && pendente()) return false;
    const versao = mutacoes;
    const c = sb();
    const [cfg, prods, sabs, vars, fer, peds, chs, msgs] = await Promise.all([
      c.from("configuracoes").select("*").single(),
      c.from("produtos").select("*").order("id"),
      c.from("sabores").select("*"),
      c.from("variantes").select("*").order("peso_g", { ascending: false }),
      c.from("feriados").select("*"),
      c.from("pedidos").select("*, clientes(nome,telefone), pedido_itens(*), links_pagamento(*), pagamentos(*), pedido_historico(*)")
        .order("criado_em", { ascending: false }).limit(1000),
      c.from("chats").select("*, clientes(telefone,nome)"),
      c.from("mensagens").select("*, clientes(telefone)").order("em", { ascending: false }).limit(2000),
    ]);
    const config = checar(cfg, "configuracoes");
    const produtos = checar(prods, "produtos");
    const sabores = checar(sabs, "sabores");
    const variantes = checar(vars, "variantes");
    const feriados = checar(fer, "feriados");
    const pedidosDb = checar(peds, "pedidos");
    const chatsDb = checar(chs, "chats");
    const msgsDb = checar(msgs, "mensagens");
    if (soSeLimpo && (pendente() || versao !== mutacoes)) return false;

    const catalogo = produtos.map((p) => ({
      id: p.id, nome: p.nome, ativo: p.ativo,
      sabores: sabores.filter((s) => s.produto_id === p.id)
        .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"))
        .map((s) => ({
          id: s.id, nome: s.nome, ativo: s.ativo,
          variantes: variantes.filter((v) => v.sabor_id === s.id).map((v) => ({
            id: v.id, rotulo: v.rotulo, pesoG: v.peso_g, precoCent: v.preco_cent, ativo: v.ativo,
          })),
        })),
    }));
    const pedidos = pedidosDb.map(lerPedido).sort((a, b) => a.criadoEm - b.criadoEm);
    const porCliente = new Map();
    msgsDb.slice().reverse().forEach((m) => {
      const t = m.clientes.telefone;
      if (!porCliente.has(t)) porCliente.set(t, []);
      porCliente.get(t).push({ de: m.de, texto: m.texto, em: ms(m.em), linkPedidoId: m.link_pedido_id || undefined });
    });
    const chats = {};
    chatsDb.forEach((r) => {
      const t = r.clientes.telefone;
      chats[t] = { telefone: t, nome: r.clientes.nome, pedidoId: r.pedido_id, bot: r.bot, mensagens: porCliente.get(t) || [] };
      clienteIds.set(t, r.cliente_id);
      gravadoChats.set(t, chats[t].mensagens.length);
    });

    gravadoPedidos.clear();
    pedidos.forEach((p) => gravadoPedidos.set(p.id, {
      status: p.status,
      hist: p.historico.length,
      pag: new Set(p.pagamentos.map((x) => x.id)),
      links: new Set(p.link ? [p.link.id] : []),
      itens: JSON.stringify(p.itens),
      invalidou: p.status === "cancelado" && !!p.link,
    }));

    R.definirFeriados(Object.fromEntries(feriados.map((f) => [f.data, f.nome])));
    st = {
      offsetMs: st.offsetMs,
      config: {
        freteMinimoCent: config.frete_minimo_cent, tarifaBaseCent: config.tarifa_base_cent,
        valorPorKmCent: config.valor_por_km_cent, multiplicador: Number(config.multiplicador),
        janelaPagamentoMin: config.janela_pagamento_min, abandonoHoras: config.abandono_horas,
        cidadesAtivas: config.cidades_ativas,
      },
      catalogo, pedidos, chats,
    };
    emitir({ tipo: recargaPorErro ? "reset" : "sync" }); // "reset" redesenha também Produtos e Configurações
    recargaPorErro = false;
    return true;
  }

  /* ---------- tempo real ---------- */
  let canal = null;
  let timerRecarga = null;
  let timerSeguranca = null;

  function agendarRecarga() {
    clearTimeout(timerRecarga);
    timerRecarga = setTimeout(async () => {
      try { if (!(await carregar(true))) agendarRecarga(); } catch (erro) { console.error("[estado] recarga falhou", erro); }
    }, 600);
  }

  function assinar() {
    if (canal) return;
    canal = sb().channel("painel");
    ["pedidos", "mensagens", "produtos", "sabores", "variantes", "configuracoes"].forEach((tabela) => {
      canal.on("postgres_changes", { event: "*", schema: "public", table: tabela }, agendarRecarga);
    });
    canal.subscribe();
    timerSeguranca = setInterval(agendarRecarga, 30000); // rede de segurança se o Realtime cair
  }

  function parar() {
    if (canal) { sb().removeChannel(canal); canal = null; }
    clearInterval(timerSeguranca);
    clearTimeout(timerRecarga);
  }

  /* ---------- leitura ---------- */
  const pedidos = () => st.pedidos;
  const pedido = (id) => st.pedidos.find((p) => p.id === id) || null;
  const config = () => st.config;
  const catalogo = () => st.catalogo;
  const chats = () => st.chats;
  const chat = (tel) => st.chats[tel] || null;

  /* ---------- helpers imutáveis ---------- */
  function trocarPedido(estado, id, fn) {
    return Object.assign({}, estado, { pedidos: estado.pedidos.map((p) => (p.id === id ? fn(p) : p)) });
  }

  function transicao(p, para, autor, obs, extra) {
    const t = agora();
    return Object.assign({}, p, extra || {}, {
      status: para,
      etapaDesde: t,
      historico: p.historico.concat([{ em: t, de: p.status, para, autor, obs: obs || "" }]),
    });
  }

  function anotar(p, autor, obs, extra) {
    return Object.assign({}, p, extra || {}, {
      historico: p.historico.concat([{ em: agora(), de: p.status, para: p.status, autor, obs }]),
    });
  }

  function comMensagem(estado, tel, de, texto, extra) {
    const c = estado.chats[tel];
    if (!c) return estado;
    const msg = Object.assign({ de, texto, em: agora() }, extra || {});
    const novoChat = Object.assign({}, c, { mensagens: c.mensagens.concat([msg]) });
    return Object.assign({}, estado, { chats: Object.assign({}, estado.chats, { [tel]: novoChat }) });
  }

  /* ---------- conversa / bot ---------- */
  function abrirConversa(tel, nome) {
    const t = agora();
    const p = {
      id: novoId(),
      numero: "P-…", // o número real sai da sequência do banco assim que o pedido é gravado
      cliente: nome,
      telefone: tel,
      criadoEm: t,
      ultimaMsgEm: t,
      etapaDesde: t,
      status: "conversa",
      passoBot: "menu",
      itens: [],
      endereco: null,
      frete: null,
      freteCent: 0,
      subtotalCent: 0,
      totalCent: 0,
      entrega: null,
      link: null,
      pagamentos: [],
      historico: [{ em: t, de: null, para: "conversa", autor: "Bot", obs: "Primeira mensagem no WhatsApp" }],
      acima100kg: false,
      alertaTardio: false,
      motivo: "",
    };
    const antigo = st.chats[tel];
    const novoChat = {
      telefone: tel,
      nome,
      pedidoId: p.id,
      bot: { passo: "menu", pilha: [], temp: {} },
      mensagens: antigo ? antigo.mensagens : [],
    };
    commit(Object.assign({}, st, {
      pedidos: st.pedidos.concat([p]),
      chats: Object.assign({}, st.chats, { [tel]: novoChat }),
    }), { tipo: "novo", id: p.id });
    return p;
  }

  function registrarMensagem(tel, de, texto, extra) {
    let novo = comMensagem(st, tel, de, texto, extra);
    const c = novo.chats[tel];
    if (de === "cliente" && c && c.pedidoId) {
      novo = trocarPedido(novo, c.pedidoId, (p) => Object.assign({}, p, { ultimaMsgEm: agora() }));
    }
    commit(novo, { tipo: "mensagem", tel });
  }

  function salvarBot(tel, bot) {
    const c = st.chats[tel];
    const novoChat = Object.assign({}, c, { bot });
    let novo = Object.assign({}, st, { chats: Object.assign({}, st.chats, { [tel]: novoChat }) });
    if (c.pedidoId) {
      novo = trocarPedido(novo, c.pedidoId, (p) => (p.status === "conversa" ? Object.assign({}, p, { passoBot: bot.passo }) : p));
    }
    commit(novo, { tipo: "bot", tel });
  }

  /* Dados que o bot coleta: itens, endereço, frete, entrega. Só em Conversa iniciada. */
  function atualizarRascunho(id, patch) {
    const p = pedido(id);
    if (!p || p.status !== "conversa") return;
    const itens = patch.itens || p.itens;
    const sub = R.subtotalCent(itens);
    const frete = "frete" in patch ? patch.frete : p.frete;
    const freteCent = frete ? frete.totalCent : 0;
    commit(trocarPedido(st, id, (x) => Object.assign({}, x, patch, {
      itens,
      frete,
      subtotalCent: sub,
      freteCent,
      totalCent: sub + freteCent,
    })), { tipo: "rascunho", id });
  }

  function marcarAcimaLimite(id) {
    commit(trocarPedido(st, id, (p) => anotar(p, "Bot", "Carrinho passou de 100 kg. Combinar pelo WhatsApp",
      { acima100kg: true, passoBot: "acima100kg" })), { tipo: "acima100kg", id });
  }

  /* Gera o link do Mercado Pago. O frete fica congelado no pedido a partir daqui. */
  function gerarLink(id) {
    const p = pedido(id);
    if (!p || p.status !== "conversa") return { ok: false, motivo: "Pedido não está em Conversa iniciada." };
    if (!p.itens.length || !p.endereco || !p.frete || !p.entrega) return { ok: false, motivo: "Pedido incompleto." };
    if (R.excedeLimitePeso(p.itens)) return { ok: false, motivo: "Acima de 100 kg não gera link." };
    const t = agora();
    const prefId = "pref-" + Math.random().toString(36).slice(2, 10);
    const link = {
      id: prefId,
      url: "https://mpago.la/" + prefId.slice(5, 11),
      criadoEm: t,
      expiraEm: t + st.config.janelaPagamentoMin * R.MINUTO,
    };
    const novoP = transicao(p, "nao_pago", "Bot", "Link do Mercado Pago gerado (vale " + st.config.janelaPagamentoMin + " min)",
      { link, passoBot: "aguardando_pagamento" });
    let novo = trocarPedido(st, id, () => novoP);
    novo = comMensagem(novo, p.telefone, "bot", T.link(novoP, st.config.janelaPagamentoMin), { linkPedidoId: id });
    commit(novo, { tipo: "link", id });
    return { ok: true, pedido: novoP };
  }

  /* Webhook do Mercado Pago. Idempotente: o mesmo pagamentoId não processa duas vezes. */
  function processarWebhook(id, pagamentoId, metodo) {
    const p = pedido(id);
    if (!p) return { resultado: "inexistente" };
    const resultado = R.avaliarPagamento(p, pagamentoId);
    const pg = { id: pagamentoId, metodo, valorCent: p.totalCent, em: agora(), tardio: resultado === "tardio" };

    if (resultado === "confirmar") {
      const novoP = transicao(p, "pago", "Mercado Pago (webhook)", "Pagamento aprovado via " + metodo,
        { pagamentos: p.pagamentos.concat([pg]), passoBot: "finalizado" });
      let novo = trocarPedido(st, id, () => novoP);
      novo = comMensagem(novo, p.telefone, "bot", T.pago(novoP));
      commit(novo, { tipo: "pago", id });
    } else if (resultado === "tardio") {
      const novoP = anotar(p, "Mercado Pago (webhook)", "Pagamento chegou DEPOIS do cancelamento. Conferir com o cliente",
        { pagamentos: p.pagamentos.concat([pg]), alertaTardio: true });
      let novo = trocarPedido(st, id, () => novoP);
      novo = comMensagem(novo, p.telefone, "bot", T.pagouDepois(novoP));
      commit(novo, { tipo: "tardio", id });
    } else {
      emitir({ tipo: "webhook-ignorado", id, resultado });
    }
    return { resultado };
  }

  /* Por que o operador NÃO pode mover este pedido para "para" (null = pode). */
  function motivoMovimento(id, para) {
    const p = pedido(id);
    if (!p) return "Pedido não encontrado.";
    const bloqueio = R.motivoBloqueioMovimento(p.status, para);
    if (bloqueio) return bloqueio;
    if (para === "entrega" && p.entrega && p.entrega.data > R.isoLocal(agora())) {
      return "Entrega agendada para " + R.dataBr(p.entrega.data) + ". Só sai no dia.";
    }
    return null;
  }

  /* Ações do operador: só Pago→Em entrega e Em entrega→Concluído. */
  function moverManual(id, para, operador) {
    const motivo = motivoMovimento(id, para);
    if (motivo) return { ok: false, motivo };
    const p = pedido(id);
    const novoP = transicao(p, para, operador || "Operador", para === "entrega" ? "Enviado para entrega" : "Entrega concluída");
    let novo = trocarPedido(st, id, () => novoP);
    novo = comMensagem(novo, p.telefone, "bot", para === "entrega" ? T.saiuEntrega(novoP) : T.entregue(novoP));
    commit(novo, { tipo: "movido", id, para });
    return { ok: true };
  }

  function marcarTardioConferido(id, operador) {
    commit(trocarPedido(st, id, (p) => anotar(p, operador || "Operador", "Pagamento tardio conferido com o cliente",
      { alertaTardio: false })), { tipo: "mudou" });
  }

  function cancelarPeloCliente(id) {
    const p = pedido(id);
    if (!p || !["conversa", "nao_pago"].includes(p.status)) return;
    const obs = p.status === "nao_pago" ? "Cliente digitou cancelar, link invalidado" : "Cliente digitou cancelar";
    commit(trocarPedido(st, id, (x) => transicao(x, "cancelado", "Cliente", obs,
      { motivo: "Cancelado pelo cliente", passoBot: "finalizado" })), { tipo: "cancelado", id });
  }

  /* Roda a cada segundo, só com o relógio simulado ligado: cancela link vencido e marca conversa abandonada. */
  function tick() {
    if (!st.config || !st.offsetMs) return; // sem relógio simulado, a rotina_prazos() do banco faz isso
    const t = agora();
    let novo = st;
    const eventos = [];
    st.pedidos.forEach((p) => {
      if (R.linkExpirado(p, t)) {
        novo = trocarPedido(novo, p.id, (x) => transicao(x, "cancelado", "Sistema", "Link expirou sem pagamento, link invalidado",
          { motivo: "Link expirou (" + novo.config.janelaPagamentoMin + " min)", passoBot: "finalizado" }));
        novo = comMensagem(novo, p.telefone, "bot", T.expirou(novo.config.janelaPagamentoMin));
        eventos.push({ tipo: "expirou", id: p.id });
      } else if (R.conversaAbandonada(p, t, novo.config.abandonoHoras)) {
        novo = trocarPedido(novo, p.id, (x) => transicao(x, "abandonada", "Sistema",
          novo.config.abandonoHoras + " h sem mensagem", { motivo: "Conversa parada por " + novo.config.abandonoHoras + " h" }));
        eventos.push({ tipo: "abandonou", id: p.id });
      }
    });
    if (eventos.length) commit(novo, { tipo: "lote", eventos });
  }

  /* ---------- configuração e catálogo ---------- */
  function salvarConfig(parcial) {
    const cfg = Object.assign({}, st.config, parcial);
    const erros = R.validarConfigFrete(cfg);
    if (!(Number.isInteger(cfg.janelaPagamentoMin) && cfg.janelaPagamentoMin >= 5 && cfg.janelaPagamentoMin <= 60))
      erros.push("Prazo do link precisa ficar entre 5 e 60 minutos.");
    if (!(Number.isInteger(cfg.abandonoHoras) && cfg.abandonoHoras >= 1 && cfg.abandonoHoras <= 72))
      erros.push("Prazo de abandono precisa ficar entre 1 e 72 horas.");
    if (!cfg.cidadesAtivas.length) erros.push("Deixe pelo menos uma cidade ligada.");
    if (erros.length) return { ok: false, erros };
    commit(Object.assign({}, st, { config: cfg }), { tipo: "config" });
    return { ok: true };
  }

  function mapearCatalogo(fn) {
    commit(Object.assign({}, st, { catalogo: fn(st.catalogo) }), { tipo: "catalogo" });
  }

  const mapSabor = (cat, saborId, fn) => cat.map((prod) => Object.assign({}, prod, {
    sabores: prod.sabores.map((s) => (s.id === saborId ? fn(s) : s)),
  }));

  function alternarSabor(saborId, ativo) {
    if (ativo) {
      const sabor = st.catalogo.flatMap((p) => p.sabores).find((s) => s.id === saborId);
      if (!R.saborTemPreco(sabor)) return { ok: false, motivo: "Defina o preço de um tamanho antes de ligar o sabor." };
    }
    mapearCatalogo((cat) => mapSabor(cat, saborId, (s) => Object.assign({}, s, { ativo })));
    return { ok: true };
  }

  function alternarVariante(saborId, varianteId, ativo) {
    mapearCatalogo((cat) => mapSabor(cat, saborId, (s) => Object.assign({}, s, {
      variantes: s.variantes.map((v) => (v.id === varianteId ? Object.assign({}, v, { ativo }) : v)),
    })));
  }

  function alterarPreco(saborId, varianteId, precoCent) {
    if (!(Number.isInteger(precoCent) && precoCent > 0)) return { ok: false, motivo: "Preço precisa ser maior que zero." };
    mapearCatalogo((cat) => mapSabor(cat, saborId, (s) => Object.assign({}, s, {
      variantes: s.variantes.map((v) => (v.id === varianteId ? Object.assign({}, v, { precoCent }) : v)),
    })));
    return { ok: true };
  }

  /* Nada é de graça: o sabor nasce com um tamanho e um preço > 0.
     Começa desligado, mas já pode ser ligado porque tem preço. */
  function novoSabor(produtoId, nome, tamanhoRotulo, precoCent) {
    const limpo = String(nome || "").trim();
    if (limpo.length < 2) return { ok: false, motivo: "Nome do sabor muito curto." };
    const existe = st.catalogo.some((p) => p.sabores.some((s) => R.normalizar(s.nome) === R.normalizar(limpo)));
    if (existe) return { ok: false, motivo: "Esse sabor já existe." };
    const rotulo = String(tamanhoRotulo || "").trim();
    const pesoG = R.pesoDeRotulo(rotulo);
    if (!pesoG) return { ok: false, motivo: "Informe o tamanho com a unidade: ex. 1 kg, 500 g." };
    if (!(Number.isInteger(precoCent) && precoCent > 0)) return { ok: false, motivo: "Preço precisa ser maior que zero (nada é de graça)." };
    const id = "sab-" + Date.now().toString(36);
    mapearCatalogo((cat) => cat.map((p) => (p.id !== produtoId ? p : Object.assign({}, p, {
      sabores: p.sabores.concat([{
        id,
        nome: limpo,
        ativo: false,
        variantes: [{ id: id + "-" + pesoG, rotulo, pesoG, precoCent, ativo: true }],
      }]),
    }))));
    return { ok: true, id };
  }

  /* Adiciona um tamanho a um sabor existente (também já com preço > 0). */
  function novoTamanho(saborId, tamanhoRotulo, precoCent) {
    const rotulo = String(tamanhoRotulo || "").trim();
    const pesoG = R.pesoDeRotulo(rotulo);
    if (!pesoG) return { ok: false, motivo: "Informe o tamanho com a unidade: ex. 1 kg, 500 g." };
    if (!(Number.isInteger(precoCent) && precoCent > 0)) return { ok: false, motivo: "Preço precisa ser maior que zero (nada é de graça)." };
    const sabor = st.catalogo.flatMap((p) => p.sabores).find((s) => s.id === saborId);
    if (!sabor) return { ok: false, motivo: "Sabor não encontrado." };
    if (sabor.variantes.some((v) => R.normalizar(v.rotulo) === R.normalizar(rotulo))) return { ok: false, motivo: "Esse tamanho já existe nesse sabor." };
    const id = saborId + "-" + pesoG + "-" + Date.now().toString(36);
    mapearCatalogo((cat) => mapSabor(cat, saborId, (s) => Object.assign({}, s, {
      variantes: s.variantes.concat([{ id, rotulo, pesoG, precoCent, ativo: true }]),
    })));
    return { ok: true, id };
  }

  /* ---------- relógio de simulação (só local; o servidor segue o tempo real) ---------- */
  function avancarRelogio(ms) {
    commit(Object.assign({}, st, { offsetMs: st.offsetMs + ms }), { tipo: "relogio" });
    tick();
  }

  function zerarRelogio() {
    commit(Object.assign({}, st, { offsetMs: 0 }), { tipo: "relogio" });
  }

  /* ---------- sessão do operador (Supabase Auth) ---------- */
  let sessaoAtual = null;

  async function definirSessao(s) {
    if (!s) { sessaoAtual = null; return; }
    const r = await sb().from("operadores").select("nome,ativo").eq("id", s.user.id).maybeSingle();
    if (r.error || !r.data || !r.data.ativo) { await sb().auth.signOut(); sessaoAtual = null; return; }
    sessaoAtual = { id: s.user.id, email: s.user.email, nome: r.data.nome, desde: Date.now() };
  }

  async function restaurarSessao() {
    const { data } = await sb().auth.getSession();
    await definirSessao(data.session);
    sb().auth.onAuthStateChange((evento) => {
      if (evento === "SIGNED_OUT" && sessaoAtual) { sessaoAtual = null; parar(); emitir({ tipo: "deslogado" }); }
    });
  }

  async function entrar(email, senha) {
    const { data, error } = await sb().auth.signInWithPassword({ email: String(email).trim(), password: String(senha) });
    if (error) return { ok: false, motivo: "E-mail ou senha incorretos." };
    await definirSessao(data.session);
    if (!sessaoAtual) return { ok: false, motivo: "Este usuário não tem permissão de operador." };
    return { ok: true, sessao: sessaoAtual };
  }

  const sessao = () => sessaoAtual;

  async function sair() {
    await aguardarGravacao();
    parar();
    sessaoAtual = null;
    await sb().auth.signOut();
    st = estadoVazio();
    gravadoPedidos.clear(); gravadoChats.clear(); clienteIds.clear();
  }

  FP.estado = {
    restaurarSessao, carregar, assinar, aguardarGravacao, agora, on: (fn) => { ouvintes.add(fn); return () => ouvintes.delete(fn); },
    pedidos, pedido, config, catalogo, chats, chat,
    abrirConversa, registrarMensagem, salvarBot, atualizarRascunho, marcarAcimaLimite,
    gerarLink, processarWebhook, motivoMovimento, moverManual, marcarTardioConferido, cancelarPeloCliente, tick,
    salvarConfig, alternarSabor, alternarVariante, alterarPreco, novoSabor, novoTamanho,
    avancarRelogio, zerarRelogio,
    entrar, sessao, sair,
    offset: () => st.offsetMs,
  };
})(window.FP = window.FP || {});
