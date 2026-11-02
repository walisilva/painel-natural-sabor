/* Utilitários de tela: formatação, escape de HTML e seletores. */
(function (FP) {
  "use strict";

  const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

  /* Escapa texto antes de ir para innerHTML (nome do cliente vem do WhatsApp). */
  function esc(valor) {
    return String(valor === undefined || valor === null ? "" : valor).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[c]);
  }

  function duracao(ms) {
    const min = Math.max(0, Math.floor(ms / 60000));
    if (min < 60) return min + " min";
    const h = Math.floor(min / 60);
    if (h < 48) return h + " h" + (min % 60 ? " " + (min % 60) + " min" : "");
    return Math.floor(h / 24) + " dias";
  }

  function contagem(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }

  /* Telefone no padrão do WhatsApp: só dígitos com DDI 55 (link) e "+55 83 99999-1234" (exibição/cópia). */
  function digitosWhats(t) {
    const d = String(t || "").replace(/\D/g, "");
    return d.startsWith("55") && d.length >= 12 ? d : "55" + d;
  }

  function telefoneWhats(t) {
    const d = digitosWhats(t);
    const ddd = d.slice(2, 4);
    const num = d.slice(4);
    return "+55 " + ddd + " " + num.slice(0, num.length - 4) + "-" + num.slice(-4);
  }

  /* Copia texto. Clipboard API em https/localhost; fallback para IP da rede. */
  function copiar(texto) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(texto).then(() => true, () => copiarAntigo(texto));
    }
    return Promise.resolve(copiarAntigo(texto));
  }

  function copiarAntigo(texto) {
    const area = document.createElement("textarea");
    area.value = texto;
    area.setAttribute("readonly", "");
    area.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch (erro) { ok = false; }
    area.remove();
    return ok;
  }

  FP.util = {
    $: (sel, raiz) => (raiz || document).querySelector(sel),
    $$: (sel, raiz) => Array.from((raiz || document).querySelectorAll(sel)),
    esc,
    dinheiro: (cent) => BRL.format((cent || 0) / 100),
    hhmm: (ts) => new Date(ts).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }),
    dataHora: (ts) => new Date(ts).toLocaleString("pt-BR", {
      day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit",
    }),
    dataCurta: (iso) => FP.regras.dataBr(iso).slice(0, 5),
    diaSemana: (iso) => new Date(iso + "T12:00:00").toLocaleDateString("pt-BR", { weekday: "short" }).replace(".", ""),
    kg: (g) => (g / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 2 }) + " kg",
    telefoneBr: (t) => {
      const d = String(t).replace(/\D/g, "").replace(/^55/, "");
      return d.length === 11 ? "(" + d.slice(0, 2) + ") " + d.slice(2, 7) + "-" + d.slice(7) : t;
    },
    telefoneWhats,
    linkWhats: (t) => "https://wa.me/" + digitosWhats(t),
    copiar,
    duracao,
    contagem,
  };
})(window.FP = window.FP || {});
