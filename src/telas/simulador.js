/* Tela Simulador: faz o papel do cliente no WhatsApp e do Mercado Pago.
   Serve para demonstrar e testar as regras antes do bot real existir. */
(function (FP) {
  "use strict";
  const R = FP.regras;
  const U = FP.util;
  const E = () => FP.estado;
  const esc = U.esc;
  let selecionado = null;

  const CEPS_TESTE = [
    ["58038000", "Manaíra, João Pessoa"], ["58102202", "Intermares, Cabedelo"], ["58306000", "Centro, Bayeux"],
    ["58400000", "Campina Grande (fora)"], ["01310100", "São Paulo (fora)"],
  ];

  function formatar(texto) {
    return esc(texto)
      .replace(/\*([^*\n]+)\*/g, "<b>$1</b>")
      .replace(/(^|\s)_([^_\n]+)_/g, "$1<i>$2</i>")
      .replace(/\n/g, "<br>");
  }

  function chatsOrdenados() {
    return Object.values(E().chats())
      .map((c) => ({ c, ultima: c.mensagens.length ? c.mensagens[c.mensagens.length - 1].em : 0 }))
      .sort((a, b) => b.ultima - a.ultima)
      .map((x) => x.c);
  }

  function pedidoDo(tel) {
    const c = E().chat(tel);
    return c && c.pedidoId ? E().pedido(c.pedidoId) : null;
  }

  function montar(el) {
    el.innerHTML =
      '<div class="simulador">' +
      '<aside class="sim-lista"><form id="sNovo" class="sim-novo"><b>Novo cliente</b>' +
      '<input name="nome" placeholder="Nome no WhatsApp" required maxlength="40">' +
      '<input name="tel" placeholder="DDD + número (ex.: 83 98888-0000)" required>' +
      '<button class="btn btn-primario">Começar conversa</button></form><div id="sChats"></div></aside>' +
      '<section class="celular" aria-label="Conversa"><header id="sTopo"></header><div id="sMsgs" class="msgs" aria-live="polite"></div>' +
      '<div id="sRapidas" class="rapidas"></div>' +
      '<form id="sEnviar" class="enviar"><input name="txt" autocomplete="off" placeholder="Mensagem do cliente" aria-label="Mensagem do cliente">' +
      '<button class="btn btn-primario" aria-label="Enviar">➤</button></form></section>' +
      '<aside class="sim-ferramentas" id="sFerr"></aside></div>';
    el.dataset.montado = "1";

    U.$("#sNovo", el).addEventListener("submit", (e) => {
      e.preventDefault();
      const f = e.target;
      const d = f.tel.value.replace(/\D/g, "");
      if (d.length < 10 || d.length > 11) { FP.ui.toast("Telefone precisa ter DDD + número.", "erro"); return; }
      const tel = "55" + d;
      selecionado = tel;
      FP.bot.receber(tel, f.nome.value.trim(), "Oi");
      f.reset();
    });
    U.$("#sEnviar", el).addEventListener("submit", (e) => {
      e.preventDefault();
      const campo = e.target.txt;
      if (!selecionado || !campo.value.trim()) return;
      const c = E().chat(selecionado);
      FP.bot.receber(selecionado, c ? c.nome : "Cliente", campo.value);
      campo.value = "";
      campo.focus();
    });
  }

  function desenharLista(el) {
    U.$("#sChats", el).innerHTML = chatsOrdenados().map((c) => {
      const p = pedidoDo(c.telefone);
      const ult = c.mensagens[c.mensagens.length - 1];
      return '<button class="sim-chat ' + (c.telefone === selecionado ? "ativo" : "") + '" data-tel="' + esc(c.telefone) + '">' +
        "<b>" + esc(c.nome) + "</b>" + (p ? ' <span class="chip etapa-' + p.status + '">' + R.ETAPAS[p.status].rotulo + "</span>" : "") +
        "<small>" + esc(ult ? ult.texto.replace(/[*_]/g, "").slice(0, 46) : "") + "</small></button>";
    }).join("");
    U.$$(".sim-chat", el).forEach((b) => b.addEventListener("click", () => { selecionado = b.dataset.tel; render(el); }));
  }

  function desenharConversa(el) {
    const c = E().chat(selecionado);
    const p = pedidoDo(selecionado);
    U.$("#sTopo", el).innerHTML = c
      ? '<div class="avatar">' + esc(c.nome.charAt(0)) + "</div><div><b>" + esc(c.nome) + "</b><small>" + esc(U.telefoneBr(c.telefone)) +
        (p ? " · " + esc(p.numero) + " · " + R.ETAPAS[p.status].rotulo : "") + "</small></div>"
      : "<div><b>Escolha ou crie uma conversa</b></div>";
    const caixa = U.$("#sMsgs", el);
    const noFim = caixa.scrollHeight - caixa.scrollTop - caixa.clientHeight < 60;
    caixa.innerHTML = c ? c.mensagens.map((m) =>
      '<div class="msg ' + m.de + '"><div>' + formatar(m.texto) + "</div>" +
      (m.linkPedidoId ? '<button class="btn btn-mp" data-checkout="' + esc(m.linkPedidoId) + '">Abrir link de pagamento</button>' : "") +
      "<time>" + U.hhmm(m.em) + "</time></div>").join("") : "";
    if (noFim || caixa.dataset.tel !== selecionado) caixa.scrollTop = caixa.scrollHeight;
    caixa.dataset.tel = selecionado || "";
    U.$$("[data-checkout]", caixa).forEach((b) => b.addEventListener("click", () => checkout(b.dataset.checkout)));

    const rapidas = c ? ["1", "2", "3", "voltar", "cancelar", "recomeçar"] : [];
    U.$("#sRapidas", el).innerHTML = rapidas.map((r) => '<button class="chip-btn" data-r="' + esc(r) + '">' + esc(r) + "</button>").join("") +
      (p && p.passoBot === "cep" ? CEPS_TESTE.map(([cep, rot]) => '<button class="chip-btn" data-r="' + cep + '" title="' + esc(rot) + '">' + cep + "</button>").join("") : "");
    U.$$("[data-r]", el).forEach((b) => b.addEventListener("click", () => FP.bot.receber(selecionado, c.nome, b.dataset.r)));
  }

  function desenharFerramentas(el) {
    const p = selecionado ? pedidoDo(selecionado) : null;
    const pg = p && p.pagamentos.length ? p.pagamentos[p.pagamentos.length - 1] : null;
    const off = E().offset();
    let html = '<h3>Mercado Pago (simulado)</h3>';
    if (p && p.status === "nao_pago") {
      html += '<button class="btn btn-mp" data-pagar="Pix">Cliente pagou com Pix</button><button class="btn btn-mp" data-pagar="Cartão">Cliente pagou com cartão</button>';
    } else if (p && p.status === "cancelado" && p.link) {
      html += '<button class="btn btn-perigo" data-pagar="Pix">Simular pagamento depois do cancelamento</button>';
    } else {
      html += '<p class="mudo">Os botões de pagamento aparecem quando o pedido desta conversa está em <b>Não pago</b>.</p>';
    }
    if (pg) html += '<button class="btn" data-repetir="1">Reenviar o mesmo aviso (teste de duplicidade)</button>';
    html += "<h3>Relógio da simulação</h3><p class=\"mudo\">" + (off ? "Adiantado " + U.duracao(off) + ". " : "Horário real. ") +
      "Use para ver o link expirar e a conversa virar abandonada.</p>" +
      '<div class="botoes"><button class="btn" data-tempo="5">+5 min</button><button class="btn" data-tempo="15">+15 min</button>' +
      '<button class="btn" data-tempo="60">+1 h</button><button class="btn" data-tempo="1440">+24 h</button>' +
      (off ? '<button class="btn" data-tempo="0">Voltar ao real</button>' : "") + "</div>" +
      "<h3>CEPs para testar</h3><ul class=\"regras\">" + CEPS_TESTE.map(([c, r]) => "<li><code>" + c + "</code> · " + esc(r) + "</li>").join("") + "</ul>" +
      '<p class="mudo">O CEP é consultado no ViaCEP de verdade. Sem internet, usa uma tabela de reserva.</p>' +
      "<h3>Dica</h3><p class=\"mudo\">Abra o painel em outra aba: o Kanban atualiza sozinho e toca o alerta quando o pagamento cai.</p>";
    U.$("#sFerr", el).innerHTML = html;

    U.$$("[data-pagar]", el).forEach((b) => b.addEventListener("click", () => pagar(p.id, b.dataset.pagar)));
    U.$$("[data-repetir]", el).forEach((b) => b.addEventListener("click", () => {
      const r = E().processarWebhook(p.id, pg.id, pg.metodo);
      FP.ui.toast(r.resultado === "duplicado" ? "Aviso repetido ignorado: o pedido não foi pago duas vezes." : "Resultado: " + r.resultado, "ok");
    }));
    U.$$("[data-tempo]", el).forEach((b) => b.addEventListener("click", () => {
      const min = Number(b.dataset.tempo);
      if (min) E().avancarRelogio(min * R.MINUTO); else E().zerarRelogio();
    }));
  }

  function pagar(id, metodo) {
    const r = E().processarWebhook(id, "mp-" + Math.random().toString(36).slice(2, 10), metodo);
    if (r.resultado === "tardio") FP.ui.toast("Pagamento chegou depois do cancelamento. O operador vai ver o alerta.", "erro");
  }

  function checkout(id) {
    FP.ui.abrirModal({
      render() {
        const p = E().pedido(id);
        if (!p) { FP.ui.fecharModal(); return; }
        const r = p.link ? p.link.expiraEm - E().agora() : 0;
        const aberto = p.status === "nao_pago" && r > 0;
        FP.ui.preencherModal("Checkout Mercado Pago <span class=\"chip\">simulação</span>", esc(p.numero) + " · Natural Sabor",
          '<div class="checkout"><div class="valor">' + U.dinheiro(p.totalCent) + "</div>" +
          (aberto ? '<p>Link válido por mais <b class="cont-checkout">' + U.contagem(r) + "</b></p>"
            : '<p class="erro">' + (p.status === "nao_pago" ? "Link expirado." : "Este link não aceita mais pagamento (" + R.ETAPAS[p.status].rotulo + ").") + "</p>") +
          "</div>",
          aberto ? '<button class="btn btn-mp" data-m="Pix">Pagar com Pix</button><button class="btn btn-mp" data-m="Cartão">Pagar com cartão</button>' : "");
        U.$$("#modalAcoes [data-m]").forEach((b) => b.addEventListener("click", () => { pagar(id, b.dataset.m); FP.ui.fecharModal(); }));
      },
      aCadaSegundo() {
        const p = E().pedido(id);
        const el = U.$(".cont-checkout");
        if (p && el && p.link) el.textContent = U.contagem(p.link.expiraEm - E().agora());
      },
    });
  }

  function render(el) {
    if (!el.dataset.montado) montar(el);
    if (!selecionado || !E().chat(selecionado)) {
      const primeiro = chatsOrdenados()[0];
      selecionado = primeiro ? primeiro.telefone : null;
    }
    desenharLista(el);
    desenharConversa(el);
    desenharFerramentas(el);
  }

  FP.telaSimulador = { selecionar: (tel) => { selecionado = tel; } };
  FP.ui.registrarTela("simulador", {
    titulo: "Simulador do WhatsApp",
    render,
  });
})(window.FP = window.FP || {});
