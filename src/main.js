/* Inicialização: login, menu lateral, relógio, prazos automáticos e alertas em tempo real. */
(function (FP) {
  "use strict";
  const U = FP.util;
  const R = FP.regras;
  const E = FP.estado;

  /* Quais eventos redesenham cada tela (evita apagar formulário em edição). */
  const EVENTOS = { config: ["config", "reset"], produtos: ["catalogo", "reset"], mvp: [] };
  let anterior = new Map();

  function fotografar() {
    return new Map(E.pedidos().map((p) => [p.id, { status: p.status, alerta: p.alertaTardio }]));
  }

  /* Compara antes/depois. Funciona para mudanças desta aba e de outras abas. */
  function avisarMudancas() {
    const agora = fotografar();
    let pagou = false;
    E.pedidos().forEach((p) => {
      const antes = anterior.get(p.id);
      if (!antes) {
        if (anterior.size) FP.ui.toast("Nova conversa no WhatsApp: " + p.cliente + " (" + p.numero + ")");
        return;
      }
      if (antes.status !== p.status) {
        if (p.status === "pago") {
          pagou = true;
          FP.ui.toast("💰 Pagamento recebido: " + p.numero + " · " + U.dinheiro(p.totalCent), "ok");
        } else if (p.status === "nao_pago") {
          FP.ui.toast(p.numero + ": link de pagamento enviado ao cliente.");
        } else if (p.status === "cancelado") {
          FP.ui.toast(p.numero + " cancelado: " + (p.motivo || "sem motivo"), "erro");
        } else if (p.status === "abandonada") {
          FP.ui.toast(p.numero + ": conversa abandonada (" + E.config().abandonoHoras + " h parada).");
        }
      }
      if (!antes.alerta && p.alertaTardio) FP.ui.toast("⚠️ " + p.numero + ": pagamento depois do cancelamento. Conferir com o cliente.", "erro");
    });
    anterior = agora;
    if (pagou) {
      FP.ui.beep();
      setTimeout(() => {
        const col = U.$(".coluna[data-status=pago]");
        if (col) { col.classList.remove("piscar"); void col.offsetWidth; col.classList.add("piscar"); }
      }, 30);
    }
    atualizarMenu();
  }

  function atualizarMenu() {
    const hoje = R.isoLocal(E.agora());
    const paraEnviar = E.pedidos().filter((p) => p.status === "pago" && p.entrega && p.entrega.data <= hoje).length;
    const tardios = E.pedidos().filter((p) => p.alertaTardio).length;
    const b = U.$("#badgePedidos");
    b.textContent = paraEnviar ? String(paraEnviar) : "";
    b.title = paraEnviar + " pedido(s) pago(s) para entregar hoje";
    U.$("#badgeAlerta").classList.toggle("oculto", !tardios);
  }

  function relogio() {
    const t = E.agora();
    U.$("#relogio").textContent = new Date(t).toLocaleString("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const off = E.offset();
    const tag = U.$("#relogioSim");
    tag.classList.toggle("oculto", !off);
    tag.textContent = off ? "relógio simulado +" + U.duracao(off) : "";
  }

  function mostrarApp(sessao) {
    U.$("#tela-login").classList.add("oculto");
    U.$("#app").classList.remove("oculto");
    U.$("#operador").textContent = sessao.nome + " · " + sessao.email;
    const destino = (location.hash || "").slice(1);
    FP.ui.irPara(destino || "pedidos");
  }

  function mostrarLogin() {
    U.$("#app").classList.add("oculto");
    U.$("#tela-login").classList.remove("oculto");
    U.$("#lEmail").focus();
  }

  async function abrirPainel(sessao) {
    await E.carregar();
    E.assinar();
    anterior = fotografar();
    atualizarMenu();
    mostrarApp(sessao);
  }

  async function iniciar() {
    anterior = fotografar();

    E.on((ev) => {
      if (ev.tipo === "erro") { FP.ui.toast("Não consegui salvar no banco: " + ev.motivo, "erro"); return; }
      if (ev.tipo === "deslogado") { mostrarLogin(); return; }
      const tela = FP.ui.telaAtual();
      const filtro = EVENTOS[tela];
      if (!filtro || filtro.includes(ev.tipo)) FP.ui.redesenhar();
      else if (FP.ui.modalAberto()) FP.ui.modalAberto().render();
      avisarMudancas();
    });

    U.$("#formLogin").addEventListener("submit", async (e) => {
      e.preventDefault();
      const botao = U.$("#formLogin button");
      botao.disabled = true;
      U.$("#lErro").textContent = "";
      try {
        const r = await E.entrar(U.$("#lEmail").value, U.$("#lSenha").value);
        if (!r.ok) { U.$("#lErro").textContent = r.motivo; return; }
        U.$("#lSenha").value = "";
        await abrirPainel(r.sessao);
      } catch (erro) {
        console.error(erro);
        U.$("#lErro").textContent = "Não consegui carregar os dados: " + erro.message;
      } finally {
        botao.disabled = false;
      }
    });
    U.$("#btnSair").addEventListener("click", async () => { await E.sair(); mostrarLogin(); });
    U.$$(".menu-item").forEach((b) => b.addEventListener("click", () => {
      FP.ui.irPara(b.dataset.tela);
      document.body.classList.remove("menu-aberto");
    }));
    U.$("#btnMenu").addEventListener("click", () => document.body.classList.toggle("menu-aberto"));
    U.$("#modalFechar").addEventListener("click", FP.ui.fecharModal);
    U.$("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") FP.ui.fecharModal(); });
    window.addEventListener("hashchange", () => {
      const alvo = location.hash.slice(1);
      if (alvo && alvo !== FP.ui.telaAtual() && E.sessao()) FP.ui.irPara(alvo);
    });

    let segundos = 0;
    setInterval(() => {
      E.tick();
      relogio();
      FP.ui.aCadaSegundo();
      segundos += 1;
      if (segundos % 30 === 0 && FP.ui.telaAtual() === "pedidos" && !U.$(".arrastando") && !FP.ui.modalAberto()) FP.ui.redesenhar();
    }, 1000);

    relogio();
    atualizarMenu();
    try {
      await E.restaurarSessao();
      const sessao = E.sessao();
      if (sessao) await abrirPainel(sessao); else mostrarLogin();
    } catch (erro) {
      console.error(erro);
      mostrarLogin();
      U.$("#lErro").textContent = "Não consegui conectar ao banco: " + erro.message;
    }
  }

  document.addEventListener("DOMContentLoaded", iniciar);
})(window.FP = window.FP || {});

