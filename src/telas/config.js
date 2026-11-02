/* Tela Configurações: o dono ajusta frete, prazos e cidades sem programador. */
(function (FP) {
  "use strict";
  const R = FP.regras;
  const U = FP.util;
  const E = () => FP.estado;
  const esc = U.esc;
  let kmTeste = 9;


  function campo(id, rotulo, valor, dica, extra) {
    return '<label class="campo"><span>' + rotulo + '</span><input id="' + id + '" value="' + esc(valor) + '" ' + (extra || 'inputmode="decimal"') + ">" +
      (dica ? "<small>" + dica + "</small>" : "") + "</label>";
  }

  function simulacao(cfg) {
    let f;
    try { f = R.calcularFrete(kmTeste, cfg); } catch (erro) { return '<p class="erro">Valores inválidos.</p>'; }
    const exemplos = [["Tambiá (JP)", 2.5], ["Manaíra (JP)", 9], ["Mangabeira (JP)", 12], ["Centro (Bayeux)", 10], ["Intermares (Cabedelo)", 16], ["Centro (Cabedelo)", 23]];
    return '<div class="sim-frete"><label>Distância de rota: <b id="kmRot">' + String(kmTeste).replace(".", ",") + ' km</b>' +
      '<input type="range" id="kmTeste" min="0" max="30" step="0.5" value="' + kmTeste + '"></label>' +
      '<div class="formula">max(' + U.dinheiro(cfg.freteMinimoCent) + " ; " + U.dinheiro(cfg.tarifaBaseCent) + " + " + U.dinheiro(cfg.valorPorKmCent) +
      " × " + String(f.km).replace(".", ",") + " km) × " + String(cfg.multiplicador).replace(".", ",") + " = <b>" + U.dinheiro(f.totalCent) + "</b></div>" +
      '<table class="mini"><thead><tr><th>Exemplo</th><th class="num">km</th><th class="num">Frete</th></tr></thead><tbody>' +
      exemplos.map(([n, km]) => "<tr><td>" + n + '</td><td class="num">' + String(km).replace(".", ",") + '</td><td class="num">' +
        U.dinheiro(R.calcularFrete(km, cfg).totalCent) + "</td></tr>").join("") + "</tbody></table>" +
      '<p class="mudo">Km de exemplo. No sistema real a distância vem da API de rotas (de carro), não em linha reta.</p></div>';
  }

  function lerFormulario(el) {
    return {
      freteMinimoCent: R.centavosDeTexto(U.$("#cMin", el).value),
      tarifaBaseCent: R.centavosDeTexto(U.$("#cBase", el).value),
      valorPorKmCent: R.centavosDeTexto(U.$("#cKm", el).value),
      multiplicador: Number(String(U.$("#cMult", el).value).replace(",", ".")),
      janelaPagamentoMin: Number(U.$("#cJanela", el).value),
      abandonoHoras: Number(U.$("#cAbandono", el).value),
      cidadesAtivas: U.$$("[data-cidade]", el).filter((i) => i.checked).map((i) => i.dataset.cidade),
    };
  }

  function render(el) {
    const cfg = E().config();
    const hoje = R.isoLocal(E().agora());
    const feriados = Object.entries(R.listaFeriados()).filter(([d]) => d >= hoje).slice(0, 6);
    el.innerHTML =
      '<div class="config-grade">' +
      '<section class="painel"><h2>Frete</h2><p class="mudo">Fórmula tipo Uber Envios: <b>max(mínimo ; base + valor por km × km) × multiplicador</b>. Frete nunca é grátis.</p>' +
      '<div class="campos">' +
      campo("cMin", "Frete mínimo", U.dinheiro(cfg.freteMinimoCent)) +
      campo("cBase", "Tarifa base", U.dinheiro(cfg.tarifaBaseCent)) +
      campo("cKm", "Valor por km", U.dinheiro(cfg.valorPorKmCent)) +
      campo("cMult", "Multiplicador", String(cfg.multiplicador).replace(".", ","), "1,10 = Uber + 10% (decisão de 29/10)") +
      "</div><div id=\"simFrete\">" + simulacao(cfg) + "</div></section>" +

      '<section class="painel"><h2>Prazos</h2><div class="campos">' +
      campo("cJanela", "Validade do link de pagamento (min)", cfg.janelaPagamentoMin, "Decidido: 15 min. Passou disso, cancela e avisa o cliente.", 'type="number" min="5" max="60"') +
      campo("cAbandono", "Conversa parada vira abandonada (h)", cfg.abandonoHoras, "Proposta: 24 h.", 'type="number" min="1" max="72"') +
      "</div><h2>Cidades atendidas</h2><p class=\"mudo\">Só estas três no MVP. Dá para pausar uma, mas não incluir outra.</p>" +
      '<div class="cidades">' + R.CIDADES_COBERTAS.map((c) => '<label><input type="checkbox" data-cidade="' + c + '"' +
        (cfg.cidadesAtivas.includes(c) ? " checked" : "") + "> " + c + "</label>").join("") + "</div>" +
      '<div class="acoes-form"><button class="btn btn-primario" id="cSalvar">Salvar configurações</button>' +
      '<span class="mudo">Vale para pedidos novos. Pedido com link já gerado mantém o frete congelado.</span></div><div id="cErros"></div></section>' +

      '<section class="painel"><h2>Regras fixas do MVP</h2><ul class="regras">' +
      "<li>Pedido acima de <b>" + R.LIMITE_PESO_KG + " kg</b> não gera link: é combinado direto pelo WhatsApp.</li>" +
      "<li>Entrega <b>hoje</b> ou agendada em até <b>" + R.PRAZO_AGENDAMENTO_DIAS + " dias</b>, sempre em <b>dia útil</b>. Não há retirada.</li>" +
      "<li>Agendado: paga na hora e o frete é calculado e cobrado no pedido.</li>" +
      "<li>Pagamento só pelo Mercado Pago (Pix e cartão). O operador não marca pago na mão.</li>" +
      "<li>Pagou depois do cancelamento: pedido continua cancelado, o cliente é avisado e o operador confere o caso.</li>" +
      "<li>Bot 24 h por dia. Entrega por entregador próprio.</li></ul>" +
      '<h3>Próximos feriados (não entregamos)</h3><ul class="regras">' +
      feriados.map(([d, n]) => "<li>" + R.dataBr(d) + " · " + esc(n) + "</li>").join("") + "</ul>" +
      '<p class="mudo">Lista de feriados a confirmar com o dono (municipais de João Pessoa, Cabedelo e Bayeux ainda não entraram).</p></section>' +
      "</div>";
    ligar(el);
  }

  function ligar(el) {
    const atualizarSim = () => {
      const cfg = Object.assign({}, E().config(), lerFormulario(el));
      U.$("#simFrete", el).innerHTML = simulacao(cfg);
      ligarRange();
    };
    const ligarRange = () => {
      const r = U.$("#kmTeste", el);
      if (r) r.addEventListener("input", () => { kmTeste = Number(r.value); atualizarSim(); });
    };
    ligarRange();
    ["#cMin", "#cBase", "#cKm", "#cMult"].forEach((s) => U.$(s, el).addEventListener("input", atualizarSim));
    U.$("#cSalvar", el).addEventListener("click", () => {
      const r = E().salvarConfig(lerFormulario(el));
      if (r.ok) FP.ui.toast("Configurações salvas.", "ok");
      else U.$("#cErros", el).innerHTML = '<ul class="erro">' + r.erros.map((x) => "<li>" + esc(x) + "</li>").join("") + "</ul>";
    });
  }

  FP.ui.registrarTela("config", {
    titulo: "Configurações",
    render,
  });
})(window.FP = window.FP || {});
