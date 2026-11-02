/* Tela Relatórios: um relatório por status, filtro por período, soma no rodapé e CSV. */
(function (FP) {
  "use strict";
  const R = FP.regras;
  const U = FP.util;
  const E = () => FP.estado;
  const esc = U.esc;

  const ABAS = ["todos", "conversa", "nao_pago", "pago", "entrega", "concluido", "cancelado", "abandonada"];
  const PAGOS = ["pago", "entrega", "concluido"];
  const f = { aba: "todos", de: null, ate: null };

  function periodo() {
    const hoje = R.isoLocal(E().agora());
    return { de: f.de || R.somarDias(hoje, -7), ate: f.ate || hoje };
  }

  function noPeriodo() {
    const { de, ate } = periodo();
    const ini = new Date(de + "T00:00:00").getTime();
    const fim = new Date(ate + "T23:59:59.999").getTime();
    return E().pedidos().filter((p) => p.criadoEm >= ini && p.criadoEm <= fim);
  }

  function indicadores(lista) {
    const pagos = lista.filter((p) => PAGOS.includes(p.status));
    const recebido = pagos.reduce((s, p) => s + p.totalCent, 0);
    const expirados = lista.filter((p) => p.status === "cancelado" && /expirou/i.test(p.motivo)).length;
    const conv = lista.length ? Math.round((pagos.length / lista.length) * 100) : 0;
    const bloco = (rot, val, dica) => '<div class="kpi"><span>' + rot + "</span><b>" + val + "</b>" + (dica ? "<small>" + dica + "</small>" : "") + "</div>";
    return '<div class="kpis">' +
      bloco("Conversas no período", lista.length) +
      bloco("Viraram pedido pago", pagos.length, conv + "% das conversas") +
      bloco("Recebido", U.dinheiro(recebido), "pago + em entrega + concluído") +
      bloco("Ticket médio", U.dinheiro(pagos.length ? Math.round(recebido / pagos.length) : 0)) +
      bloco("Cancelados por prazo do link", expirados) +
      bloco("Abandonadas", lista.filter((p) => p.status === "abandonada").length) +
      "</div>";
  }

  /* Na aba "Todos" o rodapé soma só o que entrou de dinheiro (pago, em entrega, concluído);
     somar conversa e cancelado junto daria um faturamento que não existe. */
  function rodape(lista) {
    const base = f.aba === "todos" ? lista.filter((p) => PAGOS.includes(p.status)) : lista;
    const soma = (k) => base.reduce((s, p) => s + p[k], 0);
    const rotulo = f.aba === "todos"
      ? "Recebido · " + base.length + " de " + lista.length + " pedido(s)"
      : lista.length + " pedido(s)";
    return '<tfoot><tr><td colspan="5">' + rotulo + "</td>" +
      '<td class="num">' + U.dinheiro(soma("subtotalCent")) + '</td><td class="num">' + U.dinheiro(soma("freteCent")) +
      '</td><td class="num">' + U.dinheiro(soma("totalCent")) + '</td><td colspan="2"></td></tr></tfoot>';
  }

  function tabela(lista) {
    const linhas = lista.slice().sort((a, b) => b.criadoEm - a.criadoEm).map((p) => {
      const pg = p.pagamentos.find((x) => !x.tardio);
      return '<tr data-id="' + esc(p.id) + '" tabindex="0"><td>' + esc(p.numero) + "</td><td>" + U.dataHora(p.criadoEm) + "</td><td>" + esc(p.cliente) +
        "</td><td>" + esc(p.endereco ? p.endereco.cidade : "-") + '</td><td class="num">' + U.kg(R.pesoTotalG(p.itens)) +
        '</td><td class="num">' + U.dinheiro(p.subtotalCent) + '</td><td class="num">' + U.dinheiro(p.freteCent) +
        '</td><td class="num"><b>' + U.dinheiro(p.totalCent) + "</b></td><td>" + esc(pg ? pg.metodo : "-") +
        '</td><td><span class="chip etapa-' + p.status + '">' + R.ETAPAS[p.status].rotulo + "</span></td></tr>";
    }).join("");
    return '<div class="tabela-rolagem"><table class="relatorio"><thead><tr><th>Nº</th><th>Criado em</th><th>Cliente</th><th>Cidade</th>' +
      '<th class="num">Peso</th><th class="num">Itens</th><th class="num">Frete</th><th class="num">Total</th><th>Pagamento</th><th>Status</th></tr></thead>' +
      "<tbody>" + (linhas || '<tr><td colspan="10" class="vazio">Nenhum pedido nesse período.</td></tr>') + "</tbody>" +
      rodape(lista) + "</table></div>";
  }

  function csv(lista) {
    /* Células que começam com = + - @ viram fórmula no Excel: prefixa ' para neutralizar. */
    const cel = (v) => '"' + String(v).replace(/^[=+\-@]/, "'$&").replace(/"/g, '""') + '"';
    const reais = (c) => (c / 100).toFixed(2).replace(".", ",");
    const cab = ["Numero", "Criado em", "Cliente", "Telefone", "Cidade", "Bairro", "Itens", "Peso kg", "Subtotal", "Frete", "Total", "Pagamento", "Status", "Motivo"];
    const linhas = lista.map((p) => [
      p.numero, U.dataHora(p.criadoEm), p.cliente, p.telefone, p.endereco ? p.endereco.cidade : "", p.endereco ? p.endereco.bairro : "",
      p.itens.map((i) => i.qtd + "x " + i.nome + " " + i.rotulo).join(" | "),
      (R.pesoTotalG(p.itens) / 1000).toFixed(2).replace(".", ","), reais(p.subtotalCent), reais(p.freteCent), reais(p.totalCent),
      (p.pagamentos[0] || {}).metodo || "", R.ETAPAS[p.status].rotulo, p.motivo || "",
    ].map(cel).join(";"));
    const tot = lista.reduce((s, p) => s + p.totalCent, 0);
    linhas.push(["", "", "", "", "", "", "", "", "", "TOTAL", reais(tot), "", "", ""].map(cel).join(";"));
    return "\uFEFF" + cab.map(cel).join(";") + "\r\n" + linhas.join("\r\n");
  }

  function baixar(nome, conteudo) {
    const url = URL.createObjectURL(new Blob([conteudo], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = nome;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function render(el) {
    const todos = noPeriodo();
    const lista = f.aba === "todos" ? todos : todos.filter((p) => p.status === f.aba);
    const { de, ate } = periodo();
    el.innerHTML =
      '<div class="filtros"><label>De <input type="date" id="rDe" value="' + de + '"></label>' +
      '<label>Até <input type="date" id="rAte" value="' + ate + '"></label>' +
      '<button class="btn btn-primario" id="rCsv">Exportar CSV</button></div>' +
      indicadores(todos) +
      '<div class="abas" role="tablist">' + ABAS.map((a) => {
        const n = a === "todos" ? todos.length : todos.filter((p) => p.status === a).length;
        return '<button role="tab" aria-selected="' + (a === f.aba) + '" data-aba="' + a + '" class="' + (a === f.aba ? "ativa" : "") + '">' +
          (a === "todos" ? "Todos" : R.ETAPAS[a].rotulo) + " <span>" + n + "</span></button>";
      }).join("") + "</div>" +
      tabela(lista);

    U.$("#rDe", el).addEventListener("change", (e) => { f.de = e.target.value || null; render(el); });
    U.$("#rAte", el).addEventListener("change", (e) => { f.ate = e.target.value || null; render(el); });
    U.$$("[data-aba]", el).forEach((b) => b.addEventListener("click", () => { f.aba = b.dataset.aba; render(el); }));
    U.$$("tbody tr[data-id]", el).forEach((tr) => {
      tr.addEventListener("click", () => FP.telaPedidos.abrirPedido(tr.dataset.id));
      tr.addEventListener("keydown", (e) => { if (e.key === "Enter") FP.telaPedidos.abrirPedido(tr.dataset.id); });
    });
    U.$("#rCsv", el).addEventListener("click", () => {
      baixar("pedidos_" + f.aba + "_" + de + "_a_" + ate + ".csv", csv(lista));
      FP.ui.toast("CSV exportado (" + lista.length + " pedidos).", "ok");
    });
  }

  FP.ui.registrarTela("relatorios", {
    titulo: "Relatórios",
    render,
  });
})(window.FP = window.FP || {});
